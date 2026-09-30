import {
  Cart,
  CommercetoolsCartService,
  CommercetoolsOrderService,
  CommercetoolsPaymentService,
  ErrorGeneral,
  healthCheckCommercetoolsPermissions,
  statusHandler,
} from '@commercetools/connect-payments-sdk';
import { randomUUID } from 'crypto';
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  PaymentProviderModificationResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
  StatusResponse,
} from './types/operation.type';
import { AmountSchemaDTO } from '../dtos/operations/payment-intents.dto';
import {
  BalanceResponseSchemaDTO,
  FinalizeRequestDTO,
  FinalizeResponseDTO,
  RedeemRequestDTO,
  RedeemResponseDTO,
  ReleaseRequestDTO,
  ReleaseResponseDTO,
} from '../dtos/loyalty-redemption.dto';
import { getConfig } from '../config/config';
import { appLogger, paymentSDK } from '../payment-sdk';
import { AbstractGiftCardService } from './abstract-giftcard.service';
import { LoyaltyAPI } from '../clients/loyalty.client';
import { LoyaltyHoldResponse } from '../clients/types/loyalty.client.type';
import { LoyaltyApiError } from '../errors/loyalty-api.error';
import { getCartIdFromContext, getCtSessionIdFromContext } from '../libs/fastify/context/context';
import { MockCustomError } from '../errors/mock-api.error';
import { BalanceConverter } from './converters/balance-converter';
import { CartRedemptionFieldsClient } from '../clients/cart-redemption-fields.client';
import { CustomerEmailClient } from '../clients/customer-email.client';
import { SessionExpiryClient } from '../clients/session-expiry.client';
import { decompose, sumDenominations } from './denominations';
import packageJSON from '../../package.json';
import { log } from '../libs/logger';

export type LoyaltyRedemptionServiceOptions = {
  ctCartService: CommercetoolsCartService;
  ctPaymentService: CommercetoolsPaymentService;
  ctOrderService: CommercetoolsOrderService;
  cartFields: CartRedemptionFieldsClient;
  customers: CustomerEmailClient;
  sessions: SessionExpiryClient;
};

/**
 * Spends loyalty points as a cart discount. A redemption is a hold in the loyalty backend (which debits
 * the points at once) plus two custom fields on the cart - the redemption id and the discount
 * denominations - that make commercetools apply the matching automatic CartDiscounts. No Payment is
 * created: the card leg covers whatever the discounted cart still asks for.
 *
 * Order matters in redeem(): hold first, cart second. A hold whose cart write failed costs the customer
 * their points until the void here (or the backend's sweep) gives them back - recoverable. A cart
 * discount with no hold behind it is goods sold for points nobody debited - not recoverable, and what
 * the backend's coverage audit exists to catch.
 */
export class LoyaltyRedemptionService extends AbstractGiftCardService {
  private readonly cartFields: CartRedemptionFieldsClient;
  private readonly customers: CustomerEmailClient;
  private readonly sessions: SessionExpiryClient;
  private readonly balanceConverter = new BalanceConverter();

  constructor(opts: LoyaltyRedemptionServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService, opts.ctOrderService);
    this.cartFields = opts.cartFields;
    this.customers = opts.customers;
    this.sessions = opts.sessions;
  }

  async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          // manage_orders covers the cart updates, view_customers the points owner's account; the
          // payment-intents route keeps its own scopes.
          requiredPermissions: [
            'manage_orders',
            'view_customers',
            'view_sessions',
            'view_api_clients',
            'introspect_oauth_tokens',
            'manage_checkout_payment_intents',
          ],
          ctAuthorizationService: paymentSDK.ctAuthorizationService,
          projectKey: getConfig().projectKey,
        }),
        // The loyalty backend exposes no health endpoint yet, so this only asserts that the
        // connector knows where to reach it. Upgrade to a real probe once one exists.
        async () => {
          const loyaltyApiUrl = getConfig().loyaltyApiUrl;
          if (!loyaltyApiUrl) {
            return {
              name: 'Loyalty API configuration',
              status: 'DOWN',
              message: 'LOYALTY_API_URL is not configured, the connector cannot reach the points ledger',
              details: {},
            };
          }
          return {
            name: 'Loyalty API configuration',
            status: 'UP',
            details: { loyaltyApiUrl, authenticated: Boolean(getConfig().loyaltyApiKey) },
          };
        },
      ],
      metadataFn: async () => ({ name: packageJSON.name, description: packageJSON.description }),
    })();
    return handler.body;
  }

  /**
   * The `code` field is ignored: the loyalty account is the cart customer and the currency is the
   * cart's. The cap is measured against the cart's UNDISCOUNTED total, adding back the redemption the
   * cart may already carry, so a shopper changing their mind sees the full range again.
   */
  async balance(_code: string): Promise<BalanceResponseSchemaDTO> {
    const cart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const userId = await this.getLoyaltyUserId(cart);
    const carried = this.cartFields.read(cart);
    const stillOwed = await this.ctCartService.getPaymentAmount({ cart });
    const undiscounted = stillOwed.centAmount + sumDenominations(carried.denominations);
    try {
      const result = await LoyaltyAPI().balance({
        userId,
        currencyCode: stillOwed.currencyCode,
        cartId: cart.id,
        cartTotal: undiscounted,
        sessionExpiresAt: await this.currentSessionExpiry(),
      });
      if (!result.cap) {
        // We named a cart, so the backend owes a cap. Reporting 0 instead would be indistinguishable
        // from a shopper with nothing left to redeem.
        throw new MockCustomError({
          message: 'the loyalty service did not quote a cap for this cart',
          code: 500,
          key: 'GenericError',
        });
      }
      return this.balanceConverter.convert(result, carried.redemptionId, result.cap);
    } catch (e) {
      throw this.toConnectorError(e);
    }
  }

  async redeem(opts: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO> {
    const amount = opts.data.redeemAmount;
    const denominations = this.decomposeOrRefuse(amount);
    let cart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const userId = await this.getLoyaltyUserId(cart);

    // A previous redeem on this cart is replaced, never stacked: the backend allows one open hold per
    // cart, and the field can only hold one redemption anyway. The backend releases it (discount off
    // the cart first, points back only then; a lock aborts before anything moved), and the cart is
    // read again so the floor below is measured undiscounted.
    const carried = this.cartFields.read(cart);
    if (carried.redemptionId) {
      await this.releaseOrAbort(carried.redemptionId);
      cart = await this.ctCartService.getCart({ id: cart.id });
    }

    const stillOwed = await this.ctCartService.getPaymentAmount({ cart });
    const redemptionId = randomUUID();
    let hold: LoyaltyHoldResponse;
    try {
      hold = await LoyaltyAPI().hold({
        userId,
        redemptionId,
        cartId: cart.id,
        amount,
        cartTotal: { centAmount: stillOwed.centAmount, currencyCode: stillOwed.currencyCode },
        sessionExpiresAt: await this.currentSessionExpiry(),
      });
    } catch (e) {
      // Nothing is on the cart yet, so an uncertain hold (timeout, 5xx) leaves at worst a hold the
      // backend's sweep releases at TTL - never a discount without a hold.
      throw this.toConnectorError(e);
    }

    let baseline: Cart;
    let updated: Cart;
    try {
      ({ baseline, updated } = await this.cartFields.write(cart, { redemptionId, denominations }));
    } catch (e) {
      // The write may have reached commercetools before the failure surfaced, so only the backend's
      // clear-first release is safe here.
      await this.releaseQuietly(redemptionId, 'writeFailed');
      throw e;
    }

    // Measured against the cart the write was really applied to: a version-conflict retry re-reads
    // the cart, and a concurrent line change must not masquerade as a discount that did not apply.
    const applied = grossTotal(baseline) - grossTotal(updated);
    if (applied !== amount.centAmount) {
      // A stopping promotion above the loyalty discounts, a currency the denominations are not
      // provisioned in, or a cart too small for the amount: commercetools did not do what the hold
      // assumed, so undo both sides rather than leave points spent against a partial discount.
      await this.releaseQuietly(redemptionId, 'discountNotApplied');
      throw new MockCustomError({
        message: `commercetools applied ${applied} of the requested ${amount.centAmount} ${amount.currencyCode}`,
        code: 409,
        key: 'DiscountNotApplied',
      });
    }

    return {
      result: 'Success',
      redemptionId,
      points: hold.points,
      appliedAmount: { centAmount: applied, currencyCode: amount.currencyCode },
    };
  }

  /**
   * The storefront's "remove points". The session proves the caller owns THIS cart and nothing else,
   * so a redemption id the cart does not carry is refused before the ledger is touched - releasing it
   * would strip someone else's checkout of the hold behind its discount. The backend then takes the
   * discount off and gives the points back (a lock conflict refuses before anything moved).
   */
  async release(opts: { data: ReleaseRequestDTO }): Promise<ReleaseResponseDTO> {
    const cart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    if (this.cartFields.read(cart).redemptionId !== opts.data.redemptionId) {
      throw new MockCustomError({
        message: 'this cart does not carry the given redemption',
        code: 404,
        key: 'RedemptionNotOnCart',
      });
    }
    try {
      await this.releaseOrAbort(opts.data.redemptionId);
    } catch (e) {
      if (!(e instanceof LoyaltyApiError && e.status === 404)) {
        throw e;
      }
      // The backend holds nothing for this discount, so there are no points to give back: taking the
      // discount off is all that is left, and it cannot hand anything away.
      await this.cartFields.clear(cart, opts.data.redemptionId);
    }
    return { result: 'Success' };
  }

  /**
   * Called by the storefront right before it submits the checkout's final payment, so a second tab
   * cannot void-and-recreate this reservation while a card leg elsewhere may already have read its
   * amount (see the loyalty backend's RedemptionHoldService#lockForFinalization). A 409 means a
   * genuine competing finalize attempt is in flight and must fail the checkout; anything else is
   * logged and swallowed - the reservation itself still stands or has already resolved on its own.
   */
  async finalize(opts: { data: FinalizeRequestDTO }): Promise<FinalizeResponseDTO> {
    try {
      await LoyaltyAPI().lock({ redemptionId: opts.data.redemptionId });
    } catch (e) {
      if (e instanceof LoyaltyApiError && e.status === 409) {
        throw new MockCustomError({
          message: 'this reservation is already being finalized elsewhere',
          code: 409,
          key: 'FinalizationInProgress',
        });
      }
      log.error('Could not lock the loyalty reservation for final submission; proceeding without it.', {
        redemptionId: opts.data.redemptionId,
        action: 'finalize',
        error: e instanceof LoyaltyApiError ? e.message : String(e),
      });
    }
    return { result: 'Success' };
  }

  // No Payment exists in this integration, so commercetools has nothing to route here. A call arriving
  // anyway means something is wired up that should not be; it stays an alarm rather than a silent no-op.
  async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw this.unsupported('capture', request.payment?.id);
  }

  async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw this.unsupported('cancel', request.payment?.id);
  }

  async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw this.unsupported('refund', request.payment?.id);
  }

  async reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw this.unsupported('reverse', request.payment?.id);
  }

  private unsupported(operation: string, paymentId: string | undefined): Error {
    return new ErrorGeneral('operation not supported', {
      fields: { pspReference: paymentId },
      privateMessage: `this connector creates no Payment, so ${operation} has nothing to act on`,
    });
  }

  private decomposeOrRefuse(amount: AmountSchemaDTO): string[] {
    const levels = getConfig().loyaltyDiscountLevelsByCurrency[amount.currencyCode];
    if (!levels) {
      throw new MockCustomError({
        message: `no loyalty denominations are configured for ${amount.currencyCode}`,
        code: 400,
        key: 'CurrencyNotMatch',
      });
    }
    try {
      return decompose(amount.centAmount, levels);
    } catch (e) {
      throw new MockCustomError({
        message: e instanceof Error ? e.message : String(e),
        code: 400,
        key: 'AmountNotDecomposable',
      });
    }
  }

  /** Expiry of the checkout session this request runs under; undefined when unknown (sent as absent). */
  private async currentSessionExpiry(): Promise<string | undefined> {
    let sessionId: string | undefined;
    try {
      sessionId = getCtSessionIdFromContext();
    } catch {
      sessionId = undefined;
    }
    return (await this.sessions.expiryOf(sessionId ?? '')) ?? undefined;
  }

  /**
   * The loyalty userId is the email of the customer account the cart belongs to, lowercased. A guest
   * cart (no customerId) is refused however plausible its email looks: the session only proves the
   * caller owns this cart, and a guest can write any address onto it.
   */
  private async getLoyaltyUserId(cart: Cart): Promise<string> {
    const accountEmail = cart.customerId ? await this.customers.emailOf(cart.customerId) : null;
    const userId = accountEmail?.trim().toLowerCase();
    if (!userId) {
      throw new MockCustomError({
        message: 'the cart belongs to no customer account, loyalty points cannot be identified',
        code: 400,
        key: 'CustomerNotIdentified',
      });
    }
    return userId;
  }

  /**
   * Releases a redemption through the backend and insists that it really went back: a lock refuses
   * with FinalizationInProgress, and an outcome other than VOIDED means an order already carries the
   * discount - the caller must not go on as if the cart were free of it. A backend 404 (no such hold)
   * is rethrown as is, for the caller to decide; any other failure fails the operation, leaving the
   * cart and the hold exactly as they were.
   */
  private async releaseOrAbort(redemptionId: string): Promise<void> {
    let outcome: string;
    try {
      outcome = (await LoyaltyAPI().release({ redemptionId })).outcome;
    } catch (e) {
      if (e instanceof LoyaltyApiError && e.status === 409 && e.body?.lockedUntil) {
        throw new MockCustomError({
          message: 'this reservation is being finalized elsewhere and cannot be changed right now',
          code: 409,
          key: 'FinalizationInProgress',
        });
      }
      if (e instanceof LoyaltyApiError && e.status === 404) {
        throw e;
      }
      throw this.toConnectorError(e);
    }
    if (outcome !== 'VOIDED') {
      throw new MockCustomError({
        message: `the redemption already reached an order (${outcome}), it cannot be released`,
        code: 409,
        key: 'GenericError',
      });
    }
  }

  /**
   * Undoes a hold whose cart write failed or did not apply. Best effort: if the backend cannot release
   * it now, the hold stays open and the backend's sweep releases it (cart first) later - the points are
   * withheld meanwhile, never handed back against a discount.
   */
  private async releaseQuietly(redemptionId: string, action: string): Promise<void> {
    try {
      await LoyaltyAPI().release({ redemptionId });
    } catch (e) {
      log.error('Could not release the loyalty reservation: the backend sweep releases it later.', {
        redemptionId,
        action,
        error: e instanceof LoyaltyApiError ? e.message : String(e),
      });
    }
  }

  /**
   * Maps a loyalty backend failure onto the error taxonomy the storefront understands. Anything that
   * is not a backend rejection is a service failure: the caller must fail the operation rather than
   * assume anything about the ledger.
   */
  private toConnectorError(e: unknown): Error {
    if (!(e instanceof LoyaltyApiError)) {
      return e instanceof Error ? e : new Error(String(e));
    }
    switch (e.status) {
      case 400:
        return new MockCustomError({
          message: 'cart and loyalty currency do not match',
          code: 400,
          key: 'CurrencyNotMatch',
        });
      case 409:
        if (e.body?.existingRedemptionId) {
          return new MockCustomError({
            message: 'the cart already has an open reservation',
            code: 409,
            key: 'CartAlreadyHeld',
          });
        }
        return new MockCustomError({
          message: 'not enough loyalty points to cover the requested amount',
          code: 409,
          key: 'InsufficientFunds',
        });
      default:
        return new MockCustomError({
          message: 'the loyalty service is currently not available',
          code: 500,
          key: 'GenericError',
        });
    }
  }
}

/** The figure a checkout compares against: gross incl. tax when commercetools has resolved it. */
const grossTotal = (cart: Cart): number => cart.taxedPrice?.totalGross.centAmount ?? cart.totalPrice.centAmount;

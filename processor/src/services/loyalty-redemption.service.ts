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
import { getCartIdFromContext } from '../libs/fastify/context/context';
import { MockCustomError } from '../errors/mock-api.error';
import { BalanceConverter } from './converters/balance-converter';
import { CartRedemptionFieldsClient } from '../clients/cart-redemption-fields.client';
import { decompose, sumDenominations } from './denominations';
import packageJSON from '../../package.json';
import { log } from '../libs/logger';

export type LoyaltyRedemptionServiceOptions = {
  ctCartService: CommercetoolsCartService;
  ctPaymentService: CommercetoolsPaymentService;
  ctOrderService: CommercetoolsOrderService;
  cartFields: CartRedemptionFieldsClient;
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
  private readonly balanceConverter = new BalanceConverter();

  constructor(opts: LoyaltyRedemptionServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService, opts.ctOrderService);
    this.cartFields = opts.cartFields;
  }

  async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          // manage_orders covers the cart updates; the payment-intents route keeps its own scopes.
          requiredPermissions: [
            'manage_orders',
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
    const userId = this.getLoyaltyUserId(cart);
    const carried = this.cartFields.read(cart);
    const stillOwed = await this.ctCartService.getPaymentAmount({ cart });
    const undiscounted = stillOwed.centAmount + sumDenominations(carried.denominations);
    try {
      const result = await LoyaltyAPI().balance({
        userId,
        currencyCode: stillOwed.currencyCode,
        cartId: cart.id,
        cartTotal: undiscounted,
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
    const userId = this.getLoyaltyUserId(cart);

    // A previous redeem on this cart is replaced, never stacked: the backend allows one open hold per
    // cart, and the field can only hold one redemption anyway. Void first (a lock conflict aborts here,
    // before anything moved), then take the discount off so the floor below is measured undiscounted.
    const carried = this.cartFields.read(cart);
    if (carried.redemptionId) {
      await this.voidOrAbortOnLock(carried.redemptionId, 'releaseOnRedeem');
      cart = await this.clearOrSurface(cart, carried.redemptionId, 'releaseOnRedeem');
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
      await this.closeHold(redemptionId, 'writeFailed');
      throw e;
    }

    // Measured against the cart the write was really applied to: a version-conflict retry re-reads
    // the cart, and a concurrent line change must not masquerade as a discount that did not apply.
    const applied = grossTotal(baseline) - grossTotal(updated);
    if (applied !== amount.centAmount) {
      // A stopping promotion above the loyalty discounts, a currency the denominations are not
      // provisioned in, or a cart too small for the amount: commercetools did not do what the hold
      // assumed, so undo both sides rather than leave points spent against a partial discount.
      try {
        await this.cartFields.clear(updated, redemptionId);
      } catch (clearError) {
        log.error('Could not take the partially applied discount off the cart.', {
          cartId: cart.id,
          redemptionId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }
      await this.closeHold(redemptionId, 'discountNotApplied');
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
   * so a redemption id the cart does not carry is refused before the ledger is touched - voiding it
   * would strip someone else's checkout of the hold behind its discount. Then void first, so a lock
   * conflict (a competing finalize) is caught before the cart moves, and take the discount off.
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
    await this.voidOrAbortOnLock(opts.data.redemptionId, 'release');
    await this.clearOrSurface(cart, opts.data.redemptionId, 'release');
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

  /**
   * The hold is already voided when this runs, so a failure here leaves a discount on the cart with
   * no hold behind it - the one state the backend's sweep cannot repair (it only clears carts of OPEN
   * holds). It is logged with both ids for reconciliation and surfaced to the caller rather than
   * passed off as success; if the shopper checks out anyway, the settle-time audit reports it.
   */
  private async clearOrSurface(cart: Cart, redemptionId: string, action: string): Promise<Cart> {
    try {
      return await this.cartFields.clear(cart, redemptionId);
    } catch (e) {
      log.error(
        'Voided the reservation but could not take its discount off the cart: the cart now carries an unbacked discount.',
        {
          cartId: cart.id,
          redemptionId,
          action,
          error: e instanceof Error ? e.message : String(e),
        },
      );
      throw e;
    }
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

  /** The loyalty userId is the cart's customer email, lowercased. */
  private getLoyaltyUserId(cart: Cart): string {
    const customerEmail = cart.customerEmail?.trim().toLowerCase();
    if (!customerEmail) {
      throw new MockCustomError({
        message: 'the cart has no customer email, loyalty points cannot be identified',
        code: 400,
        key: 'CustomerNotIdentified',
      });
    }
    return customerEmail;
  }

  /**
   * Voids a hold; only a finalization lock aborts the caller. Every other failure (backend unreachable,
   * hold already gone) is logged and swallowed - the backend's sweep recovers the ledger side at TTL,
   * and the caller still has to take the discount off the cart.
   */
  private async voidOrAbortOnLock(redemptionId: string, action: string): Promise<void> {
    try {
      await LoyaltyAPI().voidHold({ redemptionId });
    } catch (e) {
      if (e instanceof LoyaltyApiError && e.status === 409 && e.body?.lockedUntil) {
        throw new MockCustomError({
          message: 'this reservation is being finalized elsewhere and cannot be changed right now',
          code: 409,
          key: 'FinalizationInProgress',
        });
      }
      log.error(
        'Could not release the loyalty reservation: the points stay debited until the backend sweep recovers them at TTL.',
        { redemptionId, action, error: e instanceof LoyaltyApiError ? e.message : String(e) },
      );
    }
  }

  private async closeHold(redemptionId: string, action: string): Promise<void> {
    try {
      await LoyaltyAPI().voidHold({ redemptionId });
    } catch (e) {
      log.error(
        'Could not release the loyalty reservation after a failed cart write: the backend sweep recovers it at TTL.',
        { redemptionId, action, error: e instanceof LoyaltyApiError ? e.message : String(e) },
      );
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

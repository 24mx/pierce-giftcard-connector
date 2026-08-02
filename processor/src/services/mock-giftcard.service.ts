import {
  Cart,
  Payment,
  CommercetoolsCartService,
  CommercetoolsPaymentService,
  healthCheckCommercetoolsPermissions,
  statusHandler,
  CommercetoolsOrderService,
  ErrorGeneral,
} from '@commercetools/connect-payments-sdk';
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  PaymentProviderModificationResponse,
  StatusResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
} from './types/operation.type';
import { AmountSchemaDTO, PaymentModificationStatus } from '../dtos/operations/payment-intents.dto';
import { RedeemRequestDTO } from '../dtos/mock-giftcards.dto';
import { getConfig } from '../config/config';
import { appLogger, paymentSDK } from '../payment-sdk';
import { AbstractGiftCardService } from './abstract-giftcard.service';
import { LoyaltyAPI } from '../clients/loyalty.client';
import { LoyaltyApiError } from '../errors/loyalty-api.error';
import { getCartIdFromContext, getPaymentInterfaceFromContext } from '../libs/fastify/context/context';
import { BalanceResponseSchemaDTO, RedeemResponseDTO } from '../dtos/mock-giftcards.dto';
import { MockCustomError } from '../errors/mock-api.error';
import { BalanceConverter } from './converters/balance-converter';
import { RedemptionConverter } from './converters/redemption-converter';

import packageJSON from '../../package.json';
import { log } from '../libs/logger';

/**
 * Integrates commercetools with the Pierce loyalty backend, whose "gift card" is the customer's
 * loyalty point balance.
 *
 * Points are held at redeem and debited by the backend itself once an order exists, so nothing this
 * service does ever has to be compensated: an abandoned checkout requires no call at all. Capture is
 * deliberately absent - the loyalty backend drives it off the order signal.
 */
export type MockGiftCardServiceOptions = {
  ctCartService: CommercetoolsCartService;
  ctPaymentService: CommercetoolsPaymentService;
  ctOrderService: CommercetoolsOrderService;
};

export class MockGiftCardService extends AbstractGiftCardService {
  private balanceConverter: BalanceConverter;
  private redemptionConverter: RedemptionConverter;

  constructor(opts: MockGiftCardServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService, opts.ctOrderService);

    this.balanceConverter = new BalanceConverter();
    this.redemptionConverter = new RedemptionConverter();
  }

  /**
   * Get status
   *
   * @returns Promise containing the status of the systems this connector depends on
   */
  async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          requiredPermissions: [
            'manage_payments',
            'view_sessions',
            'view_api_clients',
            'manage_orders',
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
            details: {
              loyaltyApiUrl,
              // Surfaces an unsecured link rather than letting it pass unnoticed. Acceptable
              // against a backend on the same laptop, nowhere else.
              authenticated: Boolean(getConfig().loyaltyApiKey),
            },
          };
        },
      ],
      metadataFn: async () => ({
        name: packageJSON.name,
        description: packageJSON.description,
      }),
    })();

    return handler.body;
  }

  /**
   * The widget's `code` field is not an identity input: the loyalty account is the cart customer
   * and the currency comes from the cart. It does carry one instruction, though - an amount, in the
   * `Valid-<centAmount>-<CURRENCY>` shape the checkout's own sample codes use - and that is the only
   * say anyone gets in how much goes.
   *
   * The checkout SDK spends min(reported balance, cart total) and hands redeem an amount derived
   * from this number, so reporting the whole balance means every checkout drains what it can.
   * Reporting less is how a shopper keeps the rest. A code naming no amount, or one in another
   * currency, is not an instruction and leaves the full balance on offer.
   */
  async balance(code: string): Promise<BalanceResponseSchemaDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const userId = this.getLoyaltyUserId(ctCart);

    try {
      const balanceResult = await LoyaltyAPI().balance({
        userId,
        currencyCode: amountPlanned.currencyCode,
      });

      const balance = this.balanceConverter.convert(balanceResult);
      return this.capToRequestedAmount(balance, code, amountPlanned.currencyCode);
    } catch (e) {
      throw this.toConnectorError(e);
    }
  }

  /**
   * Lowers the reported balance to what the code asks for. Never raises it: the shopper cannot
   * spend points they do not have, whatever the code says.
   */
  private capToRequestedAmount(
    balance: BalanceResponseSchemaDTO,
    code: string,
    cartCurrency: string,
  ): BalanceResponseSchemaDTO {
    const requested = MockGiftCardService.parseRequestedAmount(code, cartCurrency);
    if (requested === null || !balance.amount || requested >= balance.amount.centAmount) {
      return balance;
    }
    return { ...balance, amount: { ...balance.amount, centAmount: requested } };
  }

  /** Returns the cent amount the code names in the cart's currency, or null if it names none. */
  private static parseRequestedAmount(code: string, cartCurrency: string): number | null {
    const match = /^valid-(\d+)-([a-z]{3})$/i.exec(code.trim());
    if (!match || match[2].toUpperCase() !== cartCurrency.toUpperCase()) {
      return null;
    }
    return Number(match[1]);
  }

  /**
   * Order matters: the Payment is created and attached, the points are held, and only then is the
   * transaction written. A hold whose transaction never got written is harmless - a payment with no
   * Charge does not count towards cart coverage, and the hold ages out. The reverse order is not:
   * it is coverage the ledger never recorded.
   */
  async redeem(opts: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });
    const userId = this.getLoyaltyUserId(ctCart);
    const redeemAmount = opts.data.redeemAmount;

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned: redeemAmount,
      paymentMethodInfo: {
        paymentInterface: getPaymentInterfaceFromContext() || 'pierce-loyalty-giftcard',
        method: 'giftcard',
      },
      ...(ctCart.customerId && {
        customer: {
          typeId: 'customer',
          id: ctCart.customerId,
        },
      }),
      ...(!ctCart.customerId &&
        ctCart.anonymousId && {
          anonymousId: ctCart.anonymousId,
        }),
    });

    await this.ctCartService.addPayment({
      resource: {
        id: ctCart.id,
        version: ctCart.version,
      },
      paymentId: ctPayment.id,
    });

    try {
      await LoyaltyAPI().hold({
        userId,
        paymentId: ctPayment.id,
        cartId: ctCart.id,
        amount: redeemAmount,
      });
    } catch (e) {
      // Includes an uncertain hold (timeout, 5xx): leaving the payment transaction-less is the only
      // outcome we can recover from, so never write the transaction here.
      throw this.toConnectorError(e);
    }

    await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      transaction: {
        type: 'Charge',
        amount: ctPayment.amountPlanned,
        state: 'Success',
      },
    });

    return this.redemptionConverter.convert({ payment: ctPayment });
  }

  /**
   * Nothing to capture in phase 1: the Charge is written at redeem, and the loyalty backend books
   * the debit itself from the order signal. A call arriving here means something is wired up that
   * should not be, so it stays an alarm rather than a silent no-op.
   */
  async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    throw new ErrorGeneral('operation not supported', {
      fields: {
        pspReference: request.payment.interfaceId,
      },
      privateMessage: "connector doesn't support capture operation",
    });
  }

  /**
   * The customer removed the points from the cart. Reverting the coverage is what matters; closing
   * the hold is what saves them from waiting out the TTL to see their points again.
   */
  async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.revertCoverageAndCloseHold({
      payment: request.payment,
      amount: request.payment.amountPlanned,
      action: 'cancelPayment',
    });
  }

  async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.revertCoverageAndCloseHold({
      payment: request.payment,
      amount: request.amount,
      action: 'refundPayment',
    });
  }

  /**
   * Reachable through `automatedReversalConfiguration` when order creation fails. Nothing was
   * debited, so this releases a hold rather than crediting points back.
   */
  async reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    return this.revertCoverageAndCloseHold({
      payment: request.payment,
      amount: request.payment.amountPlanned,
      action: 'reversePayment',
    });
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
   * Maps a loyalty backend failure onto the error taxonomy the widget understands.
   * Anything that is not a backend rejection is a service
   * failure: the caller must fail the operation rather than assume anything about the ledger.
   */
  private toConnectorError(e: unknown): Error {
    if (!(e instanceof LoyaltyApiError)) {
      return e instanceof Error ? e : new Error(String(e));
    }

    switch (e.status) {
      case 400:
        return new MockCustomError({
          message: 'cart and gift card currency do not match',
          code: 400,
          key: 'CurrencyNotMatch',
        });
      case 409:
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

  /**
   * Reverting the coverage comes first: a Refund in state Success makes the SDK count the whole
   * payment as 0 towards the cart, which is the outcome the customer asked for. Closing the hold is
   * a courtesy on top - it is not a ledger operation, and a hold ages out on its own - so a failure
   * there is logged and the operation still reports success.
   */
  private async revertCoverageAndCloseHold(opts: {
    payment: Payment;
    amount: AmountSchemaDTO;
    action: string;
  }): Promise<PaymentProviderModificationResponse> {
    log.info(`Processing payment modification.`, {
      paymentId: opts.payment.id,
      action: opts.action,
    });

    await this.ctPaymentService.updatePayment({
      id: opts.payment.id,
      transaction: {
        type: 'Refund',
        amount: opts.amount,
        state: 'Success',
      },
    });

    try {
      await LoyaltyAPI().voidHold({ paymentId: opts.payment.id });
    } catch (e) {
      log.warn(`Could not close the loyalty hold, it will age out at its TTL.`, {
        paymentId: opts.payment.id,
        action: opts.action,
        error: e instanceof LoyaltyApiError ? e.message : String(e),
      });
    }

    log.info(`Payment modification completed.`, {
      paymentId: opts.payment.id,
      action: opts.action,
      result: PaymentModificationStatus.APPROVED,
    });

    return {
      outcome: PaymentModificationStatus.APPROVED,
      pspReference: opts.payment.id,
    };
  }
}

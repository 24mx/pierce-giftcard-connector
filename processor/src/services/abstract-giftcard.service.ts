import {
  CommercetoolsCartService,
  CommercetoolsOrderService,
  CommercetoolsPaymentService,
  ErrorInvalidOperation,
} from '@commercetools/connect-payments-sdk';
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  ModifyPayment,
  PaymentProviderModificationResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
  StatusResponse,
} from './types/operation.type';
import { PaymentIntentResponseSchemaDTO } from '../dtos/operations/payment-intents.dto';
import {
  BalanceResponseSchemaDTO,
  RedeemRequestDTO,
  RedeemResponseDTO,
  FinalizeRequestDTO,
  FinalizeResponseDTO,
  ReleaseRequestDTO,
  ReleaseResponseDTO,
} from '../dtos/loyalty-redemption.dto';

export abstract class AbstractGiftCardService {
  protected ctCartService: CommercetoolsCartService;
  protected ctPaymentService: CommercetoolsPaymentService;
  protected ctOrderService: CommercetoolsOrderService;

  constructor(
    ctCartService: CommercetoolsCartService,
    ctPaymentService: CommercetoolsPaymentService,
    ctOrderService: CommercetoolsOrderService,
  ) {
    this.ctCartService = ctCartService;
    this.ctPaymentService = ctPaymentService;
    this.ctOrderService = ctOrderService;
  }

  /**
   * Get stats information
   * @returns
   */
  abstract status(): Promise<StatusResponse>;

  /**
   * Validate Code and return balance
   * @returns
   */
  abstract balance(code: string): Promise<BalanceResponseSchemaDTO>;

  /**
   * Redeem Code
   * @returns
   */
  abstract redeem(opt: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO>;

  /** Lock the redemption for the checkout's final submission (storefront-initiated). */
  abstract finalize(opt: { data: FinalizeRequestDTO }): Promise<FinalizeResponseDTO>;

  /** Take a redemption off the cart and give the points back (storefront-initiated). */
  abstract release(opt: { data: ReleaseRequestDTO }): Promise<ReleaseResponseDTO>;

  /**
   * Capture payment
   * @param request
   * @returns
   */
  abstract capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse>;

  /**
   * Cancel payment
   * @param request
   * @returns
   */
  abstract cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse>;

  /**
   * Refund payment
   * @param request
   * @returns
   */
  abstract refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse>;

  /**
   * Reverse payment
   *
   * @remarks
   * Abstract method to execute payment reversals in support of automated reversals to be triggered by checkout api. The actual invocation to PSPs should be implemented in subclasses
   *
   * @param request
   * @returns Promise with outcome containing operation status and PSP reference
   */
  abstract reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse>;

  public async modifyPayment(opts: ModifyPayment): Promise<PaymentIntentResponseSchemaDTO> {
    const ctPayment = await this.ctPaymentService.getPayment({
      id: opts.paymentId,
    });
    const request = opts.data.actions[0];

    switch (request.action) {
      case 'cancelPayment': {
        return await this.cancelPayment({ payment: ctPayment, merchantReference: request.merchantReference });
      }
      case 'capturePayment': {
        return await this.capturePayment({
          payment: ctPayment,
          merchantReference: request.merchantReference,
          amount: request.amount,
        });
      }
      case 'refundPayment': {
        return await this.refundPayment({
          amount: request.amount,
          payment: ctPayment,
          merchantReference: request.merchantReference,
          transactionId: request.transactionId,
        });
      }
      case 'reversePayment': {
        return await this.reversePayment({
          payment: ctPayment,
          merchantReference: request.merchantReference,
        });
      }
      default: {
        throw new ErrorInvalidOperation('Operation not supported.');
      }
    }
  }
}

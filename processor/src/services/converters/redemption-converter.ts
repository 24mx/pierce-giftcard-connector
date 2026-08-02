import { RedeemResponseDTO } from '../../dtos/mock-giftcards.dto';
import { Payment } from '@commercetools/connect-payments-sdk';

export class RedemptionConverter {
  /**
   * Reached only once the hold succeeded, so the result is always a success. The hold is keyed on
   * the commercetools payment id, which is why that id is also the redemption reference - the
   * loyalty backend hands out no separate one.
   */
  public convert(opts: { payment: Payment }): RedeemResponseDTO {
    return {
      result: 'Success',
      paymentReference: opts.payment.id,
      redemptionId: opts.payment.id,
    };
  }
}

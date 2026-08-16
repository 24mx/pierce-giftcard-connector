import { RedeemResponseDTO } from '../../dtos/mock-giftcards.dto';
import { LoyaltyHoldResponse } from '../../clients/types/loyalty.client.type';
import { Payment } from '@commercetools/connect-payments-sdk';

export class RedemptionConverter {
  /**
   * Reached only once the hold succeeded, so the result is always a success. The hold is keyed on
   * the commercetools payment id, which is why that id is also the redemption reference - the
   * loyalty backend hands out no separate one. `points` is the hold response's own count of points
   * actually debited, not derived from the money amount the caller sent - the caller has no other
   * way to learn how many real points a redemption cost.
   */
  public convert(opts: { payment: Payment; hold: LoyaltyHoldResponse }): RedeemResponseDTO {
    return {
      result: 'Success',
      paymentReference: opts.payment.id,
      redemptionId: opts.payment.id,
      points: opts.hold.points,
    };
  }
}

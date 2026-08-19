import { LoyaltyBalanceResponse, LoyaltyCap } from '../../clients/types/loyalty.client.type';
import { BalanceResponseSchemaDTO } from '../../dtos/mock-giftcards.dto';

export class BalanceConverter {
  /**
   * The backend already returns spendable points - the ledger balance minus every open hold - so
   * both the points and the amount are passed through untouched. Failures never reach here: they
   * surface as a LoyaltyApiError from the client and are mapped by the service.
   *
   * `cap` is the same answer's cart-aware maximum. The service has already established it is there,
   * which it always is for a request that named a cart - and this connector always does.
   */
  public convert(
    opts: LoyaltyBalanceResponse,
    openRedemptionId: string | null,
    cap: LoyaltyCap,
  ): BalanceResponseSchemaDTO {
    return {
      status: {
        state: 'Valid',
      },
      amount: {
        centAmount: opts.amount.centAmount,
        currencyCode: opts.amount.currencyCode,
      },
      points: opts.points,
      openRedemptionId,
      maxPoints: cap.maxPoints,
      rate: opts.rateToEur,
      // Falls back to null (not 0) against a backend that hasn't shipped openHoldPoints yet -
      // 0 would claim "nothing is held" when the truth is "unknown", same distinction maxPoints/rate
      // already draw against a backend without a cap.
      openRedemptionPoints: opts.openHoldPoints ?? null,
    };
  }
}

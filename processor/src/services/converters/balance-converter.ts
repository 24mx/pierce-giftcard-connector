import { LoyaltyBalanceResponse } from '../../clients/types/loyalty.client.type';
import { BalanceResponseSchemaDTO } from '../../dtos/mock-giftcards.dto';

export class BalanceConverter {
  /**
   * The backend already returns spendable points - the ledger balance minus every open hold - so
   * both the points and the amount are passed through untouched. Failures never reach here: they
   * surface as a LoyaltyApiError from the client and are mapped by the service.
   *
   * `quote` is the cart-aware redeemable cap - a separate, advisory-only call the service already
   * defaults to `{maxPoints: 0, rate: 0}` on failure, so this converter never needs to know whether
   * it succeeded.
   */
  public convert(
    opts: LoyaltyBalanceResponse,
    openRedemptionId: string | null,
    quote: { maxPoints: number; rate: number },
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
      maxPoints: quote.maxPoints,
      rate: quote.rate,
    };
  }
}

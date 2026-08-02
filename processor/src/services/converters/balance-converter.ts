import { LoyaltyBalanceResponse } from '../../clients/types/loyalty.client.type';
import { BalanceResponseSchemaDTO } from '../../dtos/mock-giftcards.dto';

export class BalanceConverter {
  /**
   * The backend already returns spendable points - the ledger balance minus every open hold - so
   * the amount is passed through untouched. Failures never reach here: they surface as a
   * LoyaltyApiError from the client and are mapped by the service.
   */
  public convert(opts: LoyaltyBalanceResponse): BalanceResponseSchemaDTO {
    return {
      status: {
        state: 'Valid',
      },
      amount: {
        centAmount: opts.amount.centAmount,
        currencyCode: opts.amount.currencyCode,
      },
    };
  }
}

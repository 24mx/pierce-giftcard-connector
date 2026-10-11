import { Cart } from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { AmountSchemaDTO } from '../dtos/operations/payment-intents.dto';
import { getConfig } from '../config/config';
import { MockCustomError } from '../errors/mock-api.error';
import {
  CartRedemptionFieldsClient,
  CommercetoolsCartRedemptionFieldsClient,
} from '../clients/cart-redemption-fields.client';
import { decompose, sumDenominations } from '../services/denominations';
import { provisionLoyaltyRedemption } from '../connectors/loyalty-provisioning';
import { CartRedemption } from './cart-redemption';

type Logger = { info(message: string): void };

/**
 * The redemption as power-of-two automatic CartDiscounts: the cart carries the redemption id and the
 * set of denomination keys in two custom fields, and every denomination's CartDiscount fires on
 * `custom.<field> contains "Dn"`. commercetools applies the discounts by itself, so what a write took
 * off is read back from the cart's gross total. The levels per currency are read from the config on
 * every call (LOYALTY_DISCOUNT_STORES).
 */
export class DenominationCartRedemption implements CartRedemption {
  constructor(
    private readonly fields: CartRedemptionFieldsClient,
    private readonly provisionWith: (logger: Logger) => Promise<void>,
  ) {}

  public carriedBy(cart: Cart): string | null {
    return this.fields.read(cart).redemptionId;
  }

  public amountOn(cart: Cart): number {
    return sumDenominations(this.fields.read(cart).denominations);
  }

  public assertCurrency(currencyCode: string): void {
    this.levelsOrRefuse(currencyCode);
  }

  public assertApplicable(amount: AmountSchemaDTO): void {
    this.denominationsOrRefuse(amount);
  }

  public async apply(cart: Cart, redemptionId: string, amount: AmountSchemaDTO): Promise<number> {
    const denominations = this.denominationsOrRefuse(amount);
    const { baseline, updated } = await this.fields.write(cart, { redemptionId, denominations });
    // Measured against the cart the write was really applied to: a version-conflict retry re-reads
    // the cart, and a concurrent line change must not masquerade as a discount that did not apply.
    return grossTotal(baseline) - grossTotal(updated);
  }

  public async clear(cart: Cart, redemptionId: string): Promise<void> {
    await this.fields.clear(cart, redemptionId);
  }

  public provision(logger: Logger): Promise<void> {
    return this.provisionWith(logger);
  }

  private levelsOrRefuse(currencyCode: string): number {
    const levels = getConfig().loyaltyDiscountLevelsByCurrency[currencyCode];
    if (!levels) {
      throw new MockCustomError({
        message: `no loyalty denominations are configured for ${currencyCode}`,
        code: 400,
        key: 'CurrencyNotMatch',
      });
    }
    return levels;
  }

  private denominationsOrRefuse(amount: AmountSchemaDTO): string[] {
    const levels = this.levelsOrRefuse(amount.currencyCode);
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
}

/** The figure a checkout compares against: gross incl. tax when commercetools has resolved it. */
const grossTotal = (cart: Cart): number => cart.taxedPrice?.totalGross.centAmount ?? cart.totalPrice.centAmount;

/**
 * The representation this deployment runs, built from the config - the one place app.ts and the
 * post-deploy hook take it from, so replacing the representation means replacing this function.
 */
export const cartRedemptionFromConfig = (client: ByProjectKeyRequestBuilder): CartRedemption => {
  const config = getConfig();
  return new DenominationCartRedemption(
    new CommercetoolsCartRedemptionFieldsClient(client, {
      typeKey: config.loyaltyCartTypeKey,
      redemptionIdField: config.loyaltyRedemptionIdField,
      denominationsField: config.loyaltyDenominationsField,
    }),
    (logger) =>
      provisionLoyaltyRedemption(
        client,
        {
          typeKey: config.loyaltyCartTypeKey,
          redemptionIdField: config.loyaltyRedemptionIdField,
          denominationsField: config.loyaltyDenominationsField,
          discountKeyPrefix: config.loyaltyDiscountKeyPrefix,
          stores: config.loyaltyDiscountStores,
          sortOrderBase: config.loyaltyDiscountSortOrderBase,
        },
        logger,
      ),
  );
};

import { Cart } from '@commercetools/platform-sdk';
import { AmountSchemaDTO } from '../dtos/operations/payment-intents.dto';

type Logger = { info(message: string): void };

/**
 * How a points redemption is represented on a commercetools cart - the one thing that changes when
 * commercetools, or the way Pierce carries points there, changes. The redemption service speaks only
 * in redemption ids and amounts through this interface; everything the representation needs in
 * commercetools (custom fields, cart discounts, their provisioning) lives behind it.
 *
 * The loyalty backend reads the same representation off orders (its CtRedemptionPlatformAdapter), so
 * a new implementation ships together with the backend's adapter.
 */
export interface CartRedemption {
  /** The redemption the cart carries, or null when it carries none. */
  carriedBy(cart: Cart): string | null;

  /** What the redemption already on the cart takes off it, in the cart's minor units; 0 when none. */
  amountOn(cart: Cart): number;

  /** Refuses (CurrencyNotMatch) a currency this representation cannot put any redemption on. */
  assertCurrency(currencyCode: string): void;

  /** Refuses (AmountNotDecomposable) an amount this representation cannot put on a cart, before anything is held. */
  assertApplicable(amount: AmountSchemaDTO): void;

  /**
   * Puts the redemption on the cart and resolves with what commercetools actually took off it, in the
   * cart's minor units - measured on the cart the update was really applied to. Rejects when the update
   * failed; it may still have reached commercetools, so the caller must treat the cart as uncertain.
   */
  apply(cart: Cart, redemptionId: string, amount: AmountSchemaDTO): Promise<number>;

  /** Takes the redemption off the cart, only while the cart still carries `redemptionId`. */
  clear(cart: Cart, redemptionId: string): Promise<void>;

  /** Idempotently sets up what the representation needs in commercetools; run by the post-deploy hook. */
  provision(logger: Logger): Promise<void>;
}

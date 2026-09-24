/**
 * Every `status.state` the processor can answer with on its four storefront routes, and what the
 * storefront should do about it. Adding or renaming a key is a major version bump.
 */
export const LOYALTY_ERROR_KEYS = [
  /** Something the processor did not anticipate; the storefront shows a generic failure and re-quotes. */
  'GenericError',
  /** The cart has no customerEmail; only a logged-in shopper can pay with points. */
  'CustomerNotIdentified',
  /** The ledger cannot cover the requested amount. */
  'InsufficientFunds',
  /** redeemAmount.currencyCode differs from the cart's currency. */
  'CurrencyNotMatch',
  /** A concurrent redeem on the same cart won; re-quote (the balance reports the open redemption). */
  'CartAlreadyHeld',
  /** The amount exceeds what the denomination discounts can compose (262,143 minor units). */
  'AmountNotDecomposable',
  /** commercetools did not take the amount off the cart; the hold was voided, nothing was kept. */
  'DiscountNotApplied',
  /** The cart no longer carries this redemptionId (another tab removed it, or it was never applied). */
  'RedemptionNotOnCart',
  /** A checkout submission locked the hold; the lock expires on its own. */
  'FinalizationInProgress',
] as const;

export type LoyaltyErrorKey = (typeof LOYALTY_ERROR_KEYS)[number];

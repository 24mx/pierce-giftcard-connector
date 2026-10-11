/**
 * Every `status.state` the processor can answer with on its four storefront routes, and what the
 * storefront should do about it. Adding or renaming a key is a major version bump.
 */
export const LOYALTY_ERROR_KEYS = [
  /** Something the processor did not anticipate; the storefront shows a generic failure and re-quotes. */
  'GenericError',
  /** The cart belongs to no customer account (a guest cart, or the account is gone); only a logged-in shopper can pay with points. */
  'CustomerNotIdentified',
  /** The ledger cannot cover the requested amount. */
  'InsufficientFunds',
  /**
   * Two cases share this key: (a) redeemAmount.currencyCode differs from the cart's currency, and
   * (b) the connector is not set up to put points on carts in the cart's currency at all — a server
   * misconfiguration, not something the shopper can fix.
   */
  'CurrencyNotMatch',
  /** A concurrent redeem on the same cart won; re-quote (the balance reports the open redemption). */
  'CartAlreadyHeld',
  /**
   * The amount is more than the connector can put on a cart in that currency (a per-currency ceiling
   * of the connector's set-up, at least the loyalty backend's per-order cap). The key's name is kept
   * for compatibility; it does not imply how points are carried on the cart.
   */
  'AmountNotDecomposable',
  /** commercetools did not take the amount off the cart; the hold was voided, nothing was kept. */
  'DiscountNotApplied',
  /** The cart no longer carries this redemptionId (another tab removed it, or it was never applied). */
  'RedemptionNotOnCart',
  /** A checkout submission locked the hold; the lock expires on its own. */
  'FinalizationInProgress',
  /** /redeem named both redeemAmount and redeemPoints; exactly one is allowed. */
  'InvalidRedeemRequest',
] as const;

export type LoyaltyErrorKey = (typeof LOYALTY_ERROR_KEYS)[number];

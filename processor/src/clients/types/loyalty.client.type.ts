export type LoyaltyAmount = {
  centAmount: number;
  currencyCode: string;
};

export type LoyaltyBalanceRequest = {
  userId: string;
  currencyCode: string;
  /**
   * Naming a cart additionally asks what that cart would accept. Both or neither: the backend
   * answers half a pair with a 400 rather than guessing which half was meant.
   */
  cartId?: string;
  /** The cart's total, in minor units of `currencyCode` — the ceiling the cap is measured against. */
  cartTotal?: number;
};

/** The largest reservation this cart would accept, in points and in the balance's own currency. */
export type LoyaltyCap = {
  maxPoints: number;
  maxCents: number;
};

export type LoyaltyBalanceResponse = {
  userId: string;
  points: number;
  amount: LoyaltyAmount;
  /** Local currency units per 1 EUR — converts slider positions without a request per tick. */
  rateToEur: number;
  /** Present only when the request named a cart. See GiftcardCap in the loyalty backend. */
  cap?: LoyaltyCap;
  /**
   * Points already committed to this cart's own open reservation, if it has one - a real `0` when
   * the request named a cart with none, absent (not `0`) when no cart was named at all. Present for
   * the same reason `cartId` is on the request: GIFTCARD_ZERO_CT_COVERAGE makes the connector write
   * the gift card Payment into commercetools at zero, so this is the only place the amount survives.
   */
  openHoldPoints?: number;
};

export type LoyaltyHoldRequest = {
  userId: string;
  paymentId: string;
  cartId: string;
  amount: LoyaltyAmount;
  /**
   * The cart total this reservation is measured against. The backend keeps EUR 1 of every order
   * payable by a non-points method and enforces that floor itself, so the rule no longer depends on
   * this connector's arithmetic being right.
   */
  cartTotal: LoyaltyAmount;
};

/** Shared by hold and void: the points touched plus the resulting spendable balance. */
export type LoyaltyHoldResponse = {
  paymentId: string;
  points: number;
  balance: number;
};

export type LoyaltyVoidRequest = {
  paymentId: string;
};

/** Error body returned by the loyalty backend for every non-2xx response. */
export type LoyaltyErrorResponse = {
  error?: string;
  /** Present only on the /hold 409 for "this cart already has a different open reservation". */
  existingPaymentId?: string;
};

export type LoyaltyAmount = {
  centAmount: number;
  currencyCode: string;
};

export type LoyaltyBalanceRequest = {
  userId: string;
  currencyCode: string;
};

export type LoyaltyBalanceResponse = {
  userId: string;
  points: number;
  amount: LoyaltyAmount;
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

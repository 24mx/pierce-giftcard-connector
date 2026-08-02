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
};

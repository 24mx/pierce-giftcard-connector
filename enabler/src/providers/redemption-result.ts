import { Amount, RedemptionResult } from './definitions';

/** The processor's /redeem response body, as far as the enabler reads it. */
export type RedeemResponseBody = {
  result: string;
  redemptionId: string;
  points: number;
  appliedAmount: Amount;
};

/** Maps a /redeem body onto the onComplete payload; anything but Success is a plain failure. */
export const toRedemptionResult = (body: RedeemResponseBody): RedemptionResult => {
  if (body.result !== 'Success') {
    return { isSuccess: false };
  }

  return {
    isSuccess: true,
    redemptionId: body.redemptionId,
    points: body.points,
    appliedAmount: body.appliedAmount,
  };
};

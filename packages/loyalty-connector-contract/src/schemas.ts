import { Type } from '@sinclair/typebox';

export const AmountSchema = Type.Object({
  centAmount: Type.Integer(),
  currencyCode: Type.String(),
});

export const ErrorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

const StatusSchema = Type.Object({
  state: Type.String(),
  errors: Type.Optional(ErrorSchema),
});

/**
 * Every non-2xx answer of the four routes. `status.state` is the error key (see LOYALTY_ERROR_KEYS);
 * `status.errors[0].code` repeats it.
 */
export const ErrorResponseSchema = Type.Object({
  status: Type.Object({
    state: Type.String(),
    errors: Type.Array(ErrorSchema),
  }),
});

export const BalanceRequestSchema = Type.Object({
  code: Type.String(),
});

export const BalanceResponseSchema = Type.Object({
  status: StatusSchema,
  amount: AmountSchema,
  points: Type.Number(),
  // The redemption id the cart's custom field already carries, if any - null otherwise. Lets a caller
  // reconstruct "a redemption is active" state after losing it client-side (e.g. a page refresh
  // mid-checkout) without reading commercetools itself.
  openRedemptionId: Type.Union([Type.String(), Type.Null()]),
  // The redeemable cap for THIS cart (balance capped by what the cart still asks for and the card
  // floor) and the precise cents-per-point rate in `amount.currencyCode` - not the full spendable
  // balance `points` reports above. Both come from the same call as the balance, so `maxPoints: 0`
  // says exactly one thing: nothing is redeemable against this cart right now.
  maxPoints: Type.Number(),
  rate: Type.Number(),
  // How many points openRedemptionId's own reservation covers, or null when openRedemptionId is
  // null. Lets a caller restore a slider's position after losing it client-side (e.g. a page
  // refresh), which openRedemptionId alone cannot do - it names which redemption is open, not how
  // much of it there is.
  openRedemptionPoints: Type.Union([Type.Number(), Type.Null()]),
  // Whether openRedemptionId's own reservation is currently locked for final submission
  // (see FinalizeRequestSchema below), or null when the backend hasn't shipped this field yet.
  openRedemptionLocked: Type.Union([Type.Boolean(), Type.Null()]),
});

export const RedeemRequestSchema = Type.Object({
  code: Type.String(),
  redeemAmount: AmountSchema,
});

export const RedeemResponseSchema = Type.Object({
  result: Type.String(),
  // The UUID the connector minted and wrote onto the cart's loyaltyRedemptionId field - the hold's
  // key in the loyalty backend, and the id /finalize and /release take.
  redemptionId: Type.String(),
  points: Type.Number(),
  // What commercetools actually took off the cart's gross total once the denominations were applied.
  // Always equals the requested amount on a 200: anything else is a 409 DiscountNotApplied instead.
  appliedAmount: AmountSchema,
});

export const FinalizeRequestSchema = Type.Object({
  redemptionId: Type.String(),
});

export const FinalizeResponseSchema = Type.Object({
  result: Type.String(),
});

/** Takes the redemption off the cart and gives the points back; the storefront's "remove points" action. */
export const ReleaseRequestSchema = Type.Object({
  redemptionId: Type.String(),
});

export const ReleaseResponseSchema = Type.Object({
  result: Type.String(),
});

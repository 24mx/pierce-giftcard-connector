import { Static, Type } from '@sinclair/typebox';
import { AmountSchema } from './operations/payment-intents.dto';

export const ErrorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

const StatusSchema = Type.Object({
  state: Type.String(),
  errors: Type.Optional(ErrorSchema),
});

export const BalanceResponseSchema = Type.Object({
  status: StatusSchema,
  amount: AmountSchema,
  points: Type.Number(),
  // The CT Payment id of an already-open giftcard redemption on this cart, if one exists - null
  // otherwise. Lets a caller reconstruct "a redemption is active" state after losing it client-side
  // (e.g. a page refresh mid-checkout), without guessing at commercetools payment internals itself.
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
});

export const RedeemRequestSchema = Type.Object({
  code: Type.String(),
  redeemAmount: AmountSchema,
});

export const RedeemResponseSchema = Type.Object({
  result: Type.String(),
  paymentReference: Type.String(),
  redemptionId: Type.String(),
  points: Type.Number(),
});

export const BalanceRequestSchema = Type.Object({
  code: Type.String(),
});

// paymentId is redemptionId from RedeemResponseSchema above - the commercetools payment id the hold
// is keyed on, which is the only reference the loyalty backend hands out for a redemption.
export const FinalizeRequestSchema = Type.Object({
  paymentId: Type.String(),
});

export const FinalizeResponseSchema = Type.Object({
  result: Type.String(),
});

export type RedeemRequestDTO = Static<typeof RedeemRequestSchema>;
export type RedeemResponseDTO = Static<typeof RedeemResponseSchema>;
export type BalanceRequestSchemaDTO = Static<typeof BalanceRequestSchema>;
export type BalanceResponseSchemaDTO = Static<typeof BalanceResponseSchema>;
export type FinalizeRequestDTO = Static<typeof FinalizeRequestSchema>;
export type FinalizeResponseDTO = Static<typeof FinalizeResponseSchema>;

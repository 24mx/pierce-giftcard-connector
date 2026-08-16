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

export type RedeemRequestDTO = Static<typeof RedeemRequestSchema>;
export type RedeemResponseDTO = Static<typeof RedeemResponseSchema>;
export type BalanceRequestSchemaDTO = Static<typeof BalanceRequestSchema>;
export type BalanceResponseSchemaDTO = Static<typeof BalanceResponseSchema>;

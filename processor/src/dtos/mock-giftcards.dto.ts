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
  // The redeemable cap for THIS cart (balance capped by cart total and the card floor) and the
  // precise cents-per-point rate in `amount.currencyCode` - not the full spendable balance `points`
  // reports above. Both `0` when the loyalty backend's advisory quote call fails; a caller must
  // treat that as "nothing redeemable right now", not an error - see MockGiftCardService.balance.
  maxPoints: Type.Number(),
  rate: Type.Number(),
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

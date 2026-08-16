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

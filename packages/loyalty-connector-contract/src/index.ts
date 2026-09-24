import { Static } from '@sinclair/typebox';
import * as schemas from './schemas';

export * from './schemas';
export * from './error-keys';

export type Amount = Static<typeof schemas.AmountSchema>;
export type ErrorResponse = Static<typeof schemas.ErrorResponseSchema>;
export type BalanceRequest = Static<typeof schemas.BalanceRequestSchema>;
export type BalanceResponse = Static<typeof schemas.BalanceResponseSchema>;
export type RedeemRequest = Static<typeof schemas.RedeemRequestSchema>;
export type RedeemResponse = Static<typeof schemas.RedeemResponseSchema>;
export type FinalizeRequest = Static<typeof schemas.FinalizeRequestSchema>;
export type FinalizeResponse = Static<typeof schemas.FinalizeResponseSchema>;
export type ReleaseRequest = Static<typeof schemas.ReleaseRequestSchema>;
export type ReleaseResponse = Static<typeof schemas.ReleaseResponseSchema>;

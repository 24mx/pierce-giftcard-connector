import { FastifyInstance } from 'fastify';
import { paymentSDK } from '../../payment-sdk';
import { loyaltyRedemptionRoutes } from '../../routes/loyalty-redemption.route';
import { app } from '../app';

export default async function (server: FastifyInstance) {
  await server.register(loyaltyRedemptionRoutes, {
    giftCardService: app.services.giftCardService,
    sessionHeaderAuthHook: paymentSDK.sessionHeaderAuthHookFn,
    sessionQueryParamAuthHook: paymentSDK.sessionQueryParamAuthHookFn,
  });
}

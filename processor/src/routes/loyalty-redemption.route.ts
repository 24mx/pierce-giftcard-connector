import {
  SessionHeaderAuthenticationHook,
  SessionQueryParamAuthenticationHook,
} from '@commercetools/connect-payments-sdk';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AbstractGiftCardService } from '../services/abstract-giftcard.service';
import {
  BalanceRequestSchemaDTO,
  BalanceResponseSchema,
  BalanceResponseSchemaDTO,
  FinalizeRequestDTO,
  FinalizeResponseSchema,
  RedeemRequestDTO,
  RedeemResponseSchema,
  ReleaseRequestDTO,
  ReleaseResponseSchema,
} from '../dtos/loyalty-redemption.dto';
import { AmountSchema } from '../dtos/operations/payment-intents.dto';

type RoutesOptions = {
  giftCardService: AbstractGiftCardService;
  sessionHeaderAuthHook: SessionHeaderAuthenticationHook;
  sessionQueryParamAuthHook: SessionQueryParamAuthenticationHook;
};

/**
 * The storefront-facing surface of the redemption: every route is authenticated by the checkout
 * session (`x-session-id`), which is also where the cart id comes from.
 */
export const loyaltyRedemptionRoutes = async (fastify: FastifyInstance, opts: FastifyPluginOptions & RoutesOptions) => {
  fastify.post<{
    Reply: BalanceResponseSchemaDTO | void;
    Body: BalanceRequestSchemaDTO;
  }>(
    '/balance',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            code: Type.String(),
          },
          required: ['code'],
        },
        response: {
          200: BalanceResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { code } = request.body;
      const res = await opts.giftCardService.balance(code);
      return reply.status(200).send(res);
    },
  );

  fastify.post<{ Body: RedeemRequestDTO; Reply: void }>(
    '/redeem',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            code: Type.String(),
            redeemAmount: AmountSchema,
          },
          required: ['code', 'redeemAmount'],
        },
        response: {
          200: RedeemResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const res = await opts.giftCardService.redeem({ data: request.body });
      return reply.status(200).send(res);
    },
  );

  /**
   * Called by the storefront right before it submits the checkout's final payment, so a second tab
   * cannot void-and-recreate this reservation while a card leg elsewhere may already be reading its
   * amount. Best-effort from the storefront's point of view - see LoyaltyRedemptionService#finalize.
   */
  fastify.post<{ Body: FinalizeRequestDTO; Reply: void }>(
    '/finalize',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            redemptionId: Type.String(),
          },
          required: ['redemptionId'],
        },
        response: {
          200: FinalizeResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const res = await opts.giftCardService.finalize({ data: request.body });
      return reply.status(200).send(res);
    },
  );

  /** The storefront's "remove points from this order". Session-authenticated like /redeem. */
  fastify.post<{ Body: ReleaseRequestDTO; Reply: void }>(
    '/release',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            redemptionId: Type.String(),
          },
          required: ['redemptionId'],
        },
        response: {
          200: ReleaseResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const res = await opts.giftCardService.release({ data: request.body });
      return reply.status(200).send(res);
    },
  );
};

import { afterEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { ErrorAuthErrorResponse } from '@commercetools/connect-payments-sdk';
import { errorHandler } from '../../src/libs/fastify/error-handler';
import { loyaltyRedemptionRoutes } from '../../src/routes/loyalty-redemption.route';
import { AbstractGiftCardService } from '../../src/services/abstract-giftcard.service';
import { MockCustomError } from '../../src/errors/mock-api.error';

/**
 * The Fastify surface on its own: session gate, body validation, the hand-over to the service and
 * the shape an error leaves in. The service is a stub; its orchestration has its own spec.
 */
const SESSION_ID = 'session-1';
const EXAMPLES = join(__dirname, '../../../packages/loyalty-connector-contract/examples');
const example = (name: string) => JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), 'utf8'));

type Method = 'balance' | 'redeem' | 'finalize' | 'release';
type Call = { method: Method; arg: unknown };
type Impl = (arg: unknown) => Promise<unknown>;

const build = async (impls: Partial<Record<Method, Impl>>) => {
  const calls: Call[] = [];
  const service: Record<Method, Impl> = {
    balance: async () => undefined,
    redeem: async () => undefined,
    finalize: async () => undefined,
    release: async () => undefined,
  };
  for (const method of Object.keys(service) as Method[]) {
    service[method] = async (arg: unknown) => {
      calls.push({ method, arg });
      const impl = impls[method];
      if (!impl) {
        throw new Error(`the test did not expect ${method} to be called`);
      }
      return impl(arg);
    };
  }
  // Stands in for the SDK's hook: the same 401 it raises when the session cannot be verified.
  const sessionHeaderAuthHook = {
    authenticate: () => async (request: FastifyRequest) => {
      if (request.headers['x-session-id'] !== SESSION_ID) {
        throw new ErrorAuthErrorResponse('Session is not valid');
      }
    },
  };
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(loyaltyRedemptionRoutes, {
    giftCardService: service as unknown as AbstractGiftCardService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionHeaderAuthHook: sessionHeaderAuthHook as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionQueryParamAuthHook: {} as any,
  });
  await app.ready();
  return { app, calls };
};

// `null` means "no header at all"; an explicit undefined would fall back to the default parameter.
const post = (app: FastifyInstance, url: string, payload: unknown, session: string | null = SESSION_ID) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: session === null ? {} : { 'x-session-id': session },
  });

const VALID_BODIES: [string, unknown][] = [
  ['/balance', { code: '' }],
  ['/redeem', example('redeem.request')],
  ['/finalize', example('finalize.request')],
  ['/release', example('release.request')],
];

describe('loyalty-redemption.route', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test.each(VALID_BODIES)('%s is refused without a session before the service is reached', async (url, body) => {
    const built = await build({});
    app = built.app;

    const response = await post(app, url, body, null);

    expect(response.statusCode).toBe(401);
    expect(built.calls).toStrictEqual([]);
  });

  test('/redeem hands the body to the service and answers with its result', async () => {
    const built = await build({ redeem: async () => example('redeem.response') });
    app = built.app;

    const response = await post(app, '/redeem', example('redeem.request'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual(example('redeem.response'));
    expect(built.calls).toStrictEqual([{ method: 'redeem', arg: { data: example('redeem.request') } }]);
  });

  test('/balance hands the code to the service and answers with its result', async () => {
    const built = await build({ balance: async () => example('balance.response') });
    app = built.app;

    const response = await post(app, '/balance', { code: 'points' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual(example('balance.response'));
    expect(built.calls).toStrictEqual([{ method: 'balance', arg: 'points' }]);
  });

  test.each([
    ['/finalize', 'finalize' as Method],
    ['/release', 'release' as Method],
  ])('%s hands the redemption id to the service', async (url, method) => {
    const built = await build({ [method]: async () => ({ result: 'Success' }) });
    app = built.app;

    const response = await post(app, url, example('finalize.request'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ result: 'Success' });
    expect(built.calls).toStrictEqual([{ method, arg: { data: example('finalize.request') } }]);
  });

  test.each([
    ['/balance', {}],
    ['/redeem', { code: 'points' }],
    ['/redeem', { redeemAmount: { centAmount: 100, currencyCode: 'EUR' } }],
    ['/redeem', { code: 'points', redeemAmount: { centAmount: 100 } }],
    ['/finalize', {}],
    ['/release', {}],
  ])('%s refuses %j with a 400 that never reaches the service', async (url, body) => {
    const built = await build({});
    app = built.app;

    const response = await post(app, url, body);

    expect(response.statusCode).toBe(400);
    expect(built.calls).toStrictEqual([]);
  });

  test('a refusal from the service keeps its key and status in the body the storefront reads', async () => {
    const built = await build({
      redeem: async () => {
        throw new MockCustomError({ code: 409, key: 'InsufficientFunds', message: 'not enough loyalty points' });
      },
    });
    app = built.app;

    const response = await post(app, '/redeem', example('redeem.request'));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({
      status: {
        state: 'InsufficientFunds',
        errors: [{ code: 'InsufficientFunds', message: 'not enough loyalty points' }],
      },
    });
  });

  test('an unexpected failure is a plain 500 that does not leak its cause', async () => {
    const built = await build({
      release: async () => {
        throw new Error('database on fire');
      },
    });
    app = built.app;

    const response = await post(app, '/release', example('release.request'));

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ statusCode: 500, message: 'Internal server error.' });
    expect(JSON.stringify(response.json())).not.toContain('database on fire');
  });
});

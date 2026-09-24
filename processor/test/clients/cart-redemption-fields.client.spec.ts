import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { CommercetoolsCartRedemptionFieldsClient } from '../../src/clients/cart-redemption-fields.client';
import { getCartWithCustomerEmail } from '../mocks/coco';

const AUTH = 'https://auth.test';
const API = 'https://api.test';
const PROJECT = 'test-project';
const OPTS = {
  typeKey: 'pierce-loyalty-cart',
  redemptionIdField: 'loyaltyRedemptionId',
  denominationsField: 'loyaltyRedemption',
};

// ts-client captures `fetch` when the client is built, which would be before msw patches it; a
// late-bound wrapper resolves the global at call time so the interceptor sees every request.
const lateBoundFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

const platformClient = () =>
  createApiBuilderFromCtpClient(
    new ClientBuilder()
      .withClientCredentialsFlow({
        host: AUTH,
        projectKey: PROJECT,
        credentials: { clientId: 'id', clientSecret: 'secret' },
        httpClient: lateBoundFetch,
      })
      .withHttpMiddleware({ host: API, httpClient: lateBoundFetch })
      .build(),
  ).withProjectKey({ projectKey: PROJECT });

describe('cart-redemption-fields.client', () => {
  const server = setupServer(
    http.post(`${AUTH}/oauth/token`, () =>
      HttpResponse.json({
        access_token: 'token',
        expires_in: 3600,
        scope: 'manage_project:test-project',
        token_type: 'Bearer',
      }),
    ),
  );
  const client = new CommercetoolsCartRedemptionFieldsClient(platformClient(), OPTS);

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  test('reads both fields off a cart, and their absence as null / empty', () => {
    const bare = getCartWithCustomerEmail('a@b.c');
    expect(client.read(bare)).toStrictEqual({ redemptionId: null, denominations: [] });

    const carrying = getCartWithCustomerEmail('a@b.c', {
      custom: {
        type: { typeId: 'type', id: 'type-id' },
        fields: { loyaltyRedemptionId: 'red-1', loyaltyRedemption: ['D1024', 'D2'] },
      },
    });
    expect(client.read(carrying)).toStrictEqual({ redemptionId: 'red-1', denominations: ['D1024', 'D2'] });
  });

  test('writes with setCustomType when the cart has no custom type yet', async () => {
    const cart = getCartWithCustomerEmail('a@b.c', { version: 3 });
    let body: unknown;
    server.use(
      http.post(`${API}/${PROJECT}/carts/${cart.id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...cart, version: 4 });
      }),
    );

    const { baseline, updated } = await client.write(cart, { redemptionId: 'red-1', denominations: ['D1024', 'D2'] });

    expect(baseline).toBe(cart);
    expect(updated.version).toBe(4);
    expect(body).toStrictEqual({
      version: 3,
      actions: [
        {
          action: 'setCustomType',
          type: { typeId: 'type', key: 'pierce-loyalty-cart' },
          fields: { loyaltyRedemptionId: 'red-1', loyaltyRedemption: ['D1024', 'D2'] },
        },
      ],
    });
  });

  test('writes with setCustomField when the cart already carries a custom type', async () => {
    const cart = getCartWithCustomerEmail('a@b.c', {
      version: 3,
      custom: { type: { typeId: 'type', id: 'type-id' }, fields: {} },
    });
    let body: unknown;
    server.use(
      http.post(`${API}/${PROJECT}/carts/${cart.id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...cart, version: 4 });
      }),
    );

    await client.write(cart, { redemptionId: 'red-1', denominations: ['D1'] });

    expect(body).toStrictEqual({
      version: 3,
      actions: [
        { action: 'setCustomField', name: 'loyaltyRedemptionId', value: 'red-1' },
        { action: 'setCustomField', name: 'loyaltyRedemption', value: ['D1'] },
      ],
    });
  });

  test('retries once with the fresh version on a 409', async () => {
    const cart = getCartWithCustomerEmail('a@b.c', { version: 3 });
    const versions: number[] = [];
    server.use(
      http.post(`${API}/${PROJECT}/carts/${cart.id}`, async ({ request }) => {
        const body = (await request.json()) as { version: number };
        versions.push(body.version);
        if (body.version === 3) {
          return HttpResponse.json(
            {
              statusCode: 409,
              message: 'stale',
              errors: [{ code: 'ConcurrentModification', message: 'stale', currentVersion: 5 }],
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({ ...cart, version: 6 });
      }),
      http.get(`${API}/${PROJECT}/carts/${cart.id}`, () => HttpResponse.json({ ...cart, version: 5 })),
    );

    const { baseline, updated } = await client.write(cart, { redemptionId: 'red-1', denominations: ['D1'] });

    expect(versions).toStrictEqual([3, 5]);
    // The drop is measured against the cart that was actually updated, not the stale snapshot.
    expect(baseline.version).toBe(5);
    expect(updated.version).toBe(6);
  });

  test('clear leaves a cart alone when it carries a different redemption', async () => {
    const carrying = getCartWithCustomerEmail('a@b.c', {
      version: 7,
      custom: {
        type: { typeId: 'type', id: 'type-id' },
        fields: { loyaltyRedemptionId: 'red-other', loyaltyRedemption: ['D1'] },
      },
    });
    let posts = 0;
    server.use(
      http.post(`${API}/${PROJECT}/carts/${carrying.id}`, () => {
        posts++;
        return HttpResponse.json(carrying);
      }),
    );

    expect(await client.clear(carrying, 'red-1')).toBe(carrying);
    expect(posts).toBe(0);
  });

  /**
   * Between our read and the retry another tab may have written a NEW redemption; clearing that one
   * would leave its hold without a discount. The retry re-reads the id and stands down.
   */
  test('a 409 retry on clear stands down when the fresh cart carries a different redemption', async () => {
    const cart = getCartWithCustomerEmail('a@b.c', {
      version: 3,
      custom: {
        type: { typeId: 'type', id: 'type-id' },
        fields: { loyaltyRedemptionId: 'red-1', loyaltyRedemption: ['D1'] },
      },
    });
    const versions: number[] = [];
    server.use(
      http.post(`${API}/${PROJECT}/carts/${cart.id}`, async ({ request }) => {
        versions.push(((await request.json()) as { version: number }).version);
        return HttpResponse.json(
          {
            statusCode: 409,
            message: 'stale',
            errors: [{ code: 'ConcurrentModification', message: 'stale', currentVersion: 5 }],
          },
          { status: 409 },
        );
      }),
      http.get(`${API}/${PROJECT}/carts/${cart.id}`, () =>
        HttpResponse.json({
          ...cart,
          version: 5,
          custom: {
            type: { typeId: 'type', id: 'type-id' },
            fields: { loyaltyRedemptionId: 'red-new', loyaltyRedemption: ['D2'] },
          },
        }),
      ),
    );

    const result = await client.clear(cart, 'red-1');

    expect(versions).toStrictEqual([3]);
    expect(result.version).toBe(5);
  });

  test('clear unsets both fields and is a no-op on a cart without a custom type', async () => {
    const bare = getCartWithCustomerEmail('a@b.c');
    expect(await client.clear(bare, 'red-1')).toBe(bare);

    const carrying = getCartWithCustomerEmail('a@b.c', {
      version: 7,
      custom: {
        type: { typeId: 'type', id: 'type-id' },
        fields: { loyaltyRedemptionId: 'red-1', loyaltyRedemption: ['D1'] },
      },
    });
    let body: unknown;
    server.use(
      http.post(`${API}/${PROJECT}/carts/${carrying.id}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...carrying, version: 8, custom: { ...carrying.custom, fields: {} } });
      }),
    );

    await client.clear(carrying, 'red-1');

    expect(body).toStrictEqual({
      version: 7,
      actions: [
        { action: 'setCustomField', name: 'loyaltyRedemptionId' },
        { action: 'setCustomField', name: 'loyaltyRedemption' },
      ],
    });
  });
});

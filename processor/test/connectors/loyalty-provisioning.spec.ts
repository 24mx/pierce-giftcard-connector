import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { provisionLoyaltyRedemption } from '../../src/connectors/loyalty-provisioning';
import { denominationKeys } from '../../src/services/denominations';

const AUTH = 'https://auth.test';
const API = 'https://api.test';
const PROJECT = 'test-project';

const OPTS = {
  typeKey: 'pierce-loyalty-cart',
  redemptionIdField: 'loyaltyRedemptionId',
  denominationsField: 'loyaltyRedemption',
  discountKeyPrefix: 'loyalty-',
  stores: [
    { storeKey: 'lu', currency: 'EUR', levels: 18 },
    { storeKey: 'ro', currency: 'RON', levels: 21 },
  ],
  sortOrderBase: '0.000001',
};
const lateBoundFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
const client = () =>
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
const silent = { info: () => undefined };
const notFound = () =>
  HttpResponse.json(
    { statusCode: 404, message: 'not found', errors: [{ code: 'ResourceNotFound', message: 'not found' }] },
    { status: 404 },
  );

describe('loyalty-provisioning', () => {
  const server = setupServer(
    http.post(`${AUTH}/oauth/token`, () =>
      HttpResponse.json({ access_token: 't', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  test("creates the cart type and one store-scoped denomination set per store, sized to that store's levels", async () => {
    const created: { url: string; body: Record<string, unknown> }[] = [];
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, notFound),
      http.post(`${API}/${PROJECT}/types`, async ({ request }) => {
        created.push({ url: 'types', body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: 'type-id', version: 1, key: OPTS.typeKey });
      }),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, notFound),
      http.post(`${API}/${PROJECT}/cart-discounts`, async ({ request }) => {
        created.push({ url: 'cart-discounts', body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: 'd', version: 1 });
      }),
    );

    await provisionLoyaltyRedemption(client(), OPTS, silent);

    const discounts = created.filter((c) => c.url === 'cart-discounts').map((c) => c.body);
    expect(discounts).toHaveLength(18 + 21);

    const lu = discounts.filter((d) => (d.key as string).startsWith('loyalty-lu-'));
    expect(lu).toHaveLength(18);
    expect(lu.map((d) => d.key)).toStrictEqual(denominationKeys(18).map((k) => `loyalty-lu-${k}`));
    expect(lu[9]).toMatchObject({
      key: 'loyalty-lu-D512',
      cartPredicate: 'custom.loyaltyRedemption contains "D512"',
      value: { type: 'absolute', money: [{ currencyCode: 'EUR', centAmount: 512 }] },
      target: { type: 'totalPrice' },
      requiresDiscountCode: false,
      isActive: true,
      stackingMode: 'Stacking',
      sortOrder: '0.00000101101',
      stores: [{ typeId: 'store', key: 'lu' }],
    });

    const ro = discounts.filter((d) => (d.key as string).startsWith('loyalty-ro-'));
    expect(ro).toHaveLength(21);
    expect(ro.map((d) => d.key)).toStrictEqual(denominationKeys(21).map((k) => `loyalty-ro-${k}`));
    expect(ro[20]).toMatchObject({
      key: 'loyalty-ro-D1048576',
      value: { type: 'absolute', money: [{ currencyCode: 'RON', centAmount: 1048576 }] },
      stores: [{ typeId: 'store', key: 'ro' }],
      // sortOrder incorporates the store index to ensure uniqueness project-wide:
      // storeIndex=1 (ro), index=20 → 0.000001 + 02 + 21 + 1 = 0.00000102211
      sortOrder: '0.00000102211',
    });

    // No sortOrder within a single store's own set ends in a trailing zero (commercetools refuses it).
    for (const key of ['lu', 'ro']) {
      const own = discounts.filter((d) => (d.key as string).startsWith(`loyalty-${key}-`));
      expect(new Set(own.map((d) => d.sortOrder)).size).toBe(own.length);
      expect(own.map((d) => d.sortOrder).filter((s) => (s as string).endsWith('0'))).toStrictEqual([]);
    }

    // sortOrder must be unique across ALL stores (commercetools enforces project-wide uniqueness).
    expect(new Set(discounts.map((d) => d.sortOrder)).size).toBe(discounts.length);
  });

  test('updates a discount whose money changed, keeping it scoped to its own store', async () => {
    const updates: { url: string; body: Record<string, unknown> }[] = [];
    const singleStoreOpts = { ...OPTS, stores: [{ storeKey: 'lu', currency: 'EUR', levels: 18 }] };
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'Set', elementType: { name: 'String' } } },
          ],
        }),
      ),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, ({ params }) => {
        const denomination = String(params.key).replace('loyalty-lu-', '');
        const index = denominationKeys(18).indexOf(denomination);
        return HttpResponse.json({
          id: `id-${params.key}`,
          version: 2,
          key: params.key,
          isActive: true,
          sortOrder: `0.00000101${String(index + 1).padStart(2, '0')}1`,
          cartPredicate: `custom.loyaltyRedemption contains "${denomination}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          stores: [{ typeId: 'store', key: 'lu' }],
          value: {
            type: 'absolute',
            money: [{ type: 'centPrecision', currencyCode: 'EUR', centAmount: 999, fractionDigits: 2 }],
          },
        });
      }),
      http.post(`${API}/${PROJECT}/cart-discounts/key=:key`, async ({ request, params }) => {
        updates.push({ url: `cart-discounts/${params.key}`, body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: `id-${params.key}`, version: 3 });
      }),
    );

    await provisionLoyaltyRedemption(client(), singleStoreOpts, silent);

    expect(updates).toHaveLength(18);
    expect(updates[0].body).toMatchObject({
      version: 2,
      actions: [
        { action: 'changeValue', value: { type: 'absolute', money: [{ currencyCode: 'EUR', centAmount: 1 }] } },
      ],
    });
  });

  test('fails loudly when an existing type defines a field with the wrong type', async () => {
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'String' } },
          ],
        }),
      ),
    );

    await expect(provisionLoyaltyRedemption(client(), OPTS, silent)).rejects.toThrow(/loyaltyRedemption.*Set/);
  });

  test('changes nothing when the project already matches', async () => {
    const posts: string[] = [];
    const singleStoreOpts = { ...OPTS, stores: [{ storeKey: 'lu', currency: 'EUR', levels: 18 }] };
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'Set', elementType: { name: 'String' } } },
          ],
        }),
      ),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, ({ params }) => {
        const denomination = String(params.key).replace('loyalty-lu-', '');
        const index = denominationKeys(18).indexOf(denomination);
        const cents = Number(denomination.replace('D', ''));
        return HttpResponse.json({
          id: 'x',
          version: 1,
          key: params.key,
          isActive: true,
          sortOrder: `0.00000101${String(index + 1).padStart(2, '0')}1`,
          cartPredicate: `custom.loyaltyRedemption contains "${denomination}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          stores: [{ typeId: 'store', key: 'lu' }],
          value: {
            type: 'absolute',
            money: [{ type: 'centPrecision', currencyCode: 'EUR', centAmount: cents, fractionDigits: 2 }],
          },
        });
      }),
      http.post(`${API}/${PROJECT}/*`, ({ request }) => {
        posts.push(request.url);
        return HttpResponse.json({});
      }),
    );

    await provisionLoyaltyRedemption(client(), singleStoreOpts, silent);

    expect(posts).toStrictEqual([]);
  });
});

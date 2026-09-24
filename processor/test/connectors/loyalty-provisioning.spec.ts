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
  currencies: ['EUR', 'SEK'],
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

  test('creates the cart type and all 18 denomination discounts on an empty project', async () => {
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

    const type = created.find((c) => c.url === 'types')!.body;
    expect(type).toMatchObject({
      key: 'pierce-loyalty-cart',
      resourceTypeIds: ['order'],
      fieldDefinitions: [
        { name: 'loyaltyRedemptionId', type: { name: 'String' }, required: false },
        { name: 'loyaltyRedemption', type: { name: 'Set', elementType: { name: 'String' } }, required: false },
      ],
    });
    const discounts = created.filter((c) => c.url === 'cart-discounts').map((c) => c.body);
    expect(discounts).toHaveLength(18);
    expect(discounts.map((d) => d.key)).toStrictEqual(denominationKeys().map((k) => `loyalty-${k}`));
    expect(discounts[9]).toMatchObject({
      key: 'loyalty-D512',
      cartPredicate: 'custom.loyaltyRedemption contains "D512"',
      value: {
        type: 'absolute',
        money: [
          { currencyCode: 'EUR', centAmount: 512 },
          { currencyCode: 'SEK', centAmount: 512 },
        ],
      },
      target: { type: 'totalPrice' },
      requiresDiscountCode: false,
      isActive: true,
      stackingMode: 'Stacking',
      sortOrder: '0.00000110',
    });
    expect(new Set(discounts.map((d) => d.sortOrder)).size).toBe(18);
  });

  test('extends an existing type with the missing field and updates a discount whose currencies changed', async () => {
    const updates: { url: string; body: Record<string, unknown> }[] = [];
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [{ name: 'loyaltyRedemptionId', type: { name: 'String' } }],
        }),
      ),
      http.post(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, async ({ request }) => {
        updates.push({ url: 'types', body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: 'type-id', version: 5 });
      }),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, ({ params }) =>
        HttpResponse.json({
          id: `id-${params.key}`,
          version: 2,
          key: params.key,
          isActive: true,
          cartPredicate: `custom.loyaltyRedemption contains "${String(params.key).replace('loyalty-', '')}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          value: {
            type: 'absolute',
            money: [{ type: 'centPrecision', currencyCode: 'EUR', centAmount: 1, fractionDigits: 2 }],
          },
        }),
      ),
      http.post(`${API}/${PROJECT}/cart-discounts/key=:key`, async ({ request, params }) => {
        updates.push({ url: `cart-discounts/${params.key}`, body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: `id-${params.key}`, version: 3 });
      }),
    );

    await provisionLoyaltyRedemption(client(), OPTS, silent);

    expect(updates.find((u) => u.url === 'types')!.body).toStrictEqual({
      version: 4,
      actions: [
        {
          action: 'addFieldDefinition',
          fieldDefinition: {
            name: 'loyaltyRedemption',
            label: { en: 'Loyalty discount denominations' },
            required: false,
            type: { name: 'Set', elementType: { name: 'String' } },
          },
        },
      ],
    });
    // Every discount's money list is EUR-only in the project but EUR+SEK is wanted: 18 changeValue updates.
    const discountUpdates = updates.filter((u) => u.url.startsWith('cart-discounts/'));
    expect(discountUpdates).toHaveLength(18);
    expect(discountUpdates[0].body).toMatchObject({
      version: 2,
      actions: [
        {
          action: 'changeValue',
          value: {
            type: 'absolute',
            money: [
              { currencyCode: 'EUR', centAmount: 1 },
              { currencyCode: 'SEK', centAmount: 1 },
            ],
          },
        },
      ],
    });
  });

  /**
   * A discount provisioned earlier with another field name, target or stacking mode exists by key
   * but never applies; reporting success would leave every redeem answering DiscountNotApplied.
   */
  test('converges predicate, target, stacking and code requirement on an existing discount', async () => {
    const updates: Record<string, unknown>[] = [];
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
        const cents = Number(String(params.key).replace('loyalty-D', ''));
        return HttpResponse.json({
          id: 'x',
          version: 1,
          key: params.key,
          isActive: true,
          cartPredicate: `custom.oldField contains "D${cents}"`,
          target: { type: 'lineItems', predicate: '1=1' },
          stackingMode: 'StopAfterThisDiscount',
          requiresDiscountCode: true,
          value: {
            type: 'absolute',
            money: OPTS.currencies.map((c) => ({
              type: 'centPrecision',
              currencyCode: c,
              centAmount: cents,
              fractionDigits: 2,
            })),
          },
        });
      }),
      http.post(`${API}/${PROJECT}/cart-discounts/key=:key`, async ({ request }) => {
        updates.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 'x', version: 2 });
      }),
    );

    await provisionLoyaltyRedemption(client(), OPTS, silent);

    expect(updates).toHaveLength(18);
    expect(updates[0]).toStrictEqual({
      version: 1,
      actions: [
        { action: 'changeCartPredicate', cartPredicate: 'custom.loyaltyRedemption contains "D1"' },
        { action: 'changeTarget', target: { type: 'totalPrice' } },
        { action: 'changeStackingMode', stackingMode: 'Stacking' },
        { action: 'changeRequiresDiscountCode', requiresDiscountCode: false },
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
        const cents = Number(String(params.key).replace('loyalty-D', ''));
        return HttpResponse.json({
          id: 'x',
          version: 1,
          key: params.key,
          isActive: true,
          cartPredicate: `custom.loyaltyRedemption contains "D${cents}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          value: {
            type: 'absolute',
            money: OPTS.currencies.map((c) => ({
              type: 'centPrecision',
              currencyCode: c,
              centAmount: cents,
              fractionDigits: 2,
            })),
          },
        });
      }),
      http.post(`${API}/${PROJECT}/*`, ({ request }) => {
        posts.push(request.url);
        return HttpResponse.json({});
      }),
    );

    await provisionLoyaltyRedemption(client(), OPTS, silent);

    expect(posts).toStrictEqual([]);
  });
});

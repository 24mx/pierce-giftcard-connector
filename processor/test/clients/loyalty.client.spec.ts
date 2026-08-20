import { describe, test, expect, afterEach, beforeAll, afterAll } from '@jest/globals';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { LoyaltyClient } from '../../src/clients/loyalty.client';
import { LoyaltyApiError } from '../../src/errors/loyalty-api.error';

const LOYALTY_URL = 'https://loyalty.test';

describe('loyalty.client', () => {
  const mockServer = setupServer();

  const client = new LoyaltyClient({ baseUrl: LOYALTY_URL, timeoutMs: 5000 });

  beforeAll(() => {
    mockServer.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    mockServer.resetHandlers();
  });

  afterAll(() => {
    mockServer.close();
  });

  describe('balance', () => {
    test('requests the spendable balance for the given user and currency', async () => {
      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            userId: 'demo@example.com',
            points: 2600,
            amount: { centAmount: 2600, currencyCode: 'EUR' },
            rateToEur: 1,
          });
        }),
      );

      const result = await client.balance({ userId: 'demo@example.com', currencyCode: 'EUR' });

      expect(receivedUrl?.searchParams.get('userId')).toStrictEqual('demo@example.com');
      expect(receivedUrl?.searchParams.get('currency')).toStrictEqual('EUR');
      // Naming no cart leaves both cart parameters off the wire entirely: the backend answers a
      // partial pair with a 400, and reads their absence as "no cap wanted".
      expect(receivedUrl?.searchParams.has('cartId')).toBe(false);
      expect(receivedUrl?.searchParams.has('cartTotal')).toBe(false);
      expect(result).toStrictEqual({
        userId: 'demo@example.com',
        points: 2600,
        amount: { centAmount: 2600, currencyCode: 'EUR' },
        rateToEur: 1,
      });
    });

    test('names the cart when one is given, so the answer carries its cap', async () => {
      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            userId: 'demo@example.com',
            points: 2600,
            amount: { centAmount: 29899, currencyCode: 'SEK' },
            rateToEur: 11.499937,
            cap: { maxPoints: 350, maxCents: 4024 },
          });
        }),
      );

      const result = await client.balance({
        userId: 'demo@example.com',
        currencyCode: 'SEK',
        cartId: 'cart-1',
        cartTotal: 5175,
      });

      expect(receivedUrl?.searchParams.get('cartId')).toStrictEqual('cart-1');
      expect(receivedUrl?.searchParams.get('cartTotal')).toStrictEqual('5175');
      expect(receivedUrl?.searchParams.get('currency')).toStrictEqual('SEK');
      expect(result.cap).toStrictEqual({ maxPoints: 350, maxCents: 4024 });
    });

    test('throws a LoyaltyApiError carrying status and backend message on 400', async () => {
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, () =>
          HttpResponse.json({ error: 'unsupported currency: USD' }, { status: 400 }),
        ),
      );

      const result = client.balance({ userId: 'demo@example.com', currencyCode: 'USD' });

      await expect(result).rejects.toThrow(LoyaltyApiError);
      await expect(result).rejects.toMatchObject({
        status: 400,
        message: 'unsupported currency: USD',
      });
    });

    test('throws a LoyaltyApiError with status 0 when the backend is unreachable', async () => {
      mockServer.use(http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, () => HttpResponse.error()));

      const result = client.balance({ userId: 'demo@example.com', currencyCode: 'EUR' });

      await expect(result).rejects.toThrow(LoyaltyApiError);
      await expect(result).rejects.toMatchObject({ status: 0 });
    });
  });

  describe('authentication', () => {
    test('sends the shared secret on every call when one is configured', async () => {
      const authenticated = new LoyaltyClient({ baseUrl: LOYALTY_URL, timeoutMs: 5000, apiKey: 's3cret' });
      const seen: (string | null)[] = [];
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          seen.push(request.headers.get('x-api-key'));
          return HttpResponse.json({
            userId: 'demo@example.com',
            points: 1,
            amount: { centAmount: 1, currencyCode: 'EUR' },
          });
        }),
        http.post(`${LOYALTY_URL}/loyalty/redemption/void`, ({ request }) => {
          seen.push(request.headers.get('x-api-key'));
          return HttpResponse.json({ paymentId: 'payment-1', points: 1, balance: 1 });
        }),
      );

      await authenticated.balance({ userId: 'demo@example.com', currencyCode: 'EUR' });
      await authenticated.voidHold({ paymentId: 'payment-1' });

      expect(seen).toStrictEqual(['s3cret', 's3cret']);
    });

    test('omits the header when no secret is configured, so an unsecured backend still works', async () => {
      let seen: string | null = 'not-called';
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          seen = request.headers.get('x-api-key');
          return HttpResponse.json({
            userId: 'demo@example.com',
            points: 1,
            amount: { centAmount: 1, currencyCode: 'EUR' },
          });
        }),
      );

      await client.balance({ userId: 'demo@example.com', currencyCode: 'EUR' });

      expect(seen).toBeNull();
    });
  });

  describe('hold', () => {
    test('posts the hold keyed by payment and cart', async () => {
      let receivedBody: unknown;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          receivedBody = await request.json();
          return HttpResponse.json({ paymentId: 'payment-1', points: 2400, balance: 200 });
        }),
      );

      const result = await client.hold({
        userId: 'demo@example.com',
        paymentId: 'payment-1',
        cartId: 'cart-1',
        amount: { centAmount: 2400, currencyCode: 'EUR' },
        cartTotal: { centAmount: 4499, currencyCode: 'EUR' },
      });

      // cartTotal travels with every hold: the backend measures the EUR 1 card floor against it, so
      // the rule lives in the ledger rather than only in this connector's arithmetic.
      expect(receivedBody).toStrictEqual({
        userId: 'demo@example.com',
        paymentId: 'payment-1',
        cartId: 'cart-1',
        amount: { centAmount: 2400, currencyCode: 'EUR' },
        cartTotal: { centAmount: 4499, currencyCode: 'EUR' },
      });
      expect(result).toStrictEqual({ paymentId: 'payment-1', points: 2400, balance: 200 });
    });

    test('throws a LoyaltyApiError with status 409 when the points are not sufficient', async () => {
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () =>
          HttpResponse.json({ error: 'not enough spendable points' }, { status: 409 }),
        ),
      );

      const result = client.hold({
        userId: 'demo@example.com',
        paymentId: 'payment-1',
        cartId: 'cart-1',
        amount: { centAmount: 999999, currencyCode: 'EUR' },
      });

      await expect(result).rejects.toThrow(LoyaltyApiError);
      await expect(result).rejects.toMatchObject({
        status: 409,
        message: 'not enough spendable points',
      });
    });
  });

  describe('voidHold', () => {
    test('posts the payment id so the hold stops withholding points now', async () => {
      let receivedBody: unknown;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/void`, async ({ request }) => {
          receivedBody = await request.json();
          return HttpResponse.json({ paymentId: 'payment-1', points: 2400, balance: 2600 });
        }),
      );

      const result = await client.voidHold({ paymentId: 'payment-1' });

      expect(receivedBody).toStrictEqual({ paymentId: 'payment-1' });
      expect(result).toStrictEqual({ paymentId: 'payment-1', points: 2400, balance: 2600 });
    });

    test('throws a LoyaltyApiError with status 404 for an unknown payment', async () => {
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/void`, () =>
          HttpResponse.json({ error: 'unknown payment' }, { status: 404 }),
        ),
      );

      const result = client.voidHold({ paymentId: 'payment-unknown' });

      await expect(result).rejects.toThrow(LoyaltyApiError);
      await expect(result).rejects.toMatchObject({ status: 404 });
    });
  });
});

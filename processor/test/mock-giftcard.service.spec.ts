import { describe, test, expect, afterEach, jest, beforeEach, beforeAll } from '@jest/globals';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { paymentSDK } from '../src/payment-sdk';
import { MockGiftCardService, MockGiftCardServiceOptions } from '../src/services/mock-giftcard.service';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service';

import { MockCustomError } from '../src/errors/mock-api.error';
import * as Config from '../src/config/config';
import { ModifyPayment, StatusResponse } from '../src/services/types/operation.type';
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler';
import {
  createPaymentResultOk,
  getCartOK,
  getCartWithCustomerEmail,
  getPaymentResultOk,
  openGiftCardPaymentFixture,
  updatePaymentResultOk,
} from './mocks/coco';

import { HealthCheckResult } from '@commercetools/connect-payments-sdk';
import { AbstractGiftCardService } from '../src/services/abstract-giftcard.service';
import { log } from '../src/libs/logger';

interface FlexibleConfig {
  [key: string]: string | number | boolean | undefined; // Adjust the type according to your config values
}

function setupMockConfig(keysAndValues: Record<string, string | number | boolean>) {
  const mockConfig: FlexibleConfig = {};
  Object.keys(keysAndValues).forEach((key) => {
    mockConfig[key] = keysAndValues[key];
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(Config, 'getConfig').mockReturnValue(mockConfig as any);
  jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(getCartOK());
}

const LOYALTY_URL = 'https://loyalty.test';

describe('mock-giftcard.service', () => {
  const mockServer = setupServer();
  const opts: MockGiftCardServiceOptions = {
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
    ctOrderService: paymentSDK.ctOrderService,
  };

  const mockGiftCardService: AbstractGiftCardService = new MockGiftCardService(opts);

  beforeAll(() => {
    mockServer.listen({
      onUnhandledRequest: 'bypass',
    });
  });

  beforeEach(() => {
    jest.setTimeout(10000);
    jest.resetAllMocks();
  });

  afterEach(() => {
    mockServer.resetHandlers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('getStatus reports the loyalty backend configuration alongside the CoCo permissions', async () => {
    setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000 });
    const mockHealthCheckFunction: () => Promise<HealthCheckResult> = async () => {
      const result: HealthCheckResult = {
        name: 'CoCo Permissions',
        status: 'DOWN',
        message: 'CoCo Permissions are not available',
        details: {},
      };
      return result;
    };

    jest.spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions').mockReturnValue(mockHealthCheckFunction);
    const result: StatusResponse = await mockGiftCardService.status();

    expect(result?.status).toBeDefined();
    expect(result?.checks).toHaveLength(2);
    expect(result?.status).toStrictEqual('Partially Available');
    expect(result?.checks[0]?.name).toStrictEqual('CoCo Permissions');
    expect(result?.checks[0]?.status).toStrictEqual('DOWN');
    expect(result?.checks[0]?.details).toStrictEqual({});
    expect(result?.checks[0]?.message).toBeDefined();
    expect(result?.checks[1]?.name).toStrictEqual('Loyalty API configuration');
    expect(result?.checks[1]?.status).toStrictEqual('UP');
    expect(result?.checks[1]?.details).toBeDefined();
    expect(result?.checks[1]?.message).toBeUndefined();
  });

  test('getStatus makes an unauthenticated loyalty connection visible', async () => {
    jest.spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions').mockReturnValue(async () => ({
      name: 'CoCo Permissions',
      status: 'UP',
      details: {},
    }));

    setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000, loyaltyApiKey: 'a-secret' });
    const secured: StatusResponse = await mockGiftCardService.status();
    expect(secured?.checks[1]?.details).toMatchObject({ authenticated: true });

    setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000, loyaltyApiKey: '' });
    const unsecured: StatusResponse = await mockGiftCardService.status();
    expect(unsecured?.checks[1]?.details).toMatchObject({ authenticated: false });
  });

  test('getStatus reports DOWN when the loyalty backend URL is not configured', async () => {
    setupMockConfig({ loyaltyApiUrl: '', loyaltyTimeoutMs: 5000 });
    jest.spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions').mockReturnValue(async () => ({
      name: 'CoCo Permissions',
      status: 'UP',
      details: {},
    }));

    const result: StatusResponse = await mockGiftCardService.status();

    expect(result?.checks[1]?.name).toStrictEqual('Loyalty API configuration');
    expect(result?.checks[1]?.status).toStrictEqual('DOWN');
    expect(result?.checks[1]?.message).toBeDefined();
  });

  describe('balance', () => {
    const setupLoyaltyConfig = () => {
      // no currency key on purpose: balance() takes the currency from the cart
      setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000 });
    };

    // One call now carries the spendable balance AND the cart's cap, so every mock owes the whole
    // shape - the connector always names a cart, so the cap is never legitimately absent.
    const balanceBody = (overrides: Record<string, unknown> = {}) => ({
      userId: 'demo@example.com',
      points: 2600,
      amount: { centAmount: 2600, currencyCode: 'EUR' },
      rateToEur: 1,
      cap: { maxPoints: 2600, maxCents: 2600 },
      openHoldPoints: 0,
      ...overrides,
    });

    test('asks the loyalty backend for the spendable points of the cart customer, in the cart currency', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('Demo@Example.COM'));

      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      // the widget's code field is not an identity input - the cart customer is
      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(receivedUrl?.searchParams.get('userId')).toStrictEqual('demo@example.com');
      expect(receivedUrl?.searchParams.get('currency')).toStrictEqual('EUR');
      expect(result).toStrictEqual({
        status: { state: 'Valid' },
        amount: { centAmount: 2600, currencyCode: 'EUR' },
        points: 2600,
        openRedemptionId: null,
        maxPoints: 2600,
        rate: 1,
        openRedemptionPoints: 0,
      });
    });

    test('asks for the cart cap in the same call and reports it', async () => {
      setupLoyaltyConfig();
      const cart = getCartWithCustomerEmail('demo@example.com');
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);

      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json(balanceBody({ rateToEur: 4.970006, cap: { maxPoints: 100, maxCents: 497 } }));
        }),
      );

      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(receivedUrl?.searchParams.get('userId')).toStrictEqual('demo@example.com');
      expect(receivedUrl?.searchParams.get('cartId')).toStrictEqual(cart.id);
      expect(receivedUrl?.searchParams.get('currency')).toStrictEqual('EUR');
      // spendable is not surfaced separately - `points` already reports it.
      expect(result).toMatchObject({ maxPoints: 100, rate: 4.970006 });
    });

    // The backend already knows how much of this cart's own reservation is committed - see
    // GiftcardHoldService.quote in the loyalty backend - this just reports that number alongside
    // the cap, the same way openRedemptionId already reports which reservation is open.
    test('reports how many points an already-open reservation on this cart covers', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () =>
          HttpResponse.json(balanceBody({ openHoldPoints: 200 })),
        ),
      );

      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(result.openRedemptionPoints).toStrictEqual(200);
    });

    // Degrades to null (not 0, and not a throw) against a loyalty backend that hasn't shipped
    // openHoldPoints yet - same fail-closed treatment maxPoints/rate got before the backend
    // reported those.
    test('reports openRedemptionPoints null when the backend answers without openHoldPoints', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const bodyWithoutOpenHoldPoints = balanceBody();
      delete (bodyWithoutOpenHoldPoints as Record<string, unknown>).openHoldPoints;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () => HttpResponse.json(bodyWithoutOpenHoldPoints)),
      );

      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(result.openRedemptionPoints).toBeNull();
    });

    // getPaymentAmount prefers taxedPrice.totalGross and subtracts what is already paid; totalPrice
    // is neither. Measuring the cap against the raw total would offer points against money the
    // shopper is not being asked for, and hold() would then refuse the maximum the slider showed.
    test('measures the cap against the amount actually payable, not the raw cart total', async () => {
      setupLoyaltyConfig();
      const cart = getCartWithCustomerEmail('demo@example.com', {
        taxedPrice: {
          totalNet: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 4999, fractionDigits: 2 },
          totalGross: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 6150, fractionDigits: 2 },
          taxPortions: [],
        },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);

      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      await mockGiftCardService.balance('code-from-the-widget');

      expect(receivedUrl?.searchParams.get('cartTotal')).toStrictEqual('6150');
      expect(receivedUrl?.searchParams.get('cartId')).toStrictEqual(cart.id);
    });

    // The connector always names a cart, so an answer without a cap is the backend breaking its
    // contract - not a shopper with nothing left to redeem. Reporting 0 would make those two
    // indistinguishable, which is the ambiguity that merging the two calls set out to remove.
    test('fails when the backend answers without a cap', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () =>
          HttpResponse.json({
            userId: 'demo@example.com',
            points: 2600,
            amount: { centAmount: 2600, currencyCode: 'EUR' },
            rateToEur: 1,
          }),
        ),
      );

      const result = mockGiftCardService.balance('code-from-the-widget');

      await expect(result).rejects.toThrow(MockCustomError);
    });

    test('reports the id of an already-open giftcard payment on the cart', async () => {
      setupLoyaltyConfig();
      const openPayment = openGiftCardPaymentFixture({ id: 'already-open-giftcard-payment' });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(
        getCartWithCustomerEmail('demo@example.com', {
          paymentInfo: { payments: [{ typeId: 'payment', id: openPayment.id, obj: openPayment }] },
        }),
      );
      // getPaymentAmount's real SDK implementation would otherwise fetch each attached payment by
      // id from the live commercetools API to net out what is already paid - irrelevant to what
      // this test is checking, so it is stubbed directly instead of mocking that network call.
      jest
        .spyOn(DefaultCartService.prototype, 'getPaymentAmount')
        .mockResolvedValue({ currencyCode: 'EUR', centAmount: 4999, fractionDigits: 2 });
      mockServer.use(http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () => HttpResponse.json(balanceBody())));

      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(result.openRedemptionId).toStrictEqual('already-open-giftcard-payment');
    });

    test('reports openRedemptionId null when the cart only carries an already-refunded giftcard payment', async () => {
      setupLoyaltyConfig();
      const refundedPayment = openGiftCardPaymentFixture({
        id: 'refunded-giftcard-payment',
        transactions: [
          {
            id: 'REFUND_TXN',
            type: 'Refund',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'REFUND_TXN',
            state: 'Success',
          },
        ],
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(
        getCartWithCustomerEmail('demo@example.com', {
          paymentInfo: { payments: [{ typeId: 'payment', id: refundedPayment.id, obj: refundedPayment }] },
        }),
      );
      jest
        .spyOn(DefaultCartService.prototype, 'getPaymentAmount')
        .mockResolvedValue({ currencyCode: 'EUR', centAmount: 4999, fractionDigits: 2 });
      mockServer.use(http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () => HttpResponse.json(balanceBody())));

      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(result.openRedemptionId).toBeNull();
    });

    // The checkout SDK spends min(reported balance, cart total), so reporting the whole balance is
    // what makes every checkout spend everything the shopper has. Capping the report is the only
    // lever the connector has over how much goes: there is no amount input anywhere in the flow,
    // and redeem is handed an amount the SDK derived from this very number.
    test.each([
      ['Valid-1000-EUR', 1000, 'caps the report at the amount the code asks for'],
      ['valid-1000-eur', 1000, 'reads the amount regardless of case'],
      ['Valid-9900-EUR', 2600, 'never reports more than the shopper actually has'],
      ['Valid-1000-USD', 2600, 'ignores an amount denominated in another currency'],
      ['gift-card-please', 2600, 'ignores a code carrying no amount at all'],
    ])('%s -> %d cents: %s', async (code, expectedCents) => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      mockServer.use(http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () => HttpResponse.json(balanceBody())));

      const result = await mockGiftCardService.balance(code);

      expect(result).toStrictEqual({
        status: { state: 'Valid' },
        amount: { centAmount: expectedCents, currencyCode: 'EUR' },
        points: 2600,
        openRedemptionId: null,
        maxPoints: 2600,
        rate: 1,
        openRedemptionPoints: 0,
      });
    });

    test('throws CurrencyNotMatch when the backend rejects the cart currency', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () =>
          HttpResponse.json({ error: 'unsupported currency: USD' }, { status: 400 }),
        ),
      );

      const result = mockGiftCardService.balance('code-from-the-widget');

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'CurrencyNotMatch', httpErrorStatus: 400 });
    });

    test('throws when the cart carries no customer email, since there is no loyalty identity', async () => {
      setupLoyaltyConfig();
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(getCartOK({ customerEmail: undefined }));

      const result = mockGiftCardService.balance('code-from-the-widget');

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'CustomerNotIdentified' });
    });

    test('fails the balance check when the loyalty backend errors', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
      );

      const result = mockGiftCardService.balance('code-from-the-widget');

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'GenericError', httpErrorStatus: 500 });
    });
  });

  describe('redeem', () => {
    const setupLoyaltyConfig = () => setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000 });

    const redeemOpts = {
      data: {
        code: 'code-from-the-widget',
        redeemAmount: { centAmount: 2400, currencyCode: 'EUR' },
      },
    };

    // getPaymentAmount() nets the cart total against every other payment already on the cart - real
    // work these tests are not about, so they pin it back to "nothing else has been paid yet"
    // (the cart's own total), matching what they asserted before that call existed.
    const mockStillOwedFullTotal = (totalPrice: { centAmount: number; currencyCode: string; fractionDigits: number }) =>
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(totalPrice);

    test('holds the points before writing the transaction that covers the cart', async () => {
      setupLoyaltyConfig();
      const cart = getCartWithCustomerEmail('Demo@Example.COM');
      const callOrder: string[] = [];

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(async () => {
        callOrder.push('updatePayment');
        return updatePaymentResultOk;
      });

      let holdBody: unknown;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async ({ request }) => {
          callOrder.push('hold');
          holdBody = await request.json();
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
      );

      const result = await mockGiftCardService.redeem(redeemOpts);

      expect(callOrder).toStrictEqual(['hold', 'updatePayment']);
      // cartTotal comes off the cart we have already read: the backend needs it to enforce the EUR 1
      // card floor itself instead of trusting whatever amount this connector was handed.
      expect(holdBody).toStrictEqual({
        userId: 'demo@example.com',
        paymentId: createPaymentResultOk.id,
        cartId: cart.id,
        amount: { centAmount: 2400, currencyCode: 'EUR' },
        cartTotal: { centAmount: cart.totalPrice.centAmount, currencyCode: cart.totalPrice.currencyCode },
      });
      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
        points: 2400,
      });
    });

    test('measures the hold floor against the amount actually still owed, not the raw cart total', async () => {
      setupLoyaltyConfig();
      const cardPayment = {
        ...getPaymentResultOk,
        id: 'card-payment-already-charged',
        amountPlanned: { type: 'centPrecision' as const, currencyCode: 'EUR', centAmount: 4000, fractionDigits: 2 },
        transactions: [
          {
            id: 'CARD_CHARGE',
            type: 'Charge' as const,
            amount: { type: 'centPrecision' as const, currencyCode: 'EUR', centAmount: 4000, fractionDigits: 2 },
            interactionId: 'CARD_INTERACTION',
            state: 'Success' as const,
          },
        ],
      };
      // getCartWithCustomerEmail's totalPrice is 4999 EUR cents; 4000 of that is already
      // Charge/Success via cardPayment, so only 999 cents are actually still owed.
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: cardPayment.id, obj: cardPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);
      jest
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn((paymentSDK.ctCartService as any).ctAPI.payment, 'getPaymentById')
        .mockResolvedValue(cardPayment);

      let holdBody: unknown;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async ({ request }) => {
          holdBody = await request.json();
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 999, balance: 0 });
        }),
      );

      await mockGiftCardService.redeem({
        data: { code: 'code-from-the-widget', redeemAmount: { centAmount: 999, currencyCode: 'EUR' } },
      });

      // Not cart.totalPrice (4999) - the card payment already covers 4000, so only 999 is actually
      // left, and that is the figure the backend's "leave EUR 1 for another payment method" floor
      // must be measured against.
      expect((holdBody as { cartTotal: { centAmount: number; currencyCode: string } }).cartTotal).toStrictEqual({
        centAmount: 999,
        currencyCode: 'EUR',
      });
    });

    test('voids an existing open giftcard payment on the cart before creating a new redemption', async () => {
      setupLoyaltyConfig();
      const stalePayment = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: stalePayment.id, obj: stalePayment }] },
      });
      const callOrder: string[] = [];

      const getCart = jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockImplementation(async (opts) => {
          callOrder.push(`updatePayment:${opts.id}:${opts.transaction.type}`);
          return updatePaymentResultOk;
        });

      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async () => {
          callOrder.push('void');
          return HttpResponse.json({ paymentId: stalePayment.id, points: 2000, balance: 2000 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async () => {
          callOrder.push('hold');
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(getCart).toHaveBeenCalledWith(expect.objectContaining({ expand: ['paymentInfo.payments[*]'] }));
      expect(callOrder).toStrictEqual([
        `updatePayment:${stalePayment.id}:Refund`,
        'void',
        'hold',
        `updatePayment:${createPaymentResultOk.id}:Charge`,
      ]);
      expect(updatePayment).toHaveBeenCalledWith({
        id: stalePayment.id,
        transaction: { type: 'Refund', amount: stalePayment.amountPlanned, state: 'Success' },
      });
    });

    test('voids every stale open giftcard payment when the cart carries more than one', async () => {
      setupLoyaltyConfig();
      const stalePayment1 = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment-1' });
      const stalePayment2 = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment-2' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: {
          payments: [
            { typeId: 'payment', id: stalePayment1.id, obj: stalePayment1 },
            { typeId: 'payment', id: stalePayment2.id, obj: stalePayment2 },
          ],
        },
      });
      const callOrder: string[] = [];

      const getCart = jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockImplementation(async (opts) => {
          callOrder.push(`updatePayment:${opts.id}:${opts.transaction.type}`);
          return updatePaymentResultOk;
        });

      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async ({ request }) => {
          const body = (await request.json()) as { paymentId: string };
          callOrder.push(`void:${body.paymentId}`);
          return HttpResponse.json({ paymentId: body.paymentId, points: 2000, balance: 2000 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async () => {
          callOrder.push('hold');
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(getCart).toHaveBeenCalledWith(expect.objectContaining({ expand: ['paymentInfo.payments[*]'] }));
      expect(callOrder).toStrictEqual([
        `updatePayment:${stalePayment1.id}:Refund`,
        `void:${stalePayment1.id}`,
        `updatePayment:${stalePayment2.id}:Refund`,
        `void:${stalePayment2.id}`,
        'hold',
        `updatePayment:${createPaymentResultOk.id}:Charge`,
      ]);
      expect(updatePayment).toHaveBeenCalledWith({
        id: stalePayment1.id,
        transaction: { type: 'Refund', amount: stalePayment1.amountPlanned, state: 'Success' },
      });
      expect(updatePayment).toHaveBeenCalledWith({
        id: stalePayment2.id,
        transaction: { type: 'Refund', amount: stalePayment2.amountPlanned, state: 'Success' },
      });
    });

    test('writes a Charge transaction for the held amount', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(getCartOK());
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: {
          type: 'Charge',
          amount: createPaymentResultOk.amountPlanned,
          state: 'Success',
        },
      });
    });

    test('does not re-void a giftcard payment that already has a successful Refund transaction', async () => {
      setupLoyaltyConfig();
      const alreadyVoidedPayment = openGiftCardPaymentFixture({
        id: 'already-voided-payment',
        transactions: [
          {
            id: 'TXN_CHARGE',
            type: 'Charge',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
          {
            id: 'TXN_REFUND',
            type: 'Refund',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
        ],
      });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: alreadyVoidedPayment.id, obj: alreadyVoidedPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(updatePayment).toHaveBeenCalledTimes(1);
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: { type: 'Charge', amount: createPaymentResultOk.amountPlanned, state: 'Success' },
      });
    });

    test('does not touch a non-giftcard payment already on the cart', async () => {
      setupLoyaltyConfig();
      const cardPayment = { ...getPaymentResultOk, id: 'existing-card-payment' };
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: cardPayment.id, obj: cardPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(updatePayment).toHaveBeenCalledTimes(1);
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: { type: 'Charge', amount: createPaymentResultOk.amountPlanned, state: 'Success' },
      });
    });

    test('still creates the new redemption when releasing the stale hold fails', async () => {
      setupLoyaltyConfig();
      const stalePayment = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: stalePayment.id, obj: stalePayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () => HttpResponse.error()),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      const result = await mockGiftCardService.redeem(redeemOpts);

      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
        points: 2400,
      });
    });

    // Temporary workaround (GIFTCARD_ZERO_CT_COVERAGE, see .env.template): Briqpay's own /config
    // step recomputes VAT from the cart's undiscounted lines and rejects whenever this Payment
    // already reduces what Checkout asks it to cover. Zeroing the CT-side amount removes this
    // Payment from Checkout's coverage math without touching the real loyalty hold below, so the
    // card leg is asked for the full total again and Briqpay's own recompute matches it.
    test('zeroes the CT coverage amount but still holds the real amount, when GIFTCARD_ZERO_CT_COVERAGE is set', async () => {
      setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000, giftcardZeroCtCoverage: true });
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      jest
        .spyOn(DefaultPaymentService.prototype, 'createPayment')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (opts: any) => ({ ...createPaymentResultOk, amountPlanned: opts.amountPlanned }));
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(getCartOK());
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);

      let holdBody: unknown;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async ({ request }) => {
          holdBody = await request.json();
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(holdBody).toMatchObject({ amount: { centAmount: 2400, currencyCode: 'EUR' } });
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: {
          type: 'Charge',
          amount: { centAmount: 0, currencyCode: 'EUR' },
          state: 'Success',
        },
      });
    });

    test('voids the conflicting hold named by a 409 and retries once', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      // The conflicting payment's id must be in OUR OWN cart snapshot for the revert-and-retry gate
      // to allow the revert - only the id matters for that check (no `.obj` here), so
      // voidStaleGiftCardPayments (which needs the expanded `.obj` to act) does not touch it upfront,
      // keeping this test focused on the conflict-retry mechanic. See the concurrent-request test
      // below for the case where the id is NOT in our snapshot at all, which must NOT be reverted.
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: conflictingPayment.id }] },
      });
      const callOrder: string[] = [];

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(conflictingPayment);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(async (opts) => {
        callOrder.push(`updatePayment:${opts.id}:${opts.transaction.type}`);
        return updatePaymentResultOk;
      });

      let holdCalls = 0;
      const holdBodies: unknown[] = [];
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async ({ request }) => {
          holdCalls += 1;
          callOrder.push(`hold${holdCalls}`);
          holdBodies.push(await request.json());
          if (holdCalls === 1) {
            return HttpResponse.json(
              { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
              { status: 409 },
            );
          }
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async () => {
          callOrder.push('void');
          return HttpResponse.json({ paymentId: conflictingPayment.id, points: 2000, balance: 2000 });
        }),
      );

      const result = await mockGiftCardService.redeem(redeemOpts);

      expect(callOrder).toStrictEqual([
        'hold1',
        `updatePayment:${conflictingPayment.id}:Refund`,
        'void',
        'hold2',
        `updatePayment:${createPaymentResultOk.id}:Charge`,
      ]);
      // The retried hold reuses the exact same hoisted holdRequest - nothing was recomputed or
      // mutated between the first attempt and the retry.
      expect(holdBodies[1]).toStrictEqual(holdBodies[0]);
      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
        points: 2400,
      });
    });

    test('does not revert a conflicting payment that was never in our own cart snapshot, since it must belong to a genuinely concurrent redeem() call', async () => {
      setupLoyaltyConfig();
      // The cart snapshot THIS redeem() call read carries no paymentInfo at all - the named
      // existingPaymentId is not, and cannot be, one of ours. The only way it can exist is another
      // redeem() call that created it after we took our snapshot, and whose hold is currently
      // succeeding - reverting it would undo somebody else's legitimate redemption.
      const concurrentlyCreatedPayment = openGiftCardPaymentFixture({ id: 'concurrent-other-tab-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com');

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      const getPayment = jest.spyOn(DefaultPaymentService.prototype, 'getPayment');
      const updatePayment = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment');

      let holdCalls = 0;
      let voidCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          return HttpResponse.json(
            { error: 'cart already has an open reservation', existingPaymentId: concurrentlyCreatedPayment.id },
            { status: 409 },
          );
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () => {
          voidCalls += 1;
          return HttpResponse.json({ paymentId: concurrentlyCreatedPayment.id, points: 2000, balance: 2000 });
        }),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      // Today's toConnectorError mapping for a plain 409 is InsufficientFunds - not accurate to the
      // real cause here, but no more misleading than before this fix, and changing that generic
      // mapping is out of scope for the concurrency gate this test locks in.
      await expect(result).rejects.toMatchObject({ code: 'InsufficientFunds' });
      expect(holdCalls).toBe(1);
      expect(voidCalls).toBe(0);
      expect(getPayment).not.toHaveBeenCalled();
      expect(updatePayment).not.toHaveBeenCalled();
    });

    test('logs and falls back to the original conflict error when getPayment fails inside the conflict-revert path', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      // The id is present in our own cart snapshot, so the gate lets the revert proceed - but with
      // no `.obj`, voidStaleGiftCardPayments does not act on it upfront, so the only relevant call
      // to getPayment is the one inside the conflict-revert path (voidConflictingHold), which fails
      // (e.g. a transient CT 5xx, or the payment was deleted).
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: conflictingPayment.id }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockRejectedValue(new Error('CT is unavailable'));
      const updatePayment = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment');
      const logErrorSpy = jest.spyOn(log, 'error');

      let holdCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          return HttpResponse.json(
            { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
            { status: 409 },
          );
        }),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      // The ORIGINAL conflict's mapping (InsufficientFunds, today's blanket 409 mapping) - not a raw,
      // unmapped exception from getPayment.
      await expect(result).rejects.toMatchObject({ code: 'InsufficientFunds' });
      expect(holdCalls).toBe(1);
      expect(updatePayment).not.toHaveBeenCalled();
      expect(logErrorSpy).toHaveBeenCalledWith(
        'Could not close the conflicting hold; failing the redemption.',
        expect.objectContaining({ paymentId: conflictingPayment.id, action: 'voidOnHoldConflict' }),
      );
    });

    test('maps a repeated conflict on the retried hold to CartAlreadyHeld, not InsufficientFunds', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: conflictingPayment.id, obj: conflictingPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(conflictingPayment);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);

      let holdCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          // Both attempts name the same conflicting payment - a still-conflicting cart on retry,
          // not a balance problem.
          return HttpResponse.json(
            { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
            { status: 409 },
          );
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () =>
          HttpResponse.json({ paymentId: conflictingPayment.id, points: 2000, balance: 2000 }),
        ),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'CartAlreadyHeld', httpErrorStatus: 409 });
      expect(holdCalls).toBe(2);
    });

    test('fails after exactly one retry when the conflict repeats', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      // The id is in our own cart snapshot (gate allows the revert-and-retry to proceed at all), but
      // with no `.obj` so voidStaleGiftCardPayments does not act on it upfront.
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: conflictingPayment.id }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(conflictingPayment);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);

      let holdCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          return HttpResponse.json(
            { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
            { status: 409 },
          );
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () =>
          HttpResponse.json({ paymentId: conflictingPayment.id, points: 2000, balance: 2000 }),
        ),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      expect(holdCalls).toBe(2);
      // Only the Refund on the conflicting payment — no Charge was ever written for a new payment.
      expect(updatePayment).toHaveBeenCalledTimes(1);
    });

    test('does not write a second Refund transaction when the conflicting payment was already reverted', async () => {
      setupLoyaltyConfig();
      const alreadyVoidedPayment = openGiftCardPaymentFixture({
        id: 'already-voided-payment',
        transactions: [
          {
            id: 'TXN_CHARGE',
            type: 'Charge',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
          {
            id: 'TXN_REFUND',
            type: 'Refund',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
        ],
      });
      // Already reverted on CT (a successful Refund is already there), but the loyalty backend still
      // thinks its hold is open - as if a prior voidHold call silently failed - so it is both
      // attached to the cart (voidStaleGiftCardPayments skips it, since it is not "open") and named
      // as the 409's existingPaymentId.
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: alreadyVoidedPayment.id, obj: alreadyVoidedPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      mockStillOwedFullTotal(cart.totalPrice);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(alreadyVoidedPayment);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);

      let holdCalls = 0;
      let voidCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          if (holdCalls === 1) {
            return HttpResponse.json(
              { error: 'cart already has an open reservation', existingPaymentId: alreadyVoidedPayment.id },
              { status: 409 },
            );
          }
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () => {
          voidCalls += 1;
          return HttpResponse.json({ paymentId: alreadyVoidedPayment.id, points: 2000, balance: 2000 });
        }),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(holdCalls).toBe(2);
      expect(voidCalls).toBe(1);
      // The only updatePayment call is the final Charge on the new redemption - no Refund was
      // written again for the already-reverted payment.
      expect(updatePayment).toHaveBeenCalledTimes(1);
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: { type: 'Charge', amount: createPaymentResultOk.amountPlanned, state: 'Success' },
      });
    });

    test('writes no transaction when the points are not sufficient', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(getCartOK());
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ error: 'not enough spendable points' }, { status: 409 }),
        ),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'InsufficientFunds' });
      expect(updatePayment).not.toHaveBeenCalled();
    });

    test('writes no transaction when the hold outcome is uncertain', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(getCartOK());
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => HttpResponse.error()));

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      await expect(result).rejects.toMatchObject({ code: 'GenericError' });
      expect(updatePayment).not.toHaveBeenCalled();
    });
  });

  describe('modifyPayment', () => {
    test('capturePayment', async () => {
      // Given
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 1000,
                currencyCode: 'EUR',
              },
            },
          ],
        },
      };

      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(getPaymentResultOk);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);

      const result = mockGiftCardService.modifyPayment(modifyPaymentOpts);
      await expect(result).rejects.toThrow('operation not supported');
    });

    const setupLoyaltyConfig = () => setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000 });

    const modifyPaymentOptsFor = (action: 'cancelPayment' | 'reversePayment' | 'refundPayment'): ModifyPayment => ({
      paymentId: getPaymentResultOk.id,
      data: {
        actions: [
          {
            action,
            ...(action === 'refundPayment' && { amount: { centAmount: 3000, currencyCode: 'GBP' } }),
          },
        ],
      },
    });

    test.each(['cancelPayment', 'reversePayment', 'refundPayment'] as const)(
      '%s reverts the coverage and then closes the hold',
      async (action) => {
        setupLoyaltyConfig();
        const callOrder: string[] = [];

        jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(getPaymentResultOk);
        const updatePayment = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockImplementation(async () => {
            callOrder.push('updatePayment');
            return updatePaymentResultOk;
          });

        let voidBody: unknown;
        mockServer.use(
          http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async ({ request }) => {
            callOrder.push('void');
            voidBody = await request.json();
            return HttpResponse.json({ paymentId: getPaymentResultOk.id, points: 2400, balance: 2600 });
          }),
        );

        const result = await mockGiftCardService.modifyPayment(modifyPaymentOptsFor(action));

        expect(callOrder).toStrictEqual(['updatePayment', 'void']);
        expect(updatePayment).toHaveBeenCalledWith({
          id: getPaymentResultOk.id,
          transaction: {
            type: 'Refund',
            amount: action === 'refundPayment' ? { centAmount: 3000, currencyCode: 'GBP' } : expect.anything(),
            state: 'Success',
          },
        });
        expect(voidBody).toStrictEqual({ paymentId: getPaymentResultOk.id });
        expect(result?.outcome).toStrictEqual('approved');
      },
    );

    test('cancelPayment reverts the full planned amount', async () => {
      setupLoyaltyConfig();
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(getPaymentResultOk);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () =>
          HttpResponse.json({ paymentId: getPaymentResultOk.id, points: 2400, balance: 2600 }),
        ),
      );

      await mockGiftCardService.modifyPayment(modifyPaymentOptsFor('cancelPayment'));

      expect(updatePayment).toHaveBeenCalledWith({
        id: getPaymentResultOk.id,
        transaction: {
          type: 'Refund',
          amount: getPaymentResultOk.amountPlanned,
          state: 'Success',
        },
      });
    });

    test('succeeds when the hold is already gone, since void is idempotent in effect', async () => {
      setupLoyaltyConfig();
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(getPaymentResultOk);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () =>
          HttpResponse.json({ error: 'unknown payment' }, { status: 404 }),
        ),
      );

      const result = await mockGiftCardService.modifyPayment(modifyPaymentOptsFor('cancelPayment'));

      expect(result?.outcome).toStrictEqual('approved');
    });

    test('succeeds when void fails, because the coverage is already reverted and the hold ages out', async () => {
      setupLoyaltyConfig();
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(getPaymentResultOk);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);
      mockServer.use(http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () => HttpResponse.error()));

      const result = await mockGiftCardService.modifyPayment(modifyPaymentOptsFor('cancelPayment'));

      expect(result?.outcome).toStrictEqual('approved');
    });
  });
});

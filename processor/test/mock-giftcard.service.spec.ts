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
    const setupLoyaltyConfig = () =>
      // no currency key on purpose: balance() takes the currency from the cart
      setupMockConfig({ loyaltyApiUrl: LOYALTY_URL, loyaltyTimeoutMs: 5000 });

    test('asks the loyalty backend for the spendable points of the cart customer, in the cart currency', async () => {
      setupLoyaltyConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('Demo@Example.COM'));

      let receivedUrl: URL | undefined;
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            userId: 'demo@example.com',
            points: 2600,
            amount: { centAmount: 2600, currencyCode: 'EUR' },
          });
        }),
      );

      // the widget's code field is not an identity input - the cart customer is
      const result = await mockGiftCardService.balance('code-from-the-widget');

      expect(receivedUrl?.searchParams.get('userId')).toStrictEqual('demo@example.com');
      expect(receivedUrl?.searchParams.get('currency')).toStrictEqual('EUR');
      expect(result).toStrictEqual({
        status: { state: 'Valid' },
        amount: { centAmount: 2600, currencyCode: 'EUR' },
      });
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
      mockServer.use(
        http.get(`${LOYALTY_URL}/loyalty/giftcard/balance`, () =>
          HttpResponse.json({
            userId: 'demo@example.com',
            points: 2600,
            amount: { centAmount: 2600, currencyCode: 'EUR' },
          }),
        ),
      );

      const result = await mockGiftCardService.balance(code);

      expect(result).toStrictEqual({
        status: { state: 'Valid' },
        amount: { centAmount: expectedCents, currencyCode: 'EUR' },
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

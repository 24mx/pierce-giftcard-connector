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
  updatePaymentResultOk,
} from './mocks/coco';

import { HealthCheckResult } from '@commercetools/connect-payments-sdk';
import { AbstractGiftCardService } from '../src/services/abstract-giftcard.service';

interface FlexibleConfig {
  [key: string]: string | number | undefined; // Adjust the type according to your config values
}

function setupMockConfig(keysAndValues: Record<string, string | number>) {
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
      expect(holdBody).toStrictEqual({
        userId: 'demo@example.com',
        paymentId: createPaymentResultOk.id,
        cartId: cart.id,
        amount: { centAmount: 2400, currencyCode: 'EUR' },
      });
      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
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

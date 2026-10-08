import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Cart } from '@commercetools/platform-sdk';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler';
import { paymentSDK } from '../src/payment-sdk';
import * as Config from '../src/config/config';
import { LoyaltyRedemptionService } from '../src/services/loyalty-redemption.service';
import {
  CartRedemptionFieldsClient,
  CartRedemptionFieldsWrite,
  CartRedemptionWriteResult,
} from '../src/clients/cart-redemption-fields.client';
import { MockCustomError } from '../src/errors/mock-api.error';
import { CustomerEmailClient } from '../src/clients/customer-email.client';
import { SessionExpiryClient } from '../src/clients/session-expiry.client';
import { cartCarryingRedemption, customerIdFor, getCartOK, getCartWithCustomerEmail } from './mocks/coco';

const LOYALTY_URL = 'https://loyalty.test';

const denominationCents = (keys: readonly string[]) => keys.reduce((sum, key) => sum + Number(key.slice(1)), 0);

/**
 * In-memory stand-in for the cart fields client. `nextTotalAfterWrite` is what the "cart" totals once
 * the denominations are on it - the service reads that drop as proof commercetools applied the discount.
 */
class FakeCartFields implements CartRedemptionFieldsClient {
  public writes: CartRedemptionFieldsWrite[] = [];
  public clears = 0;
  public nextTotalAfterWrite: number | null = null;
  public failWriteWith: Error | null = null;
  public failClearWith: Error | null = null;

  read(cart: Cart) {
    const fields = cart.custom?.fields ?? {};
    return {
      redemptionId: typeof fields.loyaltyRedemptionId === 'string' ? fields.loyaltyRedemptionId : null,
      denominations: Array.isArray(fields.loyaltyRedemption) ? (fields.loyaltyRedemption as string[]) : [],
    };
  }

  async write(cart: Cart, fields: CartRedemptionFieldsWrite): Promise<CartRedemptionWriteResult> {
    if (this.failWriteWith) {
      throw this.failWriteWith;
    }
    this.writes.push(fields);
    const total = this.nextTotalAfterWrite ?? cart.totalPrice.centAmount - denominationCents(fields.denominations);
    // A totalPrice-targeted discount comes off the gross the shopper pays as well.
    const taxedPrice = cart.taxedPrice && {
      ...cart.taxedPrice,
      totalGross: {
        ...cart.taxedPrice.totalGross,
        centAmount: cart.taxedPrice.totalGross.centAmount - denominationCents(fields.denominations),
      },
    };
    const updated = {
      ...cart,
      version: cart.version + 1,
      totalPrice: { ...cart.totalPrice, centAmount: total },
      ...(taxedPrice && { taxedPrice }),
      custom: {
        type: { typeId: 'type', id: 'loyalty-type-id' },
        fields: { loyaltyRedemptionId: fields.redemptionId, loyaltyRedemption: fields.denominations },
      },
    };
    return { baseline: cart, updated };
  }

  async clear(cart: Cart, expectedRedemptionId: string): Promise<Cart> {
    if (this.failClearWith) {
      throw this.failClearWith;
    }
    if (this.read(cart).redemptionId !== expectedRedemptionId) {
      return cart;
    }
    this.clears++;
    const restored = cart.totalPrice.centAmount + denominationCents(this.read(cart).denominations);
    return {
      ...cart,
      version: cart.version + 1,
      custom: undefined,
      totalPrice: { ...cart.totalPrice, centAmount: restored },
    };
  }
}

/**
 * Resolves the ids test carts carry (`customerIdFor(email)`) to that email, as a logged-in customer's
 * account would; `accounts` overrides that for a customer whose account email differs from the cart's.
 */
class FakeCustomers implements CustomerEmailClient {
  public accounts = new Map<string, string | null>();

  async emailOf(customerId: string): Promise<string | null> {
    if (this.accounts.has(customerId)) {
      return this.accounts.get(customerId) ?? null;
    }
    return customerId.startsWith('customer:') ? customerId.slice('customer:'.length) : null;
  }
}

/** The checkout session the request runs under expires at `expiry` (null: it could not be read). */
class FakeSessions implements SessionExpiryClient {
  public expiry: string | null = '2099-01-01T10:20:45.661Z';

  async expiryOf(): Promise<string | null> {
    return this.expiry;
  }
}

const setupConfig = (extra: Record<string, unknown> = {}) =>
  jest.spyOn(Config, 'getConfig').mockReturnValue({
    loyaltyApiUrl: LOYALTY_URL,
    loyaltyTimeoutMs: 5000,
    loyaltyApiKey: '',
    healthCheckTimeout: 5000,
    projectKey: 'p',
    loyaltyDiscountLevelsByCurrency: { EUR: 18 },
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

const balanceBody = (overrides: Record<string, unknown> = {}) => ({
  userId: 'demo@example.com',
  points: 2600,
  amount: { centAmount: 2600, currencyCode: 'EUR' },
  rateToEur: 1,
  cap: { maxPoints: 2600, maxCents: 2600 },
  openHoldPoints: 0,
  openHoldLocked: false,
  ...overrides,
});

/** Answers every release with VOIDED and records which redemption ids were released. */
const releaseRecorder = (released: string[]) =>
  http.post(`${LOYALTY_URL}/loyalty/redemption/release`, async ({ request }) => {
    const { redemptionId } = (await request.json()) as { redemptionId: string };
    released.push(redemptionId);
    return HttpResponse.json({ redemptionId, outcome: 'VOIDED', balance: 5000 });
  });

const holdEcho = () =>
  http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
    const body = (await request.json()) as { redemptionId: string; amount: { centAmount: number } };
    return HttpResponse.json({ redemptionId: body.redemptionId, points: body.amount.centAmount, balance: 0 });
  });

describe('loyalty-redemption.service', () => {
  const server = setupServer();
  let cartFields: FakeCartFields;
  let customers: FakeCustomers;
  let sessions: FakeSessions;
  let service: LoyaltyRedemptionService;

  beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
  beforeEach(() => {
    jest.resetAllMocks();
    cartFields = new FakeCartFields();
    customers = new FakeCustomers();
    sessions = new FakeSessions();
    service = new LoyaltyRedemptionService({
      ctCartService: paymentSDK.ctCartService,
      ctPaymentService: paymentSDK.ctPaymentService,
      ctOrderService: paymentSDK.ctOrderService,
      cartFields,
      customers,
      sessions,
    });
    // The real getPaymentAmount fetches every payment on the cart from commercetools; there are none
    // in this model, so "still owed" is simply the cart's own total.
    jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockImplementation(async ({ cart }) => ({
      centAmount: cart.totalPrice.centAmount,
      currencyCode: cart.totalPrice.currencyCode,
      fractionDigits: 2,
    }));
  });
  afterEach(() => {
    server.resetHandlers();
    jest.restoreAllMocks();
  });
  afterAll(() => server.close());

  describe('status', () => {
    test('reports the loyalty backend configuration alongside the CoCo permissions', async () => {
      setupConfig();
      jest
        .spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions')
        .mockReturnValue(async () => ({ name: 'CoCo Permissions', status: 'UP', details: {} }));

      const result = await service.status();

      expect(result.checks.map((c) => c.name)).toStrictEqual(['CoCo Permissions', 'Loyalty API configuration']);
      expect(result.checks[1].status).toBe('UP');
    });
  });

  describe('balance', () => {
    test('asks for the cart customer in the cart currency and reports the cap', async () => {
      setupConfig();
      const cart = getCartWithCustomerEmail('Demo@Example.COM');
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      let url: URL | undefined;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      const result = await service.balance('');

      expect(url?.searchParams.get('userId')).toBe('demo@example.com');
      expect(url?.searchParams.get('currency')).toBe('EUR');
      expect(url?.searchParams.get('cartId')).toBe(cart.id);
      expect(url?.searchParams.get('cartTotal')).toBe('4999');
      expect(result).toStrictEqual({
        status: { state: 'Valid' },
        amount: { centAmount: 2600, currencyCode: 'EUR' },
        points: 2600,
        openRedemptionId: null,
        maxPoints: 2600,
        rate: 1,
        openRedemptionPoints: 0,
        openRedemptionLocked: false,
      });
    });

    test('reports the redemption the cart already carries and measures the cap against the undiscounted total', async () => {
      setupConfig();
      // 4999 cart already discounted by D1024+D2 = 1026 -> commercetools shows 3973.
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-open', ['D1024', 'D2'], 3973));
      let url: URL | undefined;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(balanceBody({ openHoldPoints: 1026 }));
        }),
      );

      const result = await service.balance('');

      expect(url?.searchParams.get('cartTotal')).toBe('4999');
      expect(result.openRedemptionId).toBe('red-open');
      expect(result.openRedemptionPoints).toBe(1026);
    });

    test('throws CustomerNotIdentified when the cart has no email', async () => {
      setupConfig();
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(getCartOK({ customerEmail: undefined }));

      await expect(service.balance('')).rejects.toMatchObject({ code: 'CustomerNotIdentified' });
    });

    test('refuses a guest cart: an email typed into the cart does not prove whose points they are', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('victim@example.com', { customerId: undefined }));
      let backendCalled = false;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, () => {
          backendCalled = true;
          return HttpResponse.json(balanceBody());
        }),
      );

      await expect(service.balance('')).rejects.toMatchObject({ code: 'CustomerNotIdentified' });
      expect(backendCalled).toBe(false);
    });

    test('names the customer account, not the email written on the cart', async () => {
      setupConfig();
      const cart = getCartWithCustomerEmail('someone-else@example.com');
      customers.accounts.set(customerIdFor('someone-else@example.com'), 'Owner@Example.COM');
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      let url: URL | undefined;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      await service.balance('');

      expect(url?.searchParams.get('userId')).toBe('owner@example.com');
    });

    /**
     * The storefront re-quotes on every widget load, including under each new checkout session on the
     * same cart; the backend's sweep keeps its hands off the cart until the latest one has expired.
     */
    test('reports the expiry of the checkout session it was called under', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      let url: URL | undefined;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      await service.balance('');

      expect(url?.searchParams.get('sessionExpiresAt')).toBe('2099-01-01T10:20:45.661Z');
    });

    test('still quotes when the session expiry cannot be read', async () => {
      setupConfig();
      sessions.expiry = null;
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      let url: URL | undefined;
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(balanceBody());
        }),
      );

      await service.balance('');

      expect(url?.searchParams.has('sessionExpiresAt')).toBe(false);
    });

    test('refuses a cart whose customer account no longer exists', async () => {
      setupConfig();
      const cart = getCartWithCustomerEmail('gone@example.com');
      customers.accounts.set(customerIdFor('gone@example.com'), null);
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);

      await expect(service.balance('')).rejects.toMatchObject({ code: 'CustomerNotIdentified' });
    });

    test('fails when the backend answers without a cap', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      server.use(
        http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, () =>
          HttpResponse.json({ userId: 'x', points: 1, amount: { centAmount: 1, currencyCode: 'EUR' }, rateToEur: 1 }),
        ),
      );

      await expect(service.balance('')).rejects.toThrow(MockCustomError);
    });
  });

  describe('redeem', () => {
    const redeem = (centAmount: number) =>
      service.redeem({ data: { code: '', redeemAmount: { centAmount, currencyCode: 'EUR' } } });

    test('tells the backend when the checkout session behind the hold expires', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          holdBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 1000, balance: 0 });
        }),
      );

      await redeem(1000);

      expect(holdBody.sessionExpiresAt).toBe('2099-01-01T10:20:45.661Z');
    });

    test('refuses a guest cart before anything is held or written', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('victim@example.com', { customerId: undefined }));
      let held = false;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held = true;
          return HttpResponse.json({});
        }),
      );

      await expect(redeem(1000)).rejects.toMatchObject({ code: 'CustomerNotIdentified' });
      expect(held).toBe(false);
      expect(cartFields.writes).toStrictEqual([]);
    });

    test('holds first, then writes the denominations, and reports the applied amount', async () => {
      setupConfig();
      const cart = getCartWithCustomerEmail('Demo@Example.COM');
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      const order: string[] = [];
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          order.push('hold');
          holdBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 1234, balance: 1366 });
        }),
      );
      const originalWrite = cartFields.write.bind(cartFields);
      cartFields.write = async (c, f) => {
        order.push('write');
        return originalWrite(c, f);
      };

      const result = await redeem(1234);

      expect(order).toStrictEqual(['hold', 'write']);
      expect(holdBody).toMatchObject({
        userId: 'demo@example.com',
        cartId: cart.id,
        amount: { centAmount: 1234, currencyCode: 'EUR' },
        cartTotal: { centAmount: 4999, currencyCode: 'EUR' },
      });
      expect(typeof holdBody.redemptionId).toBe('string');
      expect(cartFields.writes).toStrictEqual([
        { redemptionId: holdBody.redemptionId, denominations: ['D1024', 'D128', 'D64', 'D16', 'D2'] },
      ]);
      expect(result).toStrictEqual({
        result: 'Success',
        redemptionId: holdBody.redemptionId,
        points: 1234,
        appliedAmount: { centAmount: 1234, currencyCode: 'EUR' },
      });
    });

    test('measures the floor and the applied amount on the taxed gross, not on the net total', async () => {
      setupConfig();
      // A project with net prices: totalPrice is the net, taxedPrice.totalGross is what the shopper pays.
      const cart = getCartWithCustomerEmail('demo@example.com', {
        totalPrice: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 4200, fractionDigits: 2 },
        taxedPrice: {
          totalNet: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 4200, fractionDigits: 2 },
          totalGross: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 4999, fractionDigits: 2 },
          taxPortions: [],
        },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockImplementation(async ({ cart: c }) => ({
        centAmount: c.taxedPrice!.totalGross.centAmount,
        currencyCode: c.taxedPrice!.totalGross.currencyCode,
        fractionDigits: 2,
      }));
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          holdBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 2400, balance: 200 });
        }),
      );
      // The net total moves by a different number than the gross: only the gross drop may count.
      cartFields.nextTotalAfterWrite = 4200 - 2017;

      const result = await redeem(2400);

      expect(holdBody).toMatchObject({ cartTotal: { centAmount: 4999, currencyCode: 'EUR' } });
      expect(result).toMatchObject({ result: 'Success', appliedAmount: { centAmount: 2400, currencyCode: 'EUR' } });
    });

    test('releases the hold through the backend when commercetools applied a different amount', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const released: string[] = [];
      server.use(holdEcho(), releaseRecorder(released));
      // A StopAfterThisDiscount promotion above ours: the cart only dropped by 1000.
      cartFields.nextTotalAfterWrite = 4999 - 1000;

      const result = redeem(2400);

      await expect(result).rejects.toMatchObject({ code: 'DiscountNotApplied', httpErrorStatus: 409 });
      expect(released).toHaveLength(1);
      // The backend takes the discount off before it gives the points back; the connector never does.
      expect(cartFields.clears).toBe(0);
    });

    test('still refuses the redeem when the backend cannot release after a discount mismatch', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      server.use(
        holdEcho(),
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () => HttpResponse.json({}, { status: 500 })),
      );
      cartFields.nextTotalAfterWrite = 4999 - 1000;

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'DiscountNotApplied' });
      expect(cartFields.clears).toBe(0);
    });

    test('releases the hold through the backend when the cart write itself fails', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const released: string[] = [];
      server.use(holdEcho(), releaseRecorder(released));
      cartFields.failWriteWith = new Error('commercetools is down');

      await expect(redeem(2400)).rejects.toThrow('commercetools is down');
      // The write may have landed before the failure surfaced: only the backend's clear-first release
      // is safe here, a bare void would leave that discount without a hold.
      expect(released).toHaveLength(1);
    });

    test('releases the redemption the cart already carries through the backend before holding the new amount', async () => {
      setupConfig();
      const carrying = cartCarryingRedemption('demo@example.com', 'red-old', ['D1024'], 3975);
      // The backend's release took the old discount off, so the cart is read again afterwards.
      const cleared = getCartWithCustomerEmail('demo@example.com', { id: carrying.id, version: carrying.version + 1 });
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValueOnce(carrying)
        .mockResolvedValueOnce(cleared);
      const calls: string[] = [];
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, async ({ request }) => {
          calls.push('release:' + ((await request.json()) as { redemptionId: string }).redemptionId);
          return HttpResponse.json({ redemptionId: 'red-old', outcome: 'VOIDED', balance: 2600 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          holdBody = (await request.json()) as Record<string, unknown>;
          calls.push('hold');
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 2400, balance: 200 });
        }),
      );

      await redeem(2400);

      expect(calls).toStrictEqual(['release:red-old', 'hold']);
      expect(cartFields.clears).toBe(0);
      // The floor is measured against the cart with the OLD discount taken off again.
      expect(holdBody.cartTotal).toStrictEqual({ centAmount: 4999, currencyCode: 'EUR' });
      expect(holdBody.redemptionId).not.toBe('red-old');
    });

    test('aborts when the redemption already on the cart is locked for finalization', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-locked', ['D1024'], 3975));
      let held = 0;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
          HttpResponse.json({ error: 'locked', lockedUntil: '2026-01-01T00:00:00' }, { status: 409 }),
        ),
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held++;
          return HttpResponse.json({});
        }),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'FinalizationInProgress', httpErrorStatus: 409 });
      expect(held).toBe(0);
    });

    test('does not hold the new amount when the backend could not release the old redemption', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-old', ['D1024'], 3975));
      let held = 0;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () => HttpResponse.json({}, { status: 500 })),
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held++;
          return HttpResponse.json({});
        }),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'GenericError' });
      expect(held).toBe(0);
    });

    test('does not hold the new amount when the old redemption already reached an order', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-old', ['D1024'], 3975));
      let held = 0;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
          HttpResponse.json({ redemptionId: 'red-old', outcome: 'AWAITING_ORDER', balance: 2600 }),
        ),
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held++;
          return HttpResponse.json({});
        }),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'GenericError' });
      expect(held).toBe(0);
    });

    test('refuses an amount the denominations cannot compose before touching the ledger', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      let held = 0;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held++;
          return HttpResponse.json({});
        }),
      );

      await expect(redeem(300000)).rejects.toMatchObject({ code: 'AmountNotDecomposable', httpErrorStatus: 400 });
      expect(held).toBe(0);
    });

    test('decomposes against the levels configured for the cart currency, not a fixed 18', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18, RON: 21 } });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        totalPrice: { type: 'centPrecision', currencyCode: 'RON', centAmount: 2000000, fractionDigits: 2 },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue({
        centAmount: 2000000,
        currencyCode: 'RON',
        fractionDigits: 2,
      });
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          holdBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 300000, balance: 0 });
        }),
      );
      // 300000 minor units exceeds 18 levels' reach (262143) but not 21's (2097151).
      cartFields.nextTotalAfterWrite = 2000000 - 300000;

      const result = await service.redeem({
        data: { code: '', redeemAmount: { centAmount: 300000, currencyCode: 'RON' } },
      });

      expect(result.appliedAmount).toStrictEqual({ centAmount: 300000, currencyCode: 'RON' });
      expect(cartFields.writes[0].denominations).toContain('D262144');
    });

    test('refuses a currency with no configured denominations before touching the ledger', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18 } });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(
        getCartWithCustomerEmail('demo@example.com', {
          totalPrice: { type: 'centPrecision', currencyCode: 'PLN', centAmount: 100000, fractionDigits: 2 },
        }),
      );
      let held = 0;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => {
          held++;
          return HttpResponse.json({});
        }),
      );

      await expect(
        service.redeem({ data: { code: '', redeemAmount: { centAmount: 100, currencyCode: 'PLN' } } }),
      ).rejects.toMatchObject({ code: 'CurrencyNotMatch', httpErrorStatus: 400 });
      expect(held).toBe(0);
    });

    test('maps an insufficient-balance 409 and writes nothing to the cart', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () =>
          HttpResponse.json({ error: 'not enough points' }, { status: 409 }),
        ),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'InsufficientFunds', httpErrorStatus: 409 });
      expect(cartFields.writes).toHaveLength(0);
    });

    test('maps a cart-already-held 409 to CartAlreadyHeld', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () =>
          HttpResponse.json({ error: 'held', existingRedemptionId: 'red-elsewhere' }, { status: 409 }),
        ),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'CartAlreadyHeld', httpErrorStatus: 409 });
      expect(cartFields.writes).toHaveLength(0);
    });

    test('writes nothing to the cart when the hold outcome is uncertain', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
      );

      await expect(redeem(2400)).rejects.toMatchObject({ code: 'GenericError', httpErrorStatus: 500 });
      expect(cartFields.writes).toHaveLength(0);
    });
  });

  describe('redeem in points', () => {
    const redeemPoints = (points: number) => service.redeem({ data: { code: '', redeemPoints: points } });

    /** Answers a points hold the way the backend prices it: `centsFor(points)` in the asked currency. */
    const pointsHold = (centsFor: (points: number) => number, bodies: Record<string, unknown>[] = []) =>
      http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
        const body = (await request.json()) as { redemptionId: string; points: number; currencyCode: string };
        bodies.push(body);
        return HttpResponse.json({
          redemptionId: body.redemptionId,
          points: body.points,
          balance: 0,
          amount: { centAmount: centsFor(body.points), currencyCode: body.currencyCode },
        });
      });

    test('holds the points in the cart currency and puts the amount the backend priced on the cart', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18, GBP: 18 } });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        totalPrice: { type: 'centPrecision', currencyCode: 'GBP', centAmount: 4999, fractionDigits: 2 },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue({
        centAmount: 4999,
        currencyCode: 'GBP',
        fractionDigits: 2,
      });
      const bodies: Record<string, unknown>[] = [];
      // 0.85 GBP per EUR, rounded down: 7 points are 5 pence.
      server.use(pointsHold((points) => Math.floor(points * 0.85), bodies));

      const result = await redeemPoints(7);

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        userId: 'demo@example.com',
        cartId: cart.id,
        points: 7,
        currencyCode: 'GBP',
        cartTotal: { centAmount: 4999, currencyCode: 'GBP' },
      });
      expect(bodies[0]).not.toHaveProperty('amount');
      expect(cartFields.writes).toStrictEqual([{ redemptionId: bodies[0].redemptionId, denominations: ['D4', 'D1'] }]);
      expect(result).toStrictEqual({
        result: 'Success',
        redemptionId: bodies[0].redemptionId,
        points: 7,
        appliedAmount: { centAmount: 5, currencyCode: 'GBP' },
      });
    });

    test('refuses a request naming both the amount and the points before touching the ledger', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const bodies: Record<string, unknown>[] = [];
      server.use(pointsHold((points) => points, bodies));

      await expect(
        service.redeem({
          data: { code: '', redeemPoints: 100, redeemAmount: { centAmount: 100, currencyCode: 'EUR' } },
        }),
      ).rejects.toMatchObject({ code: 'InvalidRedeemRequest', httpErrorStatus: 400 });
      expect(bodies).toHaveLength(0);
    });

    test('refuses a cart currency with no configured denominations before touching the ledger', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18 } });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        totalPrice: { type: 'centPrecision', currencyCode: 'PLN', centAmount: 100000, fractionDigits: 2 },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue({
        centAmount: 100000,
        currencyCode: 'PLN',
        fractionDigits: 2,
      });
      const bodies: Record<string, unknown>[] = [];
      server.use(pointsHold((points) => points, bodies));

      await expect(redeemPoints(100)).rejects.toMatchObject({ code: 'CurrencyNotMatch', httpErrorStatus: 400 });
      expect(bodies).toHaveLength(0);
    });

    test('voids the hold and writes nothing when the priced amount cannot be composed', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 4 } });
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const voided: string[] = [];
      server.use(
        pointsHold((points) => points),
        http.post(`${LOYALTY_URL}/loyalty/redemption/void`, async ({ request }) => {
          const { redemptionId } = (await request.json()) as { redemptionId: string };
          voided.push(redemptionId);
          return HttpResponse.json({ redemptionId, points: 0, balance: 5000 });
        }),
      );

      // 4 levels reach 15 minor units at most.
      await expect(redeemPoints(16)).rejects.toMatchObject({ code: 'AmountNotDecomposable', httpErrorStatus: 400 });
      expect(voided).toHaveLength(1);
      expect(cartFields.writes).toHaveLength(0);
    });

    test('voids the hold and fails when the backend does not price points holds yet', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const voided: string[] = [];
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          const body = (await request.json()) as { redemptionId: string };
          return HttpResponse.json({ redemptionId: body.redemptionId, points: 100, balance: 0 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/redemption/void`, async ({ request }) => {
          const { redemptionId } = (await request.json()) as { redemptionId: string };
          voided.push(redemptionId);
          return HttpResponse.json({ redemptionId, points: 0, balance: 5000 });
        }),
      );

      await expect(redeemPoints(100)).rejects.toMatchObject({ code: 'GenericError', httpErrorStatus: 500 });
      expect(voided).toHaveLength(1);
      expect(cartFields.writes).toHaveLength(0);
    });

    test('releases the hold when commercetools applied less than the priced amount', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(getCartWithCustomerEmail('demo@example.com'));
      const released: string[] = [];
      server.use(
        pointsHold((points) => points),
        releaseRecorder(released),
      );
      cartFields.nextTotalAfterWrite = 4999 - 1000;

      await expect(redeemPoints(2400)).rejects.toMatchObject({ code: 'DiscountNotApplied', httpErrorStatus: 409 });
      expect(released).toHaveLength(1);
    });
  });

  describe('release', () => {
    test('releases through the backend and never touches the cart itself', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-1', ['D1024'], 3975));
      const released: string[] = [];
      server.use(releaseRecorder(released));

      const result = await service.release({ data: { redemptionId: 'red-1' } });

      expect(result).toStrictEqual({ result: 'Success' });
      expect(released).toStrictEqual(['red-1']);
      expect(cartFields.clears).toBe(0);
    });

    test('a locked hold refuses the release', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-1', ['D1024'], 3975));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
          HttpResponse.json({ error: 'locked', lockedUntil: '2026-01-01T00:00:00' }, { status: 409 }),
        ),
      );

      await expect(service.release({ data: { redemptionId: 'red-1' } })).rejects.toMatchObject({
        code: 'FinalizationInProgress',
      });
      expect(cartFields.clears).toBe(0);
    });

    /**
     * A discount the backend holds nothing for: there are no points to give back, so the only thing
     * left to do is take the discount off, and nothing can go wrong doing it here.
     */
    test('clears the cart itself when the backend knows no such hold', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-1', ['D1024'], 3975));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
          HttpResponse.json({ error: 'no such hold' }, { status: 404 }),
        ),
      );

      await expect(service.release({ data: { redemptionId: 'red-1' } })).resolves.toStrictEqual({ result: 'Success' });
      expect(cartFields.clears).toBe(1);
    });

    /**
     * The session only proves the caller owns THIS cart. A redemption id that this cart does not carry
     * belongs to someone else's checkout, and releasing it would strip their discount of its hold.
     */
    test('refuses to release a redemption the cart does not carry', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-other', ['D1024'], 3975));
      const released: string[] = [];
      server.use(releaseRecorder(released));

      await expect(service.release({ data: { redemptionId: 'red-1' } })).rejects.toMatchObject({
        code: 'RedemptionNotOnCart',
        httpErrorStatus: 404,
      });
      expect(released).toStrictEqual([]);
      expect(cartFields.clears).toBe(0);
    });

    test('surfaces a backend failure instead of reporting success', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-1', ['D1024'], 3975));
      server.use(http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () => HttpResponse.json({}, { status: 500 })));

      await expect(service.release({ data: { redemptionId: 'red-1' } })).rejects.toMatchObject({
        code: 'GenericError',
      });
      expect(cartFields.clears).toBe(0);
    });

    test('does not report success when the cart already became an order', async () => {
      setupConfig();
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockResolvedValue(cartCarryingRedemption('demo@example.com', 'red-1', ['D1024'], 3975));
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
          HttpResponse.json({ redemptionId: 'red-1', outcome: 'CAPTURED', balance: 0 }),
        ),
      );

      await expect(service.release({ data: { redemptionId: 'red-1' } })).rejects.toMatchObject({
        code: 'GenericError',
      });
    });
  });

  describe('finalize', () => {
    test('locks the reservation', async () => {
      setupConfig();
      let body: unknown;
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/lock`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ redemptionId: 'red-1', points: 1, balance: 1 });
        }),
      );

      await expect(service.finalize({ data: { redemptionId: 'red-1' } })).resolves.toStrictEqual({ result: 'Success' });
      expect(body).toStrictEqual({ redemptionId: 'red-1' });
    });

    test('a 409 fails the checkout; anything else is swallowed', async () => {
      setupConfig();
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/lock`, () =>
          HttpResponse.json({ error: 'locked' }, { status: 409 }),
        ),
      );
      await expect(service.finalize({ data: { redemptionId: 'red-1' } })).rejects.toMatchObject({
        code: 'FinalizationInProgress',
      });

      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/lock`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
      );
      await expect(service.finalize({ data: { redemptionId: 'red-1' } })).resolves.toStrictEqual({ result: 'Success' });
    });
  });

  describe('payment-intents operations', () => {
    test.each(['capturePayment', 'cancelPayment', 'refundPayment', 'reversePayment'] as const)(
      '%s is not supported: no Payment exists',
      async (action) => {
        setupConfig();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payment = { id: 'p', amountPlanned: { centAmount: 1, currencyCode: 'EUR' } } as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(service[action]({ payment, amount: payment.amountPlanned } as any)).rejects.toThrow(
          'operation not supported',
        );
      },
    );
  });
});

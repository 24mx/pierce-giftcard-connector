import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Cart } from '@commercetools/platform-sdk';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import { paymentSDK } from '../src/payment-sdk';
import * as Config from '../src/config/config';
import { LoyaltyRedemptionService } from '../src/services/loyalty-redemption.service';
import { CartRedemption } from '../src/redemption/cart-redemption';
import { AmountSchemaDTO } from '../src/dtos/operations/payment-intents.dto';
import { MockCustomError } from '../src/errors/mock-api.error';
import { getCartWithCustomerEmail } from './mocks/coco';

const LOYALTY_URL = 'https://loyalty.test';

/**
 * A cart representation with no denominations, no custom fields and no commercetools behind it: it
 * remembers per cart which redemption it carries and how much it takes off. The service must work on
 * it unchanged - that is what keeps the commercetools representation replaceable.
 */
class FakeCartRedemption implements CartRedemption {
  public carried = new Map<string, { redemptionId: string; cents: number }>();
  public applies: { redemptionId: string; amount: AmountSchemaDTO }[] = [];
  public clears: string[] = [];
  /** What the platform takes off on the next apply; the requested amount when unset. */
  public nextApplied: number | undefined;
  public refuseAmountsAbove = Number.MAX_SAFE_INTEGER;

  carriedBy(cart: Cart): string | null {
    return this.carried.get(cart.id)?.redemptionId ?? null;
  }

  amountOn(cart: Cart): number {
    return this.carried.get(cart.id)?.cents ?? 0;
  }

  assertCurrency(): void {}

  assertApplicable(amount: AmountSchemaDTO): void {
    if (amount.centAmount > this.refuseAmountsAbove) {
      throw new MockCustomError({ message: 'too much', code: 400, key: 'AmountNotDecomposable' });
    }
  }

  async apply(cart: Cart, redemptionId: string, amount: AmountSchemaDTO): Promise<number> {
    this.applies.push({ redemptionId, amount });
    const applied = this.nextApplied ?? amount.centAmount;
    this.carried.set(cart.id, { redemptionId, cents: applied });
    return applied;
  }

  async clear(cart: Cart, redemptionId: string): Promise<void> {
    this.clears.push(redemptionId);
    this.carried.delete(cart.id);
  }

  async provision(): Promise<void> {}
}

describe('loyalty-redemption.service on any cart representation', () => {
  const server = setupServer();
  let representation: FakeCartRedemption;
  let service: LoyaltyRedemptionService;
  const cart = getCartWithCustomerEmail('demo@example.com');

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  beforeEach(() => {
    representation = new FakeCartRedemption();
    service = new LoyaltyRedemptionService({
      ctCartService: paymentSDK.ctCartService,
      ctPaymentService: paymentSDK.ctPaymentService,
      ctOrderService: paymentSDK.ctOrderService,
      cartRedemption: representation,
      customers: { emailOf: async () => 'demo@example.com' },
      sessions: { expiryOf: async () => null },
    });
    jest.spyOn(Config, 'getConfig').mockReturnValue({
      loyaltyApiUrl: LOYALTY_URL,
      loyaltyTimeoutMs: 5000,
      loyaltyApiKey: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
    jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockImplementation(async ({ cart: c }) => ({
      centAmount: c.totalPrice.centAmount - representation.amountOn(c),
      currencyCode: c.totalPrice.currencyCode,
      fractionDigits: 2,
    }));
  });
  afterEach(() => {
    server.resetHandlers();
    jest.restoreAllMocks();
  });
  afterAll(() => server.close());

  const redeem = (centAmount: number) =>
    service.redeem({ data: { code: '', redeemAmount: { centAmount, currencyCode: 'EUR' } } });

  const holdAndRelease = (released: string[]) => [
    http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
      const body = (await request.json()) as { redemptionId: string; amount: { centAmount: number } };
      return HttpResponse.json({ redemptionId: body.redemptionId, points: body.amount.centAmount, balance: 0 });
    }),
    http.post(`${LOYALTY_URL}/loyalty/redemption/release`, async ({ request }) => {
      const { redemptionId } = (await request.json()) as { redemptionId: string };
      released.push(redemptionId);
      return HttpResponse.json({ redemptionId, outcome: 'VOIDED', balance: 5000 });
    }),
  ];

  test('measures the cap against the total before the redemption the cart already carries', async () => {
    representation.carried.set(cart.id, { redemptionId: 'red-open', cents: 1000 });
    let url: URL | undefined;
    server.use(
      http.get(`${LOYALTY_URL}/loyalty/redemption/balance`, ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({
          userId: 'demo@example.com',
          points: 2600,
          amount: { centAmount: 2600, currencyCode: 'EUR' },
          rateToEur: 1,
          cap: { maxPoints: 2600, maxCents: 2600 },
          openHoldPoints: 1000,
          openHoldLocked: false,
        });
      }),
    );

    const result = await service.balance('');

    expect(url?.searchParams.get('cartTotal')).toBe(String(cart.totalPrice.centAmount));
    expect(result.openRedemptionId).toBe('red-open');
  });

  test('holds, then puts the redemption on the cart and reports what the platform took off', async () => {
    const released: string[] = [];
    server.use(...holdAndRelease(released));

    const result = await redeem(1234);

    expect(representation.applies).toStrictEqual([
      { redemptionId: result.redemptionId, amount: { centAmount: 1234, currencyCode: 'EUR' } },
    ]);
    expect(result.appliedAmount).toStrictEqual({ centAmount: 1234, currencyCode: 'EUR' });
    expect(released).toStrictEqual([]);
  });

  test('releases the hold and refuses when the platform took off a different amount', async () => {
    const released: string[] = [];
    server.use(...holdAndRelease(released));
    representation.nextApplied = 1000;

    await expect(redeem(1234)).rejects.toMatchObject({ code: 'DiscountNotApplied', httpErrorStatus: 409 });
    expect(released).toStrictEqual([representation.applies[0].redemptionId]);
  });

  test('refuses an amount the representation cannot carry before the ledger is touched', async () => {
    representation.refuseAmountsAbove = 1000;

    await expect(redeem(1234)).rejects.toMatchObject({ code: 'AmountNotDecomposable', httpErrorStatus: 400 });
    expect(representation.applies).toStrictEqual([]);
  });

  test('takes the redemption off the cart itself when the backend holds nothing for it', async () => {
    representation.carried.set(cart.id, { redemptionId: 'red-1', cents: 1000 });
    server.use(
      http.post(`${LOYALTY_URL}/loyalty/redemption/release`, () =>
        HttpResponse.json({ message: 'no such hold' }, { status: 404 }),
      ),
    );

    await service.release({ data: { redemptionId: 'red-1' } });

    expect(representation.clears).toStrictEqual(['red-1']);
  });
});

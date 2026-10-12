import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { BalanceResponse, RedeemResponse } from '../../../packages/loyalty-connector-contract/src';
import { commercetools, VoucherFixture } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor, ProcessorError } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';
const DISCOUNT_KEY_PREFIX = process.env.LOYALTY_DISCOUNT_KEY_PREFIX || 'loyalty-';
const GRANT = 100_000;
/** 4 bags: room for a 50.00 voucher, a 100.00 voucher and points on the same cart. */
const QUANTITY = 4;
const POINTS_CENTS = 3000;

/**
 * Copies of the code-gated discounts production runs today (read from pierce-prod on 2026-10-07):
 * same value, target, stacking mode and sortOrder, so commercetools ranks them against the
 * `loyalty-*` denominations exactly as it would in production. Two simplifications: the line-item
 * predicates are `1 = 1` (production's pick every product too, through the root category), and none is
 * Store-scoped. All amounts are EUR, the market the suite's first Store sells in.
 */
const VOUCHERS = {
  /** PM_50_EUR_or_equivalent_voucher_code - the gift card: 500 single-use codes, 50 EUR off the lines. */
  giftCard50: {
    code: 'SYSTEM-MIRROR-GIFTCARD-50',
    discount: {
      key: 'system-mirror-pm-50-eur-voucher',
      name: { en: 'System test mirror of PM_50_EUR_or_equivalent_voucher_code' },
      value: {
        type: 'absolute',
        money: [{ currencyCode: 'EUR', centAmount: 5000 }],
        applicationMode: 'ProportionateDistribution',
      },
      target: { type: 'lineItems', predicate: '1 = 1' },
      cartPredicate: '1 = 1',
      stackingMode: 'Stacking',
      sortOrder: '0.895414654555441555454547845748475454547845454',
    },
  },
  /** 15PercentDiscount - and the 26 other percentage codes that stop the discounts ranked below them. */
  percent15Stop: {
    code: 'SYSTEM-MIRROR-15-PERCENT',
    discount: {
      key: 'system-mirror-15-percent-discount',
      name: { en: 'System test mirror of 15PercentDiscount' },
      value: { type: 'relative', permyriad: 1500 },
      target: { type: 'lineItems', predicate: '1 = 1' },
      cartPredicate: '1 = 1',
      stackingMode: 'StopAfterThisDiscount',
      sortOrder: '0.758432196',
    },
  },
  /** 1PM_REG_100EURVoucher_multiple_codes_ALL - active, but no codes issued yet in production. */
  voucher100TotalStop: {
    code: 'SYSTEM-MIRROR-VOUCHER-100',
    discount: {
      key: 'system-mirror-100-eur-voucher',
      name: { en: 'System test mirror of 1PM_REG_100EURVoucher_multiple_codes_ALL' },
      value: {
        type: 'absolute',
        money: [{ currencyCode: 'EUR', centAmount: 10000 }],
        applicationMode: 'ProportionateDistribution',
      },
      target: { type: 'totalPrice' },
      cartPredicate: '1 = 1',
      stackingMode: 'StopAfterThisDiscount',
      sortOrder: '0.899493923493',
    },
  },
  /** PM_Order_Selfcheckout - 99% off the total for partners, leaves almost nothing to pay. */
  selfCheckout99: {
    code: 'SYSTEM-MIRROR-SELFCHECKOUT-99',
    discount: {
      key: 'system-mirror-order-selfcheckout',
      name: { en: 'System test mirror of PM_Order_Selfcheckout' },
      value: { type: 'relative', permyriad: 9900 },
      target: { type: 'totalPrice' },
      cartPredicate: '1 = 1',
      stackingMode: 'Stacking',
      sortOrder: '0.8999999996356456564564564556498484564364599999',
    },
  },
} satisfies Record<string, VoucherFixture>;

describeSystem('production vouchers and gift-card codes next to points', () => {
  const env = systemEnv()!;
  const ct = commercetools(env);
  const backend = loyalty(env);
  const routes = processor(env);

  const store = env.loyaltyStores[0];

  let email: string;
  let cart: Cart | undefined;
  let sessionId: string;
  /** Gross total of the fresh cart, before any voucher or points. */
  let undiscounted: number;

  beforeAll(async () => {
    for (const voucher of Object.values(VOUCHERS)) {
      await ct.ensureVoucher(voucher);
    }
  });

  beforeEach(async () => {
    email = testEmail();
    await backend.grant(email, GRANT);
    cart = await ct.createCart({
      email,
      storeKey: store.storeKey,
      currency: store.currency,
      country: store.country,
      quantity: QUANTITY,
    });
    undiscounted = cart!.totalPrice.centAmount;
    sessionId = await ct.createSession(cart!.id);
  });

  afterEach(async () => {
    try {
      await backend.releaseAll(email);
    } finally {
      if (cart) {
        await ct.deleteCart(cart);
      }
      cart = undefined;
    }
  });

  const redeem = (centAmount: number) =>
    routes.post<RedeemResponse>('/redeem', sessionId, {
      code: 'points',
      redeemAmount: { centAmount, currencyCode: store.currency },
    });

  const balance = () => routes.post<BalanceResponse>('/balance', sessionId, { code: 'points' });

  const capCents = (reply: BalanceResponse): number => Math.floor(reply.maxPoints * reply.rate);

  const fresh = () => ct.getCart(cart!.id);

  /** The points' share of the cart's total-price discount, summed over every `loyalty-*` denomination. */
  const pointsOnCart = async (c: Cart): Promise<number> =>
    Object.entries(await ct.totalPricePortionsByKey(c))
      .filter(([key]) => key.startsWith(DISCOUNT_KEY_PREFIX))
      .reduce((sum, [, cents]) => sum + cents, 0);

  const linesTotal = (c: Cart): number => c.lineItems.reduce((sum, line) => sum + line.totalPrice.centAmount, 0);

  const addCode = async (code: string): Promise<Cart> => {
    const updated = await ct.addDiscountCode(cart!.id, code);
    // addDiscountCode does not expand the reference; the state is all the assertions need.
    expect(updated.discountCodes.map((d) => d.state)).toContain('MatchesCart');
    return updated;
  };

  describe('gift card (50 EUR off the lines, Stacking)', () => {
    test('code first, then points: the cap follows the reduced cart and both discounts apply in full', async () => {
      const capBefore = capCents((await balance()).body);
      const withVoucher = await addCode(VOUCHERS.giftCard50.code);
      expect(withVoucher.totalPrice.centAmount).toBe(undiscounted - 5000);
      expect(capCents((await balance()).body)).toBe(capBefore - 5000);

      const reply = await redeem(POINTS_CENTS);

      expect(reply.status).toBe(200);
      expect(reply.body.appliedAmount.centAmount).toBe(POINTS_CENTS);
      const after = await fresh();
      expect(after.totalPrice.centAmount).toBe(undiscounted - 5000 - POINTS_CENTS);
      expect(await pointsOnCart(after)).toBe(POINTS_CENTS);
      expect(after.discountCodes.map((d) => d.state)).toEqual(['MatchesCart']);
    });

    test('points first, then the code: the points stay exactly as redeemed', async () => {
      const reply = await redeem(POINTS_CENTS);
      expect(reply.status).toBe(200);

      await addCode(VOUCHERS.giftCard50.code);

      const after = await fresh();
      expect(after.totalPrice.centAmount).toBe(undiscounted - POINTS_CENTS - 5000);
      expect(await pointsOnCart(after)).toBe(POINTS_CENTS);
      expect(after.custom?.fields?.[REDEMPTION_ID_FIELD]).toBe(reply.body.redemptionId);
    });

    test('removing the code after points gives the 50 EUR back to pay and leaves the points alone', async () => {
      await addCode(VOUCHERS.giftCard50.code);
      const reply = await redeem(POINTS_CENTS);
      expect(reply.status).toBe(200);

      const after = await ct.removeDiscountCode(cart!.id, VOUCHERS.giftCard50.code);

      expect(after.totalPrice.centAmount).toBe(undiscounted - POINTS_CENTS);
      expect(await pointsOnCart(after)).toBe(POINTS_CENTS);
    });
  });

  describe('percentage code that stops further discounts (StopAfterThisDiscount on the lines)', () => {
    // commercetools applies total-price discounts after every line-item discount, whatever the line
    // discount's stacking mode: "stop" only stops other LINE discounts, never the points.
    test.each(['code first', 'points first'])('%s: 15%% off the lines and the points both apply', async (order) => {
      if (order === 'code first') {
        await addCode(VOUCHERS.percent15Stop.code);
      }
      const reply = await redeem(POINTS_CENTS);
      expect(reply.status).toBe(200);
      if (order === 'points first') {
        await addCode(VOUCHERS.percent15Stop.code);
      }

      const after = await fresh();
      // 15% is rounded per unit, so it is read off the lines rather than recomputed here.
      const lines = linesTotal(after);
      expect(Math.abs(undiscounted - lines - Math.round(undiscounted * 0.15))).toBeLessThanOrEqual(QUANTITY);
      expect(await pointsOnCart(after)).toBe(POINTS_CENTS);
      expect(after.totalPrice.centAmount).toBe(lines - POINTS_CENTS);
    });

    test('gift card and 15% code together, then points: all three apply', async () => {
      await addCode(VOUCHERS.giftCard50.code);
      await addCode(VOUCHERS.percent15Stop.code);
      const beforePoints = (await fresh()).totalPrice.centAmount;
      expect(beforePoints).toBeLessThan(undiscounted - 5000);

      const reply = await redeem(POINTS_CENTS);

      expect(reply.status).toBe(200);
      const after = await fresh();
      expect(after.totalPrice.centAmount).toBe(beforePoints - POINTS_CENTS);
      expect(await pointsOnCart(after)).toBe(POINTS_CENTS);
    });
  });

  describe('partner self-checkout code (99% off the total, Stacking)', () => {
    test('the cap shrinks to what is left, more is refused untouched, a redeem within it applies', async () => {
      const withCode = await addCode(VOUCHERS.selfCheckout99.code);
      const left = withCode.totalPrice.centAmount;
      expect(left).toBeLessThan(undiscounted / 50);
      const cap = capCents((await balance()).body);
      expect(cap).toBeLessThan(left);

      const tooMuch = await redeem(POINTS_CENTS);
      expect(tooMuch.status).not.toBe(200);
      const untouched = await fresh();
      expect(untouched.totalPrice.centAmount).toBe(left);
      expect(untouched.custom?.fields?.[REDEMPTION_ID_FIELD]).toBeUndefined();
      expect((await backend.balance(email)).points).toBe(GRANT);

      if (cap > 0) {
        const within = await redeem(cap);
        expect(within.status).toBe(200);
        expect((await fresh()).totalPrice.centAmount).toBe(left - cap);
      }
    });
  });

  describe('total-price voucher that stops further discounts (100 EUR, StopAfterThisDiscount, ranked above the points)', () => {
    // Production has this discount active with no codes issued yet. It is the one kind that does collide
    // with points: commercetools stops every total-price discount ranked below it - all of `loyalty-*`.
    test('code first: redeem is refused with DiscountNotApplied, nothing lands on the cart, nothing is spent', async () => {
      await addCode(VOUCHERS.voucher100TotalStop.code);
      const before = (await fresh()).totalPrice.centAmount;
      expect(before).toBe(undiscounted - 10000);

      const reply = await routes.post<ProcessorError>('/redeem', sessionId, {
        code: 'points',
        redeemAmount: { centAmount: POINTS_CENTS, currencyCode: store.currency },
      });

      expect(reply.status).toBe(409);
      expect(reply.body.status.state).toBe('DiscountNotApplied');
      const after = await fresh();
      expect(after.totalPrice.centAmount).toBe(before);
      expect(after.custom?.fields?.[REDEMPTION_ID_FIELD]).toBeUndefined();
      expect((await balance()).body.openRedemptionId).toBeNull();
      // The refused reservation is released, not credited: like every release its points stay reserved
      // while the checkout session could still pay, and the sweep gives them back once it is over
      // (session end + grace). Spent they are not - no order can carry a discount the cart never had.
      expect((await backend.balance(email)).points).toBe(GRANT - POINTS_CENTS);
    });

    test('points first, then the code: the points discount silently drops off the cart while the hold stays', async () => {
      const reply = await redeem(POINTS_CENTS);
      expect(reply.status).toBe(200);

      await addCode(VOUCHERS.voucher100TotalStop.code);

      // What the shopper would pay now: the voucher only. The points are still reserved; at order time
      // capture settles what the order applied (nothing) and credits the reservation back
      // (backend: RedemptionCoverageGateTest#a_reservation_whose_discount_never_applied_...).
      const after = await fresh();
      expect(after.totalPrice.centAmount).toBe(undiscounted - 10000);
      expect(await pointsOnCart(after)).toBe(0);
      expect(after.custom?.fields?.[REDEMPTION_ID_FIELD]).toBe(reply.body.redemptionId);
    });
  });
});

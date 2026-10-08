import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { BalanceResponse, RedeemResponse, ReleaseResponse } from '../../../packages/loyalty-connector-contract/src';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor, ProcessorError } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';
// Deliberately not a round number: a point count that has no exact amount in a currency worth more than
// a EUR cent per minor unit (GBP, CHF) is what an amount-priced redeem used to debit a point off.
const PICKED_POINTS = 137;

/** What the backend puts on the cart for `points`: rounded DOWN into the minor unit (EurCents.toLocal). */
const centsFor = (points: number, rate: number) => Math.floor(Math.round(points * rate * 1e6) / 1e6);

describeSystem('redeeming exactly the points picked (redeemPoints)', () => {
  const env = systemEnv()!;
  const ct = commercetools(env);
  const backend = loyalty(env);
  const routes = processor(env);

  let email: string;
  let cart: Cart | undefined;

  beforeEach(() => {
    email = testEmail();
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

  const openCart = async (store: (typeof env.loyaltyStores)[number], grant: number) => {
    await backend.grant(email, grant);
    cart = await ct.createCart({
      email,
      storeKey: store.storeKey,
      currency: store.currency,
      country: store.country,
    });
    return ct.createSession(cart.id);
  };

  const quote = async (sessionId: string) => {
    const reply = await routes.post<BalanceResponse>('/balance', sessionId, { code: '' });
    // The body rides along so a refusal names its key instead of a bare status.
    expect({ status: reply.status, body: reply.body }).toMatchObject({ status: 200 });
    return reply.body;
  };

  const redeemPoints = (sessionId: string, points: number) =>
    routes.post<RedeemResponse>('/redeem', sessionId, { code: 'points', redeemPoints: points });

  test.each(env.loyaltyStores.map((store) => [store.storeKey, store.currency, store] as const))(
    'debits exactly the picked points and takes their backend-priced amount off the cart in store %s (%s)',
    async (_storeKey, currency, store) => {
      const sessionId = await openCart(store, 10_000);
      const before = cart!.totalPrice.centAmount;
      const { maxPoints, rate } = await quote(sessionId);
      const points = Math.min(PICKED_POINTS, maxPoints);
      expect(points).toBeGreaterThan(0);

      const reply = await redeemPoints(sessionId, points);

      expect(reply.status).toBe(200);
      expect(reply.body.points).toBe(points);
      expect(reply.body.appliedAmount).toStrictEqual({ centAmount: centsFor(points, rate), currencyCode: currency });
      const after = await ct.getCart(cart!.id);
      expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBe(reply.body.redemptionId);
      expect(after.totalPrice.centAmount).toBe(before - reply.body.appliedAmount.centAmount);
      expect((await backend.balance(email)).points).toBe(10_000 - points);
    },
  );

  test.each(env.loyaltyStores.map((store) => [store.storeKey, store.currency, store] as const))(
    'spends the whole balance when it is the cap in store %s (%s)',
    async (_storeKey, _currency, store) => {
      // A balance far below the cart, so the cap is the balance itself - the case an amount-priced redeem
      // could overshoot by a point and have refused as InsufficientFunds.
      const sessionId = await openCart(store, PICKED_POINTS);
      const { maxPoints } = await quote(sessionId);
      expect(maxPoints).toBe(PICKED_POINTS);

      const reply = await redeemPoints(sessionId, maxPoints);

      expect(reply.status).toBe(200);
      expect(reply.body.points).toBe(PICKED_POINTS);
      expect((await backend.balance(email)).points).toBe(0);
    },
  );

  /**
   * The shopper takes the points off: the discount leaves the cart at once, but the points stay reserved
   * (release-pending) until the cash check or the sweep closes them - a payment for the old amount may
   * still complete in another tab (pierce-loyalty #64, RedemptionRelease.ReleaseMode.DEFER_CREDIT).
   */
  test('release after a points redeem keeps exactly the picked points reserved until the sweep', async () => {
    const store = env.loyaltyStores[0];
    const sessionId = await openCart(store, 10_000);
    const before = cart!.totalPrice.centAmount;
    const redeemed = await redeemPoints(sessionId, PICKED_POINTS);
    expect(redeemed.status).toBe(200);

    const released = await routes.post<ReleaseResponse>('/release', sessionId, {
      redemptionId: redeemed.body.redemptionId,
    });

    expect(released.status).toBe(200);
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields?.[REDEMPTION_ID_FIELD]).toBeUndefined();
    expect(after.totalPrice.centAmount).toBe(before);
    expect((await backend.balance(email)).points).toBe(10_000 - PICKED_POINTS);

    await backend.sweepFor(email);

    expect((await backend.balance(email)).points).toBe(10_000);
  });

  test('naming both the points and an amount is 400 InvalidRedeemRequest and holds nothing', async () => {
    const store = env.loyaltyStores[0];
    const sessionId = await openCart(store, 10_000);
    const before = cart!.totalPrice.centAmount;

    const reply = await routes.post<ProcessorError>('/redeem', sessionId, {
      code: 'points',
      redeemPoints: PICKED_POINTS,
      redeemAmount: { centAmount: PICKED_POINTS, currencyCode: store.currency },
    });

    expect(reply.status).toBe(400);
    expect(reply.body.status.state).toBe('InvalidRedeemRequest');
    expect((await ct.getCart(cart!.id)).totalPrice.centAmount).toBe(before);
    expect((await backend.balance(email)).points).toBe(10_000);
  });
});

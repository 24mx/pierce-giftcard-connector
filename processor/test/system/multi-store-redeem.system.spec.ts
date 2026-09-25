import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor } from './support/processor';

describeSystem('redeeming in a specific store and currency', () => {
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

  test.each(env.loyaltyStores.map((store) => [store.storeKey, store.currency, store.country] as const))(
    'redeems 100 points worth of the local currency in store %s (%s, %s)',
    async (storeKey, currency, country) => {
      await backend.grant(email, 10_000);
      cart = await ct.createCart({ email, storeKey, currency, country });
      const sessionId = await ct.createSession(cart.id);
      const before = cart.totalPrice.centAmount;

      const balance = await routes.post('/balance', sessionId, { code: '' });
      expect(balance.status).toBe(200);
      const points = Math.min(100, (balance.body as { points: number }).points);
      expect(points).toBeGreaterThan(0);
      const redeemAmount = Math.round((points / 100) * (balance.body as { amount: { centAmount: number } }).amount.centAmount);

      const redeemed = await routes.post('/redeem', sessionId, {
        code: 'points',
        redeemAmount: { centAmount: redeemAmount, currencyCode: currency },
      });

      expect(redeemed.status).toBe(200);
      const after = await ct.getCart(cart.id);
      expect(after.totalPrice.centAmount).toBe(before - redeemAmount);
      expect(after.custom?.fields?.loyaltyRedemptionId).toBeDefined();
    },
  );
});

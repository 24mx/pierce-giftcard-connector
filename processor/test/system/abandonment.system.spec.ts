import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { RedeemResponse } from '../../../packages/loyalty-connector-contract/src';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';

describeSystem('an abandoned checkout', () => {
  const env = systemEnv()!;
  const ct = commercetools(env);
  const backend = loyalty(env);
  const routes = processor(env);

  // Every denomination discount is scoped to a Store, so a storeless cart never gets one to apply.
  const store = env.loyaltyStores[0];

  let email: string;
  let cart: Cart | undefined;
  let sessionId: string;

  beforeEach(async () => {
    email = testEmail();
    await backend.grant(email, 10_000);
    cart = await ct.createCart({
      email,
      storeKey: store.storeKey,
      currency: store.currency,
      country: store.country,
    });
    sessionId = await ct.createSession(cart!.id);
  });

  afterEach(async () => {
    // Cleanup runs even after a failed assertion, and the cart goes even when the release call fails:
    // a leaked hold trips the staging stuck-reservation alarm, a leaked cart is just litter.
    try {
      await backend.releaseAll(email);
    } finally {
      if (cart) {
        await ct.deleteCart(cart);
      }
      cart = undefined;
    }
  });

  test('the sweep clears the cart and gives the points back', async () => {
    const before = cart!.totalPrice.centAmount;
    const balanceBefore = (await backend.balance(email)).points;
    const redeemed = await routes.post<RedeemResponse>('/redeem', sessionId, {
      code: 'points',
      redeemAmount: { centAmount: 700, currencyCode: store.currency },
    });
    expect(redeemed.status).toBe(200);

    // The shopper walks away. Sweep this customer's holds "open right now" instead of waiting one TTL.
    await backend.sweepFor(email);

    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBeUndefined();
    expect(after.totalPrice.centAmount).toBe(before);
    expect((await backend.balance(email)).points).toBe(balanceBefore);
    expect(await backend.releaseAll(email)).toEqual({ released: [], locked: [] });
  });
});

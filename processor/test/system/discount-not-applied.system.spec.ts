import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor, ProcessorError } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';
const DISCOUNT_KEY_PREFIX = process.env.LOYALTY_DISCOUNT_KEY_PREFIX || 'loyalty-';
/** 3 = D1 + D2: turning D1 off makes the drop 2 instead of 3, which the processor must refuse. */
const AMOUNT_CENTS = 3;

describeSystem('a denomination discount that does not fire', () => {
  const env = systemEnv()!;
  const ct = commercetools(env);
  const backend = loyalty(env);
  const routes = processor(env);

  // Every denomination discount is scoped to a Store, so a storeless cart never gets one to apply,
  // and the discount key itself carries the store: `loyalty-<storeKey>-D1`, not `loyalty-D1`.
  const store = env.loyaltyStores[0];
  const DISABLED_DISCOUNT = `${DISCOUNT_KEY_PREFIX}${store.storeKey}-D1`;

  let email: string;
  let cart: Cart | undefined;
  let sessionId: string;

  beforeAll(async () => {
    await ct.setDiscountActive(DISABLED_DISCOUNT, false);
  });

  afterAll(async () => {
    // Always: a D1 left inactive breaks every odd-cent redeem on staging until someone notices.
    await ct.setDiscountActive(DISABLED_DISCOUNT, true);
  });

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

  test('redeem is 409 DiscountNotApplied, the hold is voided and the cart carries nothing', async () => {
    const before = cart!.totalPrice.centAmount;
    const balanceBefore = (await backend.balance(email)).points;

    const reply = await routes.post<ProcessorError>('/redeem', sessionId, {
      code: 'points',
      redeemAmount: { centAmount: AMOUNT_CENTS, currencyCode: store.currency },
    });

    expect(reply.status).toBe(409);
    expect(reply.body.status.state).toBe('DiscountNotApplied');
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields?.[REDEMPTION_ID_FIELD]).toBeUndefined();
    expect(after.totalPrice.centAmount).toBe(before);
    expect((await backend.balance(email)).points).toBe(balanceBefore);
    expect(await backend.releaseAll(email)).toEqual({ released: [], locked: [] });
  });
});

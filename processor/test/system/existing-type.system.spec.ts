import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { RedeemResponse } from '../../../packages/loyalty-connector-contract/src';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';

describeSystem('a cart that already carries the storefront cart type', () => {
  const env = systemEnv()!;
  const ct = commercetools(env);
  const backend = loyalty(env);
  const routes = processor(env);

  let email: string;
  let cart: Cart | undefined;
  let sessionId: string;

  beforeEach(async () => {
    email = testEmail();
    await backend.grant(email, 10_000);
    cart = await ct.createCart({ email, withStorefrontType: true });
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

  test('keeps its type and only gains the two fields', async () => {
    const typeIdBefore = cart!.custom!.type.id;

    const reply = await routes.post<RedeemResponse>('/redeem', sessionId, {
      code: 'points',
      redeemAmount: { centAmount: 300, currencyCode: env.currency },
    });

    expect(reply.status).toBe(200);
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.type.id).toBe(typeIdBefore);
    expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBe(reply.body.redemptionId);
  });
});

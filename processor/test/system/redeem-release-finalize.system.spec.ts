import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Cart } from '@commercetools/platform-sdk';
import { FinalizeResponse, RedeemResponse, ReleaseResponse } from '../../../packages/loyalty-connector-contract/src';
import { commercetools } from './support/commercetools';
import { describeSystem, systemEnv, testEmail } from './support/env';
import { loyalty } from './support/loyalty';
import { processor, ProcessorError } from './support/processor';

const REDEMPTION_ID_FIELD = process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId';
const DENOMINATIONS_FIELD = process.env.LOYALTY_DENOMINATIONS_FIELD || 'loyaltyRedemption';
const GRANT = 100_000;
const CARD_FLOOR_CENTS = 100;

describeSystem('redeem → release → finalize against a deployed processor', () => {
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
    await backend.grant(email, GRANT);
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

  /** Well under the cart's total, well above the EUR 1 the card must still pay. */
  const redeemableCents = () => Math.min(cart!.totalPrice.centAmount - 2 * CARD_FLOOR_CENTS, 5000);

  const redeem = (centAmount: number) =>
    routes.post<RedeemResponse>('/redeem', sessionId, {
      code: 'points',
      redeemAmount: { centAmount, currencyCode: store.currency },
    });

  test('redeem takes exactly the amount off the gross total and debits the balance', async () => {
    const before = cart!.totalPrice.centAmount;
    const cents = redeemableCents();
    const balanceBefore = (await backend.balance(email)).points;

    const reply = await redeem(cents);

    expect(reply.status).toBe(200);
    expect(reply.body.appliedAmount.centAmount).toBe(cents);
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBe(reply.body.redemptionId);
    expect(after.custom?.fields[DENOMINATIONS_FIELD]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^D\d+$/)]),
    );
    expect(after.totalPrice.centAmount).toBe(before - cents);
    expect((await backend.balance(email)).points).toBe(balanceBefore - reply.body.points);
  });

  test('release clears the fields, restores the total and credits the balance back', async () => {
    const before = cart!.totalPrice.centAmount;
    const balanceBefore = (await backend.balance(email)).points;
    const redeemed = await redeem(redeemableCents());
    expect(redeemed.status).toBe(200);

    const released = await routes.post<ReleaseResponse>('/release', sessionId, {
      redemptionId: redeemed.body.redemptionId,
    });

    expect(released.status).toBe(200);
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBeUndefined();
    expect(after.custom?.fields[DENOMINATIONS_FIELD]).toBeUndefined();
    expect(after.totalPrice.centAmount).toBe(before);
    expect((await backend.balance(email)).points).toBe(balanceBefore);
  });

  test('release after finalize is 409 FinalizationInProgress and changes nothing', async () => {
    const redeemed = await redeem(redeemableCents());
    expect(redeemed.status).toBe(200);
    const totalWithPoints = (await ct.getCart(cart!.id)).totalPrice.centAmount;

    const finalized = await routes.post<FinalizeResponse>('/finalize', sessionId, {
      redemptionId: redeemed.body.redemptionId,
    });
    expect(finalized.status).toBe(200);

    const released = await routes.post<ProcessorError>('/release', sessionId, {
      redemptionId: redeemed.body.redemptionId,
    });

    expect(released.status).toBe(409);
    expect(released.body.status.state).toBe('FinalizationInProgress');
    const after = await ct.getCart(cart!.id);
    expect(after.custom?.fields[REDEMPTION_ID_FIELD]).toBe(redeemed.body.redemptionId);
    expect(after.totalPrice.centAmount).toBe(totalWithPoints);
    // afterEach's releaseAll reports this one as locked; the lock expires on its own (staging: 30 s).
  });

  test('release of an id the cart does not carry is 404 RedemptionNotOnCart', async () => {
    const reply = await routes.post<ProcessorError>('/release', sessionId, {
      redemptionId: '00000000-0000-4000-8000-000000000000',
    });

    expect(reply.status).toBe(404);
    expect(reply.body.status.state).toBe('RedemptionNotOnCart');
  });
});

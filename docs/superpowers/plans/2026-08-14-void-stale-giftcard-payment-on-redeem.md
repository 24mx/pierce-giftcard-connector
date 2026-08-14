# Void Stale Giftcard Payment On Redeem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `redeem()` from stacking a new giftcard `Payment` + loyalty hold on top of an already-open one from an earlier, abandoned redemption attempt on the same cart.

**Architecture:** Before `redeem()` creates a new CT `Payment` and calls `LoyaltyAPI().hold()`, it fetches the cart with its payments expanded, finds any already-attached giftcard `Payment` that is still "open" (method `giftcard`, no successful `Refund` transaction yet), and closes it the same way `cancelPayment`/`refundPayment`/`reversePayment` already do — by reusing the existing private `revertCoverageAndCloseHold()` helper (writes a `Refund` transaction on the stale CT Payment, then calls `LoyaltyAPI().voidHold()`). There is no CT API to detach a payment reference from a cart, so the stale payment stays attached but reverted to zero coverage, exactly like a manual cancel today. This closes the gap where a page refresh during checkout orphans the previous hold: instead of waiting on the loyalty backend's TTL sweep (or, worse, both holds surviving to be captured together if an order completes before the sweep runs), the stale hold is released synchronously as part of the very next redeem call.

**Tech Stack:** TypeScript, Jest (`@jest/globals`), MSW (`msw/node`) for HTTP-level mocking of the loyalty backend, `@commercetools/connect-payments-sdk` (`DefaultCartService`/`DefaultPaymentService`, mocked via `jest.spyOn(...prototype...)`).

## Global Constraints

- Work happens entirely in `processor/` (run `npm test` from `/Users/krzysztofpawlak/JsProjects/pierce-loyalty-giftcard-connector/processor`; the script is `jest --detectOpenHandles`).
- No new npm dependencies, no DI container — this codebase wires services via plain constructor injection (`MockGiftCardServiceOptions`) and calls `LoyaltyAPI()` as a bare factory function, not injected.
- CT SDK calls are mocked exactly as the existing suite does it: `jest.spyOn(DefaultCartService.prototype, 'getCart' | 'addPayment')` and `jest.spyOn(DefaultPaymentService.prototype, 'createPayment' | 'updatePayment' | 'getPayment')`, imported from `@commercetools/connect-payments-sdk/dist/commercetools/services/ct-{cart,payment}.service`. Do not introduce a different mocking style.
- The loyalty backend is mocked at the HTTP layer via MSW (`mockServer.use(http.post(...))`), never by mocking the `LoyaltyClient`/`LoyaltyAPI` module directly.
- Reuse the existing private `revertCoverageAndCloseHold()` in `mock-giftcard.service.ts` for closing the stale payment — do not duplicate its "write Refund transaction, then best-effort `voidHold`, swallow `voidHold` failures" logic.
- Do not change the behavior of `cancelPayment`/`refundPayment`/`reversePayment`/`modifyPayment` — all existing tests in the `modifyPayment` describe block must keep passing unmodified.
- Identify a giftcard payment by `paymentMethodInfo.method === 'giftcard'`, not by `paymentInterface` — the interface string is request-context-dependent (`getPaymentInterfaceFromContext()`), `method` is the stable tag (see `createPaymentResultOk` fixture: `paymentInterface: 'voucherify'`, `method: 'giftcard'`).
- Every step that touches `mock-giftcard.service.ts` or its spec file ends with `npm test` (scoped to the file where possible: `npx jest test/mock-giftcard.service.spec.ts`) run clean before moving on.

---

## Task 1: Test fixtures for a cart carrying an existing giftcard payment

**Files:**
- Modify: `processor/test/mocks/coco.ts`

**Interfaces:**
- Produces: `getCartWithCustomerEmail(customerEmail: string, overrides?: Partial<Cart>): Cart` (extends the existing single-arg signature backward-compatibly), `openGiftCardPaymentFixture(overrides?: Partial<Payment>): Payment`.

This is test infrastructure only (no behavior to assert yet), so there's no RED/GREEN cycle — add it, typecheck, commit.

- [ ] **Step 1: Extend `getCartWithCustomerEmail` to accept cart overrides**

In `processor/test/mocks/coco.ts`, replace:

```ts
/** Cart of an identified customer, in the currency the loyalty backend supports. */
export const getCartWithCustomerEmail = (customerEmail: string) =>
  getCartOK({
    customerEmail,
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'EUR',
      centAmount: 4999,
      fractionDigits: 2,
    },
  });
```

with:

```ts
/** Cart of an identified customer, in the currency the loyalty backend supports. */
export const getCartWithCustomerEmail = (customerEmail: string, overrides: Partial<Cart> = {}) =>
  getCartOK({
    customerEmail,
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'EUR',
      centAmount: 4999,
      fractionDigits: 2,
    },
    ...overrides,
  });
```

- [ ] **Step 2: Add a fixture for an already-attached giftcard payment**

Append to `processor/test/mocks/coco.ts`:

```ts
/**
 * A giftcard `Payment` already attached to a cart from a prior redeem() call — the shape needed to
 * simulate "the shopper redeemed points, abandoned checkout, and is redeeming again."
 */
export const openGiftCardPaymentFixture = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'stale-giftcard-payment',
  version: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
  lastModifiedAt: '2024-01-01T00:00:00.000Z',
  interfaceId: 'STALE_REDEMPTION_ID',
  amountPlanned: {
    type: 'centPrecision',
    currencyCode: 'EUR',
    centAmount: 2000,
    fractionDigits: 2,
  },
  paymentMethodInfo: {
    paymentInterface: 'pierce-loyalty-giftcard',
    method: 'giftcard',
  },
  paymentStatus: {},
  transactions: [
    {
      id: 'STALE_TXN_CHARGE',
      type: 'Charge',
      amount: {
        type: 'centPrecision',
        currencyCode: 'EUR',
        centAmount: 2000,
        fractionDigits: 2,
      },
      interactionId: 'STALE_REDEMPTION_ID',
      state: 'Success',
    },
  ],
  interfaceInteractions: [],
  ...overrides,
});
```

- [ ] **Step 3: Typecheck**

Run: `cd processor && npx tsc --noEmit`
Expected: no errors (existing single-arg `getCartWithCustomerEmail('...')` call sites still compile because `overrides` defaults to `{}`).

- [ ] **Step 4: Commit**

```bash
git add processor/test/mocks/coco.ts
git commit -m "test: add fixtures for a cart carrying an existing giftcard payment"
```

---

## Task 2: Void a stale open giftcard payment before creating a new redemption

**Files:**
- Modify: `processor/src/services/mock-giftcard.service.ts`
- Test: `processor/test/mock-giftcard.service.spec.ts`

**Interfaces:**
- Consumes: `openGiftCardPaymentFixture`, `getCartWithCustomerEmail(customerEmail, overrides)` from Task 1.
- Produces: two new private methods on `MockGiftCardService` — `isOpenGiftCardPayment(payment: Payment): boolean` and `voidStaleGiftCardPayments(ctCart: Cart): Promise<void>` — and a changed `getCart` call inside `redeem()` (now passes `expand: ['paymentInfo.payments[*]']`).

- [ ] **Step 1: Write the failing test**

In `processor/test/mock-giftcard.service.spec.ts`, add this import at the top alongside the existing fixture imports:

```ts
import {
  createPaymentResultOk,
  getCartOK,
  getCartWithCustomerEmail,
  getPaymentResultOk,
  openGiftCardPaymentFixture,
  updatePaymentResultOk,
} from './mocks/coco';
```

Then add this test inside the `describe('redeem', ...)` block, after the existing `'holds the points before writing the transaction that covers the cart'` test:

```ts
    test('voids an existing open giftcard payment on the cart before creating a new redemption', async () => {
      setupLoyaltyConfig();
      const stalePayment = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: stalePayment.id, obj: stalePayment }] },
      });
      const callOrder: string[] = [];

      const getCart = jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockImplementation(async (opts) => {
          callOrder.push(`updatePayment:${opts.id}:${opts.transaction.type}`);
          return updatePaymentResultOk;
        });

      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async () => {
          callOrder.push('void');
          return HttpResponse.json({ paymentId: stalePayment.id, points: 2000, balance: 2000 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, async () => {
          callOrder.push('hold');
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(getCart).toHaveBeenCalledWith(expect.objectContaining({ expand: ['paymentInfo.payments[*]'] }));
      expect(callOrder).toStrictEqual([
        `updatePayment:${stalePayment.id}:Refund`,
        'void',
        'hold',
        `updatePayment:${createPaymentResultOk.id}:Charge`,
      ]);
      expect(updatePayment).toHaveBeenCalledWith({
        id: stalePayment.id,
        transaction: { type: 'Refund', amount: stalePayment.amountPlanned, state: 'Success' },
      });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd processor && npx jest test/mock-giftcard.service.spec.ts -t "voids an existing open giftcard payment"`
Expected: FAIL — `getCart` was not called with an `expand` option (today's `redeem()` calls `getCart({ id: ... })` with no `expand`), and `callOrder` does not contain `'void'` or a `Refund` update for `stale-giftcard-payment` (nothing in `redeem()` looks at `paymentInfo.payments` today).

- [ ] **Step 3: Write minimal implementation**

In `processor/src/services/mock-giftcard.service.ts`, change the start of `redeem()` from:

```ts
  async redeem(opts: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });
    const userId = this.getLoyaltyUserId(ctCart);
```

to:

```ts
  async redeem(opts: { data: RedeemRequestDTO }): Promise<RedeemResponseDTO> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
      expand: ['paymentInfo.payments[*]'],
    });

    // A prior redeem() on this cart may still have an open giftcard payment attached (e.g. the
    // shopper redeemed, abandoned checkout, and is redeeming again) — close it the same way a
    // manual cancelPayment would, so it never survives to be captured alongside the new one.
    await this.voidStaleGiftCardPayments(ctCart);

    const userId = this.getLoyaltyUserId(ctCart);
```

Then add these two private methods right after `getLoyaltyUserId` (before `toConnectorError`):

```ts
  private isOpenGiftCardPayment(payment: Payment): boolean {
    if (payment.paymentMethodInfo.method !== 'giftcard') {
      return false;
    }
    return !payment.transactions.some((transaction) => transaction.type === 'Refund' && transaction.state === 'Success');
  }

  private async voidStaleGiftCardPayments(ctCart: Cart): Promise<void> {
    const stalePayments = (ctCart.paymentInfo?.payments ?? [])
      .map((paymentReference) => paymentReference.obj)
      .filter((payment): payment is Payment => !!payment && this.isOpenGiftCardPayment(payment));

    for (const stalePayment of stalePayments) {
      await this.revertCoverageAndCloseHold({
        payment: stalePayment,
        amount: stalePayment.amountPlanned,
        action: 'redeem',
      });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd processor && npx jest test/mock-giftcard.service.spec.ts -t "voids an existing open giftcard payment"`
Expected: PASS

- [ ] **Step 5: Run the full spec file to confirm no regressions**

Run: `cd processor && npx jest test/mock-giftcard.service.spec.ts`
Expected: all tests pass, including the pre-existing `redeem` and `modifyPayment` describe blocks (they never populate `paymentInfo`, so `ctCart.paymentInfo?.payments ?? []` is `[]` for them and `voidStaleGiftCardPayments` is a no-op).

- [ ] **Step 6: Commit**

```bash
git add processor/src/services/mock-giftcard.service.ts processor/test/mock-giftcard.service.spec.ts
git commit -m "fix(giftcard): void a stale open giftcard payment before redeeming again"
```

---

## Task 3: Lock in the fix's scope with regression tests

These three tests should already pass against Task 2's implementation — they exist to guard `isOpenGiftCardPayment`/`voidStaleGiftCardPayments` against silently growing too broad (e.g. someone later removing the `method === 'giftcard'` filter, or the "already refunded" check) as the code evolves. Run them immediately after writing them; if any of them is *not* green, that's a sign Task 2's implementation is scoped incorrectly — stop and fix Task 2 rather than adjusting these tests to match.

**Files:**
- Test: `processor/test/mock-giftcard.service.spec.ts`

**Interfaces:**
- Consumes: `isOpenGiftCardPayment`/`voidStaleGiftCardPayments` from Task 2 (indirectly, through `redeem()`).

- [ ] **Step 1: Add the three regression tests**

Add inside the `describe('redeem', ...)` block, after the test from Task 2:

```ts
    test('does not re-void a giftcard payment that already has a successful Refund transaction', async () => {
      setupLoyaltyConfig();
      const alreadyVoidedPayment = openGiftCardPaymentFixture({
        id: 'already-voided-payment',
        transactions: [
          {
            id: 'TXN_CHARGE',
            type: 'Charge',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
          {
            id: 'TXN_REFUND',
            type: 'Refund',
            amount: { type: 'centPrecision', currencyCode: 'EUR', centAmount: 2000, fractionDigits: 2 },
            interactionId: 'STALE_REDEMPTION_ID',
            state: 'Success',
          },
        ],
      });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: alreadyVoidedPayment.id, obj: alreadyVoidedPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(updatePayment).toHaveBeenCalledTimes(1);
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: { type: 'Charge', amount: createPaymentResultOk.amountPlanned, state: 'Success' },
      });
    });

    test('does not touch a non-giftcard payment already on the cart', async () => {
      setupLoyaltyConfig();
      const cardPayment = { ...getPaymentResultOk, id: 'existing-card-payment' };
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: cardPayment.id, obj: cardPayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      await mockGiftCardService.redeem(redeemOpts);

      expect(updatePayment).toHaveBeenCalledTimes(1);
      expect(updatePayment).toHaveBeenCalledWith({
        id: createPaymentResultOk.id,
        transaction: { type: 'Charge', amount: createPaymentResultOk.amountPlanned, state: 'Success' },
      });
    });

    test('still creates the new redemption when releasing the stale hold fails', async () => {
      setupLoyaltyConfig();
      const stalePayment = openGiftCardPaymentFixture({ id: 'stale-giftcard-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        paymentInfo: { payments: [{ typeId: 'payment', id: stalePayment.id, obj: stalePayment }] },
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(updatePaymentResultOk);
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () => HttpResponse.error()),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () =>
          HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 }),
        ),
      );

      const result = await mockGiftCardService.redeem(redeemOpts);

      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
      });
    });
```

- [ ] **Step 2: Run the full spec file**

Run: `cd processor && npx jest test/mock-giftcard.service.spec.ts`
Expected: PASS (all three new tests green against the Task 2 implementation, no other test broken).

- [ ] **Step 3: Run the full processor test suite**

Run: `cd processor && npm test`
Expected: PASS, no other spec file touches `mock-giftcard.service.ts` behavior.

- [ ] **Step 4: Commit**

```bash
git add processor/test/mock-giftcard.service.spec.ts
git commit -m "test(giftcard): lock in scope of the stale-giftcard-payment void on redeem"
```

---

## Task 4: Lint and final full-suite check

**Files:** none (verification only)

- [ ] **Step 1: Run lint**

Run: `cd processor && npm run lint`
Expected: no errors. If prettier flags formatting on the new code, run `npx prettier --write src/services/mock-giftcard.service.ts test/mock-giftcard.service.spec.ts test/mocks/coco.ts` and re-run lint.

- [ ] **Step 2: Run the full test suite one more time**

Run: `cd processor && npm test`
Expected: PASS.

- [ ] **Step 3: Commit if lint/prettier made changes**

```bash
git add -A
git commit -m "chore: apply lint/format fixes"
```

(Skip this step if lint made no changes.)

---

## Out of scope (tracked separately, not part of this plan)

- The SvelteKit checkout UI (`ecom-fe-sveltekit`) still loses its local `applied` redemption state on page refresh, so the "Apply" button re-enables even when the backend now correctly cleans up the stale hold. That's a separate, already-discussed follow-up (rehydrate `applied` from the cart's current giftcard payment on mount) and is not needed for this plan's fix to be correct — this plan makes the *backend* self-healing regardless of what the UI shows.
- The `pierce-loyalty` backend's own `GiftcardOrderSignal`/`GiftcardReconciliation` capture-everything-referenced-on-the-order behavior is unchanged by this plan. This plan prevents stale payments from *staying attached in an open state* long enough to reach that capture path in the first place, which is the more targeted fix — it does not add cross-payment awareness to the capture logic itself.

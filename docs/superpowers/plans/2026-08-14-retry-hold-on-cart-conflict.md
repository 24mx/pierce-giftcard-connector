# Retry Hold On Cart Conflict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the loyalty backend refuses `hold()` with 409 because the cart already has a different open reservation (a new, database-enforced invariant on the `pierce-loyalty` side — see its companion plan `2026-08-14-reject-second-open-hold-per-cart.md`), `redeem()` reverts that specific reservation on commercetools and retries the hold exactly once, instead of surfacing a generic "insufficient funds" error for a shopper who actually has enough points.

**Architecture:** This plan depends on `pierce-loyalty`'s companion plan being implemented and deployed first: `POST /loyalty/giftcard/hold` must already return `409 { "error": "...", "existingPaymentId": "..." }` for a same-cart conflict (as opposed to today's only 409 case, `{ "error": "..." }` with no `existingPaymentId`, for insufficient points). This connector currently has no way to see that field at all — `LoyaltyApiError` only carries `status` and a message string, the parsed response body is discarded after building the message. Three small, mechanical steps close that gap and add the retry: (1) widen the client-level types to carry the body through, (2) teach `redeem()`'s error handling to recognize the new conflict shape and distinguish it from the existing "insufficient funds" 409 (same HTTP status, different body shape — must not be confused), (3) on that specific conflict, fetch the named CT Payment and close it via the already-existing `revertCoverageAndCloseHold` (the exact same routine `voidStaleGiftCardPayments` already uses), then retry `hold()` once.

This is a backstop, not the primary defense — `voidStaleGiftCardPayments` (already on this branch) already proactively closes any stale giftcard payment attached to the cart *as this connector currently sees it* before ever calling `hold()`. This retry only fires for what that proactive check cannot see: a genuinely concurrent `redeem()` call racing on the same cart, or `voidStaleGiftCardPayments`'s own `voidHold` call having silently failed (a tolerated, logged failure, per the existing `revertCoverageAndCloseHold` design). In ordinary sequential use (one shopper, one tab) this code path should never execute at all.

**This plan is stacked on top of the existing branch `fix/void-stale-giftcard-payment-on-redeem`** (worktree: `.worktrees/fix-void-stale-giftcard-payment-on-redeem`, currently at commit `45d6f0d`, not yet merged) — it depends directly on `voidStaleGiftCardPayments`/`isOpenGiftCardPayment`/`revertCoverageAndCloseHold` already present there. Execute these tasks as additional commits on that same branch, not a fresh one off `main`.

**Tech Stack:** TypeScript, Jest (`@jest/globals`) + MSW (`msw/node`) for HTTP-level mocking of the loyalty backend, `@commercetools/connect-payments-sdk` (`DefaultCartService`/`DefaultPaymentService`, mocked via `jest.spyOn(...prototype...)`).

## Global Constraints

- Work happens in `.worktrees/fix-void-stale-giftcard-payment-on-redeem/processor/` (run `npm test` there; the script is `jest --detectOpenHandles`).
- No new npm dependencies.
- CT SDK calls are mocked exactly as the existing suite does it: `jest.spyOn(DefaultCartService.prototype, ...)` / `jest.spyOn(DefaultPaymentService.prototype, ...)`. The loyalty backend is mocked at the HTTP layer via MSW (`mockServer.use(http.post(...))`), never by mocking the `LoyaltyClient`/`LoyaltyAPI` module directly.
- MUST NOT change the meaning of the existing "insufficient points" 409 (a 409 body with `{ "error": "..." }` and no `existingPaymentId`) — it must keep mapping to `MockCustomError` with `code: 'InsufficientFunds'`, exactly as the existing test `writes no transaction when the points are not sufficient` (`processor/test/mock-giftcard.service.spec.ts`) already asserts, unmodified.
- MUST reuse the existing private `revertCoverageAndCloseHold()` for closing the conflicting payment — do not duplicate its "write Refund transaction, then best-effort voidHold, swallow voidHold failures" logic.
- MUST retry `hold()` at most once. If the retry itself also fails (including with another cart-conflict 409), the whole `redeem()` call fails via the existing `toConnectorError()` mapping — no unbounded retry loop.
- `LoyaltyApiError`'s existing `status`/`message` fields and construction sites elsewhere in the codebase (`balance()`'s catch block, `revertCoverageAndCloseHold`'s catch block) must keep compiling and behaving identically; the new `body` field is additive.

---

## Task 1: Carry the loyalty backend's response body through `LoyaltyApiError`

**Files:**
- Modify: `processor/src/clients/types/loyalty.client.type.ts`
- Modify: `processor/src/errors/loyalty-api.error.ts`
- Modify: `processor/src/clients/loyalty.client.ts`

**Interfaces:**
- Produces: `LoyaltyErrorResponse` widened with `existingPaymentId?: string`. `LoyaltyApiError` gains `readonly body?: LoyaltyErrorResponse`, populated by `send<T>`. Task 2 consumes `e.body?.existingPaymentId` to distinguish the two 409 cases.

This is a pure plumbing change with no new observable behavior yet (nothing reads `body` until Task 2) — verified by the existing loyalty-client test suite staying green, not a new RED/GREEN cycle of its own.

- [ ] **Step 1: Widen the error response type**

In `processor/src/clients/types/loyalty.client.type.ts`, replace:

```ts
/** Error body returned by the loyalty backend for every non-2xx response. */
export type LoyaltyErrorResponse = {
  error?: string;
};
```

with:

```ts
/** Error body returned by the loyalty backend for every non-2xx response. */
export type LoyaltyErrorResponse = {
  error?: string;
  /** Present only on the /hold 409 for "this cart already has a different open reservation". */
  existingPaymentId?: string;
};
```

- [ ] **Step 2: Add `body` to `LoyaltyApiError`**

Read the current full file `processor/src/errors/loyalty-api.error.ts` first (it is small — a single class). Add an import for `LoyaltyErrorResponse` from `../clients/types/loyalty.client.type`, add a `public readonly body?: LoyaltyErrorResponse` field, and accept `body` in the constructor options, assigning it alongside `status`. Keep every existing field, the existing JSDoc, and the existing behavior for callers that don't pass `body` (it stays `undefined`, exactly as today).

- [ ] **Step 3: Plumb the parsed body through `send<T>`**

In `processor/src/clients/loyalty.client.ts`, replace:

```ts
    if (!response.ok) {
      throw new LoyaltyApiError({
        status: response.status,
        message: await this.readErrorMessage(response),
      });
    }

    return (await response.json()) as T;
  }

  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as LoyaltyErrorResponse;
      return body?.error || `loyalty backend responded with ${response.status}`;
    } catch {
      return `loyalty backend responded with ${response.status}`;
    }
  }
```

with:

```ts
    if (!response.ok) {
      const body = await this.readErrorBody(response);
      throw new LoyaltyApiError({
        status: response.status,
        message: body?.error || `loyalty backend responded with ${response.status}`,
        body,
      });
    }

    return (await response.json()) as T;
  }

  private async readErrorBody(response: Response): Promise<LoyaltyErrorResponse | undefined> {
    try {
      return (await response.json()) as LoyaltyErrorResponse;
    } catch {
      return undefined;
    }
  }
```

(`readErrorMessage` is renamed `readErrorBody` and now returns the parsed body itself rather than a message string — `send<T>` builds the message inline from `body?.error`, with the exact same fallback string as before.)

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npx jest test/mock-giftcard.service.spec.ts`
Expected: PASS, no changes needed to any existing test — this step only proves the plumbing change didn't alter any existing behavior (every existing `LoyaltyApiError` construction site still compiles and every existing message-based assertion still holds, since the fallback string logic is unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add processor/src/clients/types/loyalty.client.type.ts processor/src/errors/loyalty-api.error.ts processor/src/clients/loyalty.client.ts
git commit -m "feat(giftcard): carry the loyalty backend's error body through LoyaltyApiError"
```

---

## Task 2: Detect the cart-conflict 409 and revert-then-retry once

**Files:**
- Modify: `processor/src/services/mock-giftcard.service.ts`
- Test: `processor/test/mock-giftcard.service.spec.ts`

**Interfaces:**
- Consumes: `LoyaltyApiError.body` from Task 1.
- Produces: two new private methods on `MockGiftCardService` — `isCartAlreadyHeldConflict(e: unknown): boolean` and `voidConflictingHold(paymentId: string): Promise<void>` — and a changed `redeem()` that retries `hold()` once after voiding the named conflicting payment.

- [ ] **Step 1: Write the failing test**

In `processor/test/mock-giftcard.service.spec.ts`, add this test inside the `describe('redeem', ...)` block, after the existing `'zeroes the CT coverage amount...'` test and before `'writes no transaction when the points are not sufficient'`:

```ts
    test('voids the conflicting hold named by a 409 and retries once', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com');
      const callOrder: string[] = [];

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(conflictingPayment);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(async (opts) => {
        callOrder.push(`updatePayment:${opts.id}:${opts.transaction.type}`);
        return updatePaymentResultOk;
      });

      let holdCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          callOrder.push(`hold${holdCalls}`);
          if (holdCalls === 1) {
            return HttpResponse.json(
              { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
              { status: 409 },
            );
          }
          return HttpResponse.json({ paymentId: createPaymentResultOk.id, points: 2400, balance: 200 });
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, async () => {
          callOrder.push('void');
          return HttpResponse.json({ paymentId: conflictingPayment.id, points: 2000, balance: 2000 });
        }),
      );

      const result = await mockGiftCardService.redeem(redeemOpts);

      expect(callOrder).toStrictEqual([
        'hold1',
        `updatePayment:${conflictingPayment.id}:Refund`,
        'void',
        'hold2',
        `updatePayment:${createPaymentResultOk.id}:Charge`,
      ]);
      expect(result).toStrictEqual({
        result: 'Success',
        paymentReference: createPaymentResultOk.id,
        redemptionId: createPaymentResultOk.id,
      });
    });

    test('fails after exactly one retry when the conflict repeats', async () => {
      setupLoyaltyConfig();
      const conflictingPayment = openGiftCardPaymentFixture({ id: 'other-tab-payment' });
      const cart = getCartWithCustomerEmail('demo@example.com');

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(createPaymentResultOk);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(cart);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(conflictingPayment);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(updatePaymentResultOk);

      let holdCalls = 0;
      mockServer.use(
        http.post(`${LOYALTY_URL}/loyalty/giftcard/hold`, () => {
          holdCalls += 1;
          return HttpResponse.json(
            { error: 'cart already has an open reservation', existingPaymentId: conflictingPayment.id },
            { status: 409 },
          );
        }),
        http.post(`${LOYALTY_URL}/loyalty/giftcard/void`, () =>
          HttpResponse.json({ paymentId: conflictingPayment.id, points: 2000, balance: 2000 }),
        ),
      );

      const result = mockGiftCardService.redeem(redeemOpts);

      await expect(result).rejects.toThrow(MockCustomError);
      expect(holdCalls).toBe(2);
      // Only the Refund on the conflicting payment — no Charge was ever written for a new payment.
      expect(updatePayment).toHaveBeenCalledTimes(1);
    });
```

Add `openGiftCardPaymentFixture` to the existing fixture import if not already imported in this describe block's scope (it is already imported at the top of the file from the earlier `void-stale-giftcard-payment-on-redeem` work — confirm before adding a duplicate import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest test/mock-giftcard.service.spec.ts -t "conflicting hold"`
Expected: FAIL — today, ANY 409 from `hold()` (regardless of body shape) maps straight to `MockCustomError` with `code: 'InsufficientFunds'` via `toConnectorError`; `redeem()` never inspects `e.body.existingPaymentId`, never calls `getPayment`, never retries. The first test's `callOrder` assertion fails because no `void`/`hold2` ever happens; the second test's `holdCalls` stays at `1`, not `2`.

- [ ] **Step 3: Implement the retry**

In `processor/src/services/mock-giftcard.service.ts`, replace:

```ts
    try {
      await LoyaltyAPI().hold({
        userId,
        paymentId: ctPayment.id,
        cartId: ctCart.id,
        amount: redeemAmount,
        // Off the cart we just read, so the backend can enforce the EUR 1 card floor itself rather
        // than trusting the amount the checkout SDK handed us.
        cartTotal: {
          centAmount: ctCart.totalPrice.centAmount,
          currencyCode: ctCart.totalPrice.currencyCode,
        },
      });
    } catch (e) {
      // Includes an uncertain hold (timeout, 5xx): leaving the payment transaction-less is the only
      // outcome we can recover from, so never write the transaction here.
      throw this.toConnectorError(e);
    }
```

with:

```ts
    const holdRequest = {
      userId,
      paymentId: ctPayment.id,
      cartId: ctCart.id,
      amount: redeemAmount,
      // Off the cart we just read, so the backend can enforce the EUR 1 card floor itself rather
      // than trusting the amount the checkout SDK handed us.
      cartTotal: {
        centAmount: ctCart.totalPrice.centAmount,
        currencyCode: ctCart.totalPrice.currencyCode,
      },
    };

    try {
      await LoyaltyAPI().hold(holdRequest);
    } catch (e) {
      // The backend enforces at most one open hold per cart. This is the backstop for what
      // voidStaleGiftCardPayments above cannot see - a genuinely concurrent redeem on the same cart,
      // or its own voidHold call having silently failed - so retry exactly once after closing the
      // specific payment the backend named as the conflict.
      if (this.isCartAlreadyHeldConflict(e)) {
        await this.voidConflictingHold(e.body.existingPaymentId);
        try {
          await LoyaltyAPI().hold(holdRequest);
        } catch (retryError) {
          throw this.toConnectorError(retryError);
        }
      } else {
        // Includes an uncertain hold (timeout, 5xx): leaving the payment transaction-less is the only
        // outcome we can recover from, so never write the transaction here.
        throw this.toConnectorError(e);
      }
    }
```

Add these two private methods right after `voidStaleGiftCardPayments` (before `toConnectorError`):

```ts
  private isCartAlreadyHeldConflict(e: unknown): e is LoyaltyApiError & { body: { existingPaymentId: string } } {
    return e instanceof LoyaltyApiError && e.status === 409 && !!e.body?.existingPaymentId;
  }

  private async voidConflictingHold(paymentId: string): Promise<void> {
    const stalePayment = await this.ctPaymentService.getPayment({ id: paymentId });
    await this.revertCoverageAndCloseHold({
      payment: stalePayment,
      amount: stalePayment.amountPlanned,
      action: 'voidOnHoldConflict',
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest test/mock-giftcard.service.spec.ts -t "conflicting hold"` then `npx jest test/mock-giftcard.service.spec.ts -t "exactly one retry"`
Expected: both PASS.

- [ ] **Step 5: Run the full spec file to confirm no regressions**

Run: `npx jest test/mock-giftcard.service.spec.ts`
Expected: all tests pass, in particular `writes no transaction when the points are not sufficient` (the plain "insufficient funds" 409, body `{ "error": "..." }` with no `existingPaymentId`) must still map to `MockCustomError` / `InsufficientFunds` exactly as before — `isCartAlreadyHeldConflict` returns `false` for it since `e.body?.existingPaymentId` is `undefined`, so it falls through to the unchanged `else` branch.

- [ ] **Step 6: Commit**

```bash
git add processor/src/services/mock-giftcard.service.ts processor/test/mock-giftcard.service.spec.ts
git commit -m "feat(giftcard): revert the conflicting hold and retry once on a cart-conflict 409"
```

---

## Task 3: Lint and full-suite check

**Files:** none (verification only)

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: no errors. If prettier flags formatting, run `npx prettier --write` on the touched files and re-run lint.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit if lint/prettier made changes**

```bash
git add -A
git commit -m "chore: apply lint/format fixes"
```

(Skip this step if lint made no changes.)

---

## Dependency and rollout order

This connector's retry logic is safe to deploy BEFORE `pierce-loyalty` gains the new 409 shape: `isCartAlreadyHeldConflict` only fires when `existingPaymentId` is actually present in the body, which only happens once the backend sends it — until then, every 409 falls through to the unchanged `else` branch exactly as today. So this repo's change can ship first or second relative to its companion plan without a coordinated deploy window; it simply does nothing new until the backend starts sending the new field.

## Out of scope (tracked separately, in a different repo)

- The unique-per-cart enforcement itself, the new `GiftcardCartAlreadyHeldException`, and the `existingPaymentId` 409 body are `pierce-loyalty`'s side, planned in `2026-08-14-reject-second-open-hold-per-cart.md` in that repo.

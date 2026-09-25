# Per-store loyalty denominations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global, EUR-only set of 18 denomination `CartDiscount`s with per-Store provisioning, sized per currency, for three stores — `lu` (EUR, 18 levels), `ro` (RON, 21 levels), `se` (SEK, 22 levels) — so redemption works in non-EUR carts without competing for the project's nearly-exhausted global 100-active-automatic-discount budget.

**Architecture:** `denominations.ts` becomes level-count-parameterized instead of hard-coding 18; `config.ts` gains a `LOYALTY_DISCOUNT_STORES` list (`storeKey:currency:levels`) that both `loyalty-provisioning.ts` (which store to provision, in which currency, how many levels) and `loyalty-redemption.service.ts` (which levels a redeem's currency decomposes against) read from. Every denomination `CartDiscount` is now scoped to one Store (`stores: [{typeId:'store', key}]`) and keyed `loyalty-<storeKey>-Dn`, so each store's set lives inside that store's own separate 100-cap instead of the project-wide one. The cart's custom field content is unchanged (still the bare `"Dn"` key) — only the CT-side object identity and scope change.

**Tech Stack:** TypeScript, Fastify, `@commercetools/connect-payments-sdk` 1.2.0, `@commercetools/platform-sdk`, Jest + msw.

**Why per-store, not per-currency-global:** confirmed live against `pierce-prod` — 90 of the project's 91 active automatic discounts are already global (project-wide), leaving ~10 of the documented 100-cap ([Limits | API](https://docs.commercetools.com/api/limits)). Deploying 18+ more global discounts would blow past that. Every Store has its own separate, nearly-empty 100-cap ([Store-specific Cart Discounts](https://docs.commercetools.com/merchant-center/releases/2023-07-05-introduced-store-specific-cart-discounts)).

**Why per-currency level counts, not a uniform 18:** `MAX_DECOMPOSABLE_MINOR_UNITS` is currency-blind raw minor units, so the real EUR-equivalent ceiling shrinks with a currency's strength against EUR. To keep the same ~€2621 ceiling as EUR everywhere: RON (rateToEur ≈ 4.97) needs 21 levels (2²¹−1 = 2,097,151 ≥ 1,303,051 minor units), SEK (rateToEur ≈ 11.5) needs 22 (2²²−1 = 4,194,303 ≥ 3,014,645). This plan uses full 1-minor-unit precision (no rounding quantum) — deliberately deferring the "100-point-step" optimization (which would let every currency use the same, much smaller level count) until product/business confirms the step is a hard invariant, not just a storefront UI nicety.

**Spec:** `SUPPORT-41640` (`pierce-loyalty/doc/in/Loyalty program in CT - commercetools Product Support - Jira Service Management.md`) — commercetools' own recommendation confirms the denomination-CartDiscount model (not a negative custom line item, which silently drops marketing promotions — reproduced live: a −€30 points line dropped a cart below a promo's threshold and the promo vanished, losing the customer €15).

## Global Constraints

- Work in `.worktrees/cart-discount-redemption` (already checked out on branch `enabler-redemption-result`), `cd processor && npm ci` if `node_modules` is stale.
- **Do not commit.** The user commits (CLAUDE.md rule 20).
- Comments in English; braces on every `if`; no new runtime dependencies.
- Verification per task: `cd processor && npm run lint && npm test`. Full suite incl. build: `npm run build` at the end.
- Target environment for live steps: sandbox project `krzysztof-project-13` (credentials in `processor/.env`) — **not** `pierce-prod`.
- The three stores (`lu`, `ro`, `se`) already exist in the sandbox project with countries `LU`/`RO`/`SE`; the SKU `NR1BAG` already has standalone prices in EUR (LU) and RON (RO) but **not** SEK — Task 6 adds one.

---

### Task 1: Level-parameterized denominations

**Files:**
- Modify: `processor/src/services/denominations.ts`
- Modify: `processor/test/services/denominations.spec.ts`

**Interfaces:**
- Produces (replaces the current fixed-`DENOMINATION_COUNT` API):
  ```ts
  export const denominationKey = (minorUnits: number): string;                       // unchanged
  export const denominationKeys = (levels: number): string[];                        // now takes levels
  export const maxDecomposableMinorUnits = (levels: number): number;                 // replaces the constant
  export const denominationMinorUnits = (key: string): number;                       // unchanged signature, unbounded upper check dropped (no single global max to check against any more)
  export const decompose = (minorUnits: number, levels: number): string[];           // now takes levels
  export const sumDenominations = (keys: readonly string[]): number;                 // unchanged
  ```
- Consumed by: Task 3 (`loyalty-provisioning.ts`), Task 5 (`loyalty-redemption.service.ts`).

- [ ] **Step 1: Write the failing tests** — replace `test/services/denominations.spec.ts` entirely:

```ts
import { describe, expect, test } from '@jest/globals';
import {
  decompose,
  denominationKey,
  denominationKeys,
  denominationMinorUnits,
  maxDecomposableMinorUnits,
  sumDenominations,
} from '../../src/services/denominations';

describe('denominations', () => {
  test.each([
    [18, 262143, 'D131072'],
    [21, 2097151, 'D1048576'],
    [22, 4194303, 'D2097152'],
  ])('%d levels reach %d minor units, topping out at %s', (levels, max, topKey) => {
    expect(denominationKeys(levels)).toHaveLength(levels);
    expect(denominationKeys(levels)[0]).toBe('D1');
    expect(denominationKeys(levels)[levels - 1]).toBe(topKey);
    expect(maxDecomposableMinorUnits(levels)).toBe(max);
  });

  test.each([
    [1, 18, ['D1']],
    [2, 18, ['D2']],
    [1234, 18, ['D1024', 'D128', 'D64', 'D16', 'D2']],
    [262143, 18, denominationKeys(18).slice().reverse()],
    // RON/SEK ceiling checks: amounts that need more than 18 levels' worth of headroom, to prove the
    // extra levels are actually reachable, not just declared. Both vectors are the true binary
    // decomposition (verified with a throwaway Python script, not hand-computed) — do not "simplify".
    [1303051, 21, ['D1048576', 'D131072', 'D65536', 'D32768', 'D16384', 'D8192', 'D512', 'D8', 'D2', 'D1']],
    [3014645, 22, ['D2097152', 'D524288', 'D262144', 'D65536', 'D32768', 'D16384', 'D8192', 'D4096', 'D2048', 'D1024', 'D512', 'D256', 'D128', 'D64', 'D32', 'D16', 'D4', 'D1']],
  ])('decomposes %d at %d levels into %j', (amount, levels, keys) => {
    expect(decompose(amount, levels)).toStrictEqual(keys);
  });

  test('sumDenominations is the inverse of decompose', () => {
    for (const [amount, levels] of [
      [1, 18],
      [7, 18],
      [262143, 18],
      [2097151, 21],
      [4194303, 22],
    ] as const) {
      expect(sumDenominations(decompose(amount, levels))).toBe(amount);
    }
    expect(sumDenominations([])).toBe(0);
  });

  test.each([0, -5, 12.5, Number.NaN])('refuses %p regardless of levels', (amount) => {
    expect(() => decompose(amount, 18)).toThrow(RangeError);
  });

  test('refuses an amount above what the given level count reaches', () => {
    expect(() => decompose(262144, 18)).toThrow(RangeError);
    expect(() => decompose(2097152, 21)).toThrow(RangeError);
  });

  test('reads a denomination key back into minor units and rejects junk', () => {
    expect(denominationMinorUnits(denominationKey(512))).toBe(512);
    expect(() => denominationMinorUnits('loyalty')).toThrow(RangeError);
    expect(() => denominationMinorUnits('D3')).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd processor && npx jest test/services/denominations.spec.ts`
Expected: FAIL — `denominationKeys`/`decompose` called with the wrong arity, `maxDecomposableMinorUnits`/`DENOMINATION_COUNT` mismatch.

- [ ] **Step 3: Implement** — replace `src/services/denominations.ts` entirely:

```ts
/**
 * The points discount is composed from a fixed set of absolute-value CartDiscounts, one per power of
 * two of the cart currency's minor unit (D1 = 1 minor unit, D2, D4, …). The cart's `loyaltyRedemption`
 * custom field lists which of them apply, and every CartDiscount's predicate is
 * `custom.loyaltyRedemption contains "Dn"`. How many levels exist is a property of the CURRENCY, not a
 * global constant: a currency worth less per minor unit than EUR needs more levels to reach the same
 * real EUR-equivalent ceiling (see `config.ts`'s `loyaltyDiscountLevelsByCurrency`). The key always
 * names raw minor units, so the same key set is reusable across every currency that needs that many
 * levels, independent of which Store(s) actually provision it.
 */
const KEY_PATTERN = /^D(\d+)$/;

export const denominationKey = (minorUnits: number): string => `D${minorUnits}`;

export const denominationKeys = (levels: number): string[] =>
  Array.from({ length: levels }, (_, exponent) => denominationKey(2 ** exponent));

export const maxDecomposableMinorUnits = (levels: number): number => 2 ** levels - 1;

export const denominationMinorUnits = (key: string): number => {
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    throw new RangeError(`${key} is not a denomination key`);
  }
  const value = Number(match[1]);
  const isPowerOfTwo = (value & (value - 1)) === 0;
  if (!Number.isInteger(value) || value < 1 || !isPowerOfTwo) {
    throw new RangeError(`${key} is not a power-of-two denomination`);
  }
  return value;
};

/** Largest denominations first, so the list reads the way the amount is built. */
export const decompose = (minorUnits: number, levels: number): string[] => {
  if (!Number.isInteger(minorUnits) || minorUnits < 1) {
    throw new RangeError(`cannot decompose ${minorUnits}: a positive whole number of minor units is required`);
  }
  const max = maxDecomposableMinorUnits(levels);
  if (minorUnits > max) {
    throw new RangeError(`cannot decompose ${minorUnits}: ${levels} levels reach ${max} at most`);
  }
  const keys: string[] = [];
  for (let exponent = levels - 1; exponent >= 0; exponent--) {
    const value = 2 ** exponent;
    if ((minorUnits & value) !== 0) {
      keys.push(denominationKey(value));
    }
  }
  return keys;
};

export const sumDenominations = (keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + denominationMinorUnits(key), 0);
```

- [ ] **Step 4: Run to see it pass**

Run: `cd processor && npx jest test/services/denominations.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd processor
git add src/services/denominations.ts test/services/denominations.spec.ts
git commit -m "feat(giftcard): parameterize denomination levels instead of a fixed count of 18"
```

---

### Task 2: Per-store config

**Files:**
- Modify: `processor/src/config/config.ts`
- Modify: `processor/.env.template`
- Modify: `processor/.env` (the sandbox's own local env — not committed; `.env` is gitignored)

**Interfaces:**
- Produces:
  ```ts
  export type LoyaltyDiscountStore = { storeKey: string; currency: string; levels: number };
  // On the config object:
  loyaltyDiscountStores: LoyaltyDiscountStore[];
  loyaltyDiscountLevelsByCurrency: Record<string, number>;
  ```
- Consumed by: Task 3 (`loyalty-provisioning.ts` reads `loyaltyDiscountStores`), Task 5 (`loyalty-redemption.service.ts` reads `loyaltyDiscountLevelsByCurrency`).

This task has no unit test of its own (there is no `config.spec.ts` in this repo — `config.ts` is exercised transitively through the specs that mock `getConfig`). Verification is Task 3 and Task 5's specs passing with the new config shape, plus a manual parse check in Step 2.

- [ ] **Step 1: Implement** — in `src/config/config.ts`, replace the `loyaltyDiscountCurrencies` block:

```ts
  // The automatic CartDiscounts that carry the points: loyalty-<storeKey>-D1 … loyalty-<storeKey>-D2^(levels-1),
  // scoped to that Store so each set lives inside the Store's own 100-active-automatic-discount budget
  // instead of the project-wide one (SUPPORT-41640 confirms the cap is project-wide + 100 per Store).
  // Format: "storeKey:currency:levels" comma-separated. `levels` is how many binary denominations that
  // currency needs to reach the same real EUR-equivalent ceiling as EUR's 18 (a weaker currency against
  // EUR needs more levels — see denominations.ts). Recompute `levels` if the currency's FX rate moves
  // enough to matter; this is a provisioning-time constant, not something read live.
  loyaltyDiscountKeyPrefix: process.env.LOYALTY_DISCOUNT_KEY_PREFIX || 'loyalty-',
  loyaltyDiscountStores: parseLoyaltyDiscountStores(
    process.env.LOYALTY_DISCOUNT_STORES || 'lu:EUR:18,ro:RON:21,se:SEK:22',
  ),
  get loyaltyDiscountLevelsByCurrency(): Record<string, number> {
    return this.loyaltyDiscountStores.reduce<Record<string, number>>(
      (levels, store) => ({ ...levels, [store.currency]: Math.max(levels[store.currency] ?? 0, store.levels) }),
      {},
    );
  },
  loyaltyDiscountSortOrderBase: process.env.LOYALTY_DISCOUNT_SORT_ORDER_BASE || '0.000001',
```

Add the parser and type above the `config` object (top of the file, after any imports — there are none today):

```ts
export type LoyaltyDiscountStore = { storeKey: string; currency: string; levels: number };

const parseLoyaltyDiscountStores = (raw: string): LoyaltyDiscountStore[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [storeKey, currency, levels] = entry.split(':');
      return { storeKey: storeKey.trim(), currency: currency.trim().toUpperCase(), levels: parseInt(levels, 10) };
    });
```

Note: `loyaltyDiscountLevelsByCurrency` is defined as a getter on the plain `config` object literal (valid JS/TS — a getter works the same on an object literal as on a class), so it recomputes from `loyaltyDiscountStores` on every access rather than going stale if a test mutates `loyaltyDiscountStores` directly.

- [ ] **Step 2: Manual parse check**

Run: `cd processor && node -e "
const raw = 'lu:EUR:18,ro:RON:21,se:SEK:22';
const parsed = raw.split(',').map(e => { const [storeKey, currency, levels] = e.split(':'); return { storeKey, currency, levels: parseInt(levels, 10) }; });
console.log(JSON.stringify(parsed));
"`
Expected: `[{"storeKey":"lu","currency":"EUR","levels":18},{"storeKey":"ro","currency":"RON","levels":21},{"storeKey":"se","currency":"SEK","levels":22}]`

- [ ] **Step 3: Update `.env.template`** — replace the `LOYALTY_DISCOUNT_CURRENCIES` line and its comment:

```
# The redemption's projection onto the commercetools cart: the custom Type key and the two field
# names the processor writes, and the key prefix of the per-Store automatic CartDiscounts
# (loyalty-<storeKey>-D1 ... ) that post-deploy provisions. The loyalty backend reads the same names
# off the order (loyalty.redemption.commercetools.* in pierce-loyalty), so change them on both sides
# or not at all. Defaults shown.
#LOYALTY_CART_TYPE_KEY=pierce-loyalty-cart
#LOYALTY_REDEMPTION_ID_FIELD=loyaltyRedemptionId
#LOYALTY_DENOMINATIONS_FIELD=loyaltyRedemption
#LOYALTY_DISCOUNT_KEY_PREFIX=loyalty-
# Comma-separated "storeKey:currency:levels" triples. Each Store gets its own scoped set of
# `levels` denomination CartDiscounts in `currency`, so redemption in that Store's carts never
# competes with the project-wide 100-active-automatic-discount cap.
#LOYALTY_DISCOUNT_STORES=lu:EUR:18,ro:RON:21,se:SEK:22
# sortOrder prefix of the denomination discounts (two-digit index appended); keep it below every
# marketing promotion so percentages come off the full price and points off the promoted price.
#LOYALTY_DISCOUNT_SORT_ORDER_BASE=0.000001
```

- [ ] **Step 4: Update the sandbox's `.env`** — add (or replace an existing `LOYALTY_DISCOUNT_CURRENCIES` line with):

```
LOYALTY_DISCOUNT_STORES=lu:EUR:18,ro:RON:21,se:SEK:22
```

- [ ] **Step 5: Commit** (the `.env.template` and `config.ts` changes only — `.env` is gitignored, nothing to stage there)

```bash
cd processor
git add src/config/config.ts .env.template
git commit -m "feat(giftcard): configure loyalty denominations per store instead of a flat currency list"
```

---

### Task 3: Per-store provisioning

**Files:**
- Modify: `processor/src/connectors/loyalty-provisioning.ts`
- Modify: `processor/test/connectors/loyalty-provisioning.spec.ts`

**Interfaces:**
- Consumes: `denominationKeys(levels)`, `denominationMinorUnits(key)` (Task 1); `LoyaltyDiscountStore` (Task 2).
- Produces:
  ```ts
  export type ProvisioningStore = { storeKey: string; currency: string; levels: number };
  export type ProvisioningOptions = {
    typeKey: string;
    redemptionIdField: string;
    denominationsField: string;
    discountKeyPrefix: string;
    stores: ProvisioningStore[];
    sortOrderBase: string;
  };
  export async function provisionLoyaltyRedemption(client, opts: ProvisioningOptions, logger): Promise<void>;
  ```
  Consumed by Task 4 (`post-deploy.ts`).

- [ ] **Step 1: Write the failing tests** — replace `test/connectors/loyalty-provisioning.spec.ts` entirely:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { provisionLoyaltyRedemption } from '../../src/connectors/loyalty-provisioning';
import { denominationKeys } from '../../src/services/denominations';

const AUTH = 'https://auth.test';
const API = 'https://api.test';
const PROJECT = 'test-project';

const OPTS = {
  typeKey: 'pierce-loyalty-cart',
  redemptionIdField: 'loyaltyRedemptionId',
  denominationsField: 'loyaltyRedemption',
  discountKeyPrefix: 'loyalty-',
  stores: [
    { storeKey: 'lu', currency: 'EUR', levels: 18 },
    { storeKey: 'ro', currency: 'RON', levels: 21 },
  ],
  sortOrderBase: '0.000001',
};
const lateBoundFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
const client = () =>
  createApiBuilderFromCtpClient(
    new ClientBuilder()
      .withClientCredentialsFlow({
        host: AUTH,
        projectKey: PROJECT,
        credentials: { clientId: 'id', clientSecret: 'secret' },
        httpClient: lateBoundFetch,
      })
      .withHttpMiddleware({ host: API, httpClient: lateBoundFetch })
      .build(),
  ).withProjectKey({ projectKey: PROJECT });
const silent = { info: () => undefined };
const notFound = () =>
  HttpResponse.json(
    { statusCode: 404, message: 'not found', errors: [{ code: 'ResourceNotFound', message: 'not found' }] },
    { status: 404 },
  );

describe('loyalty-provisioning', () => {
  const server = setupServer(
    http.post(`${AUTH}/oauth/token`, () =>
      HttpResponse.json({ access_token: 't', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  test('creates the cart type and one store-scoped denomination set per store, sized to that store\'s levels', async () => {
    const created: { url: string; body: Record<string, unknown> }[] = [];
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, notFound),
      http.post(`${API}/${PROJECT}/types`, async ({ request }) => {
        created.push({ url: 'types', body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: 'type-id', version: 1, key: OPTS.typeKey });
      }),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, notFound),
      http.post(`${API}/${PROJECT}/cart-discounts`, async ({ request }) => {
        created.push({ url: 'cart-discounts', body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: 'd', version: 1 });
      }),
    );

    await provisionLoyaltyRedemption(client(), OPTS, silent);

    const discounts = created.filter((c) => c.url === 'cart-discounts').map((c) => c.body);
    expect(discounts).toHaveLength(18 + 21);

    const lu = discounts.filter((d) => (d.key as string).startsWith('loyalty-lu-'));
    expect(lu).toHaveLength(18);
    expect(lu.map((d) => d.key)).toStrictEqual(denominationKeys(18).map((k) => `loyalty-lu-${k}`));
    expect(lu[9]).toMatchObject({
      key: 'loyalty-lu-D512',
      cartPredicate: 'custom.loyaltyRedemption contains "D512"',
      value: { type: 'absolute', money: [{ currencyCode: 'EUR', centAmount: 512 }] },
      target: { type: 'totalPrice' },
      requiresDiscountCode: false,
      isActive: true,
      stackingMode: 'Stacking',
      sortOrder: '0.000001101',
      stores: [{ typeId: 'store', key: 'lu' }],
    });

    const ro = discounts.filter((d) => (d.key as string).startsWith('loyalty-ro-'));
    expect(ro).toHaveLength(21);
    expect(ro.map((d) => d.key)).toStrictEqual(denominationKeys(21).map((k) => `loyalty-ro-${k}`));
    expect(ro[20]).toMatchObject({
      key: 'loyalty-ro-D1048576',
      value: { type: 'absolute', money: [{ currencyCode: 'RON', centAmount: 1048576 }] },
      stores: [{ typeId: 'store', key: 'ro' }],
      // sortOrder reuses the same per-index formula as lu: the two stores never compete on the same
      // cart, so a collision across stores is harmless.
      sortOrder: '0.000001211',
    });

    // No sortOrder within a single store's own set ends in a trailing zero (commercetools refuses it).
    for (const key of ['lu', 'ro']) {
      const own = discounts.filter((d) => (d.key as string).startsWith(`loyalty-${key}-`));
      expect(new Set(own.map((d) => d.sortOrder)).size).toBe(own.length);
      expect(own.map((d) => d.sortOrder).filter((s) => (s as string).endsWith('0'))).toStrictEqual([]);
    }
  });

  test('updates a discount whose money changed, keeping it scoped to its own store', async () => {
    const updates: { url: string; body: Record<string, unknown> }[] = [];
    const singleStoreOpts = { ...OPTS, stores: [{ storeKey: 'lu', currency: 'EUR', levels: 18 }] };
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'Set', elementType: { name: 'String' } } },
          ],
        }),
      ),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, ({ params }) =>
        HttpResponse.json({
          id: `id-${params.key}`,
          version: 2,
          key: params.key,
          isActive: true,
          sortOrder: '0.000001011',
          cartPredicate: `custom.loyaltyRedemption contains "${String(params.key).replace('loyalty-lu-', '')}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          stores: [{ typeId: 'store', key: 'lu' }],
          value: {
            type: 'absolute',
            money: [{ type: 'centPrecision', currencyCode: 'EUR', centAmount: 999, fractionDigits: 2 }],
          },
        }),
      ),
      http.post(`${API}/${PROJECT}/cart-discounts/key=:key`, async ({ request, params }) => {
        updates.push({ url: `cart-discounts/${params.key}`, body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({ id: `id-${params.key}`, version: 3 });
      }),
    );

    await provisionLoyaltyRedemption(client(), singleStoreOpts, silent);

    expect(updates).toHaveLength(18);
    expect(updates[0].body).toMatchObject({
      version: 2,
      actions: [{ action: 'changeValue', value: { type: 'absolute', money: [{ currencyCode: 'EUR', centAmount: 1 }] } }],
    });
  });

  test('fails loudly when an existing type defines a field with the wrong type', async () => {
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'String' } },
          ],
        }),
      ),
    );

    await expect(provisionLoyaltyRedemption(client(), OPTS, silent)).rejects.toThrow(/loyaltyRedemption.*Set/);
  });

  test('changes nothing when the project already matches', async () => {
    const posts: string[] = [];
    const singleStoreOpts = { ...OPTS, stores: [{ storeKey: 'lu', currency: 'EUR', levels: 18 }] };
    server.use(
      http.get(`${API}/${PROJECT}/types/key=${OPTS.typeKey}`, () =>
        HttpResponse.json({
          id: 'type-id',
          version: 4,
          key: OPTS.typeKey,
          fieldDefinitions: [
            { name: 'loyaltyRedemptionId', type: { name: 'String' } },
            { name: 'loyaltyRedemption', type: { name: 'Set', elementType: { name: 'String' } } },
          ],
        }),
      ),
      http.get(`${API}/${PROJECT}/cart-discounts/key=:key`, ({ params }) => {
        const denomination = String(params.key).replace('loyalty-lu-', '');
        const index = denominationKeys(18).indexOf(denomination);
        const cents = Number(denomination.replace('D', ''));
        return HttpResponse.json({
          id: 'x',
          version: 1,
          key: params.key,
          isActive: true,
          sortOrder: `0.000001${String(index + 1).padStart(2, '0')}1`,
          cartPredicate: `custom.loyaltyRedemption contains "${denomination}"`,
          target: { type: 'totalPrice' },
          stackingMode: 'Stacking',
          requiresDiscountCode: false,
          stores: [{ typeId: 'store', key: 'lu' }],
          value: {
            type: 'absolute',
            money: [{ type: 'centPrecision', currencyCode: 'EUR', centAmount: cents, fractionDigits: 2 }],
          },
        });
      }),
      http.post(`${API}/${PROJECT}/*`, ({ request }) => {
        posts.push(request.url);
        return HttpResponse.json({});
      }),
    );

    await provisionLoyaltyRedemption(client(), singleStoreOpts, silent);

    expect(posts).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd processor && npx jest test/connectors/loyalty-provisioning.spec.ts`
Expected: FAIL — `opts.currencies` still expected, `opts.stores` unused, discount keys/money/scope don't match.

- [ ] **Step 3: Implement** — replace `src/connectors/loyalty-provisioning.ts` entirely:

```ts
import {
  CartDiscount,
  CartDiscountDraft,
  CartDiscountUpdateAction,
  CartDiscountValueAbsoluteDraft,
  FieldDefinition,
  Type,
  TypeUpdateAction,
} from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { denominationKeys, denominationMinorUnits } from '../services/denominations';

export type ProvisioningStore = {
  storeKey: string;
  currency: string;
  levels: number;
};

export type ProvisioningOptions = {
  typeKey: string;
  redemptionIdField: string;
  denominationsField: string;
  discountKeyPrefix: string;
  stores: ProvisioningStore[];
  sortOrderBase: string;
};

type Logger = { info(message: string): void };

/**
 * Idempotent set-up of everything the redemption needs in commercetools: the cart Type with the two
 * fields, and one absolute automatic CartDiscount per denomination PER STORE, gated by
 * `custom.<denominationsField> contains "Dn"` and scoped to that store via `stores`. Store-scoping
 * keeps every store's set inside its OWN 100-active-automatic-discount budget instead of the
 * project-wide one, which a live check against pierce-prod found already at 90/100 from unrelated
 * marketing discounts. Each store gets exactly as many levels as its own currency needs to reach the
 * same real EUR-equivalent ceiling as every other store (see config.ts). Re-running converges: missing
 * fields are added to an existing type (a field of the wrong type fails the run), and an existing
 * discount has its value, predicate, target, stacking mode and code requirement brought back in line.
 * Discounts are never deleted here - orders reference them.
 *
 * sortOrder: every CartDiscount needs a distinct value in (0, 1) among discounts that could apply to
 * the same cart, higher applies first, and commercetools refuses a value ending in zero. Each store's
 * own denominations sit at `<base><two-digit index>1` (the trailing 1 keeps the tenth entry legal);
 * the same index range is reused across stores because two different stores' discounts never compete
 * on the same cart.
 */
export async function provisionLoyaltyRedemption(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  logger: Logger,
): Promise<void> {
  await ensureCartType(client, opts, logger);
  for (const store of opts.stores) {
    const keys = denominationKeys(store.levels);
    for (let index = 0; index < keys.length; index++) {
      await ensureDenominationDiscount(client, opts, store, keys[index], index, logger);
    }
  }
}

const fieldDefinitions = (opts: ProvisioningOptions): FieldDefinition[] => [
  {
    name: opts.redemptionIdField,
    label: { en: 'Loyalty redemption id' },
    required: false,
    type: { name: 'String' },
    inputHint: 'SingleLine',
  },
  {
    name: opts.denominationsField,
    label: { en: 'Loyalty discount denominations' },
    required: false,
    type: { name: 'Set', elementType: { name: 'String' } },
  },
];

async function ensureCartType(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  logger: Logger,
): Promise<void> {
  const existing = await getOr404<Type>(() => client.types().withKey({ key: opts.typeKey }).get().execute());
  const wanted = fieldDefinitions(opts);
  if (!existing) {
    await client
      .types()
      .post({
        body: {
          key: opts.typeKey,
          name: { en: 'Pierce loyalty redemption' },
          description: { en: 'Points redemption carried by the cart and copied onto the order' },
          resourceTypeIds: ['order'],
          fieldDefinitions: wanted,
        },
      })
      .execute();
    logger.info(`Created cart type ${opts.typeKey}`);
    return;
  }
  const present = new Map((existing.fieldDefinitions ?? []).map((definition) => [definition.name, definition]));
  for (const definition of wanted) {
    const found = present.get(definition.name);
    if (found && !sameFieldType(found, definition)) {
      // A field of the wrong type cannot be changed in place, and writing to it would fail every
      // redeem: better to stop the deployment here than to report a project that does not work.
      throw new Error(
        `Type ${opts.typeKey} already defines field ${definition.name} as ${describeFieldType(found)}, expected ${describeFieldType(definition)}`,
      );
    }
  }
  const actions: TypeUpdateAction[] = wanted
    .filter((definition) => !present.has(definition.name))
    .map((definition) => ({
      action: 'addFieldDefinition',
      fieldDefinition: {
        name: definition.name,
        label: definition.label,
        required: definition.required,
        type: definition.type,
      },
    }));
  if (actions.length === 0) {
    return;
  }
  await client
    .types()
    .withKey({ key: opts.typeKey })
    .post({ body: { version: existing.version, actions } })
    .execute();
  logger.info(`Added ${actions.length} field(s) to cart type ${opts.typeKey}`);
}

async function ensureDenominationDiscount(
  client: ByProjectKeyRequestBuilder,
  opts: ProvisioningOptions,
  store: ProvisioningStore,
  denomination: string,
  index: number,
  logger: Logger,
): Promise<void> {
  const key = `${opts.discountKeyPrefix}${store.storeKey}-${denomination}`;
  const cents = denominationMinorUnits(denomination);
  const value: CartDiscountValueAbsoluteDraft = {
    type: 'absolute',
    money: [{ currencyCode: store.currency, centAmount: cents }],
  };
  const sortOrder = `${opts.sortOrderBase}${String(index + 1).padStart(2, '0')}1`;
  const draft: CartDiscountDraft = {
    key,
    name: { en: `Loyalty points ${store.storeKey} ${denomination}` },
    value,
    cartPredicate: `custom.${opts.denominationsField} contains "${denomination}"`,
    target: { type: 'totalPrice' },
    sortOrder,
    isActive: true,
    requiresDiscountCode: false,
    stackingMode: 'Stacking',
    stores: [{ typeId: 'store', key: store.storeKey }],
  };
  const existing = await getOr404<CartDiscount>(() => client.cartDiscounts().withKey({ key }).get().execute());
  if (!existing) {
    await client.cartDiscounts().post({ body: draft }).execute();
    logger.info(`Created cart discount ${key}`);
    return;
  }
  const actions: CartDiscountUpdateAction[] = [];
  if (!sameMoney(existing, value)) {
    actions.push({ action: 'changeValue', value });
  }
  if (existing.cartPredicate !== draft.cartPredicate) {
    actions.push({ action: 'changeCartPredicate', cartPredicate: draft.cartPredicate });
  }
  if (existing.target?.type !== 'totalPrice') {
    actions.push({ action: 'changeTarget', target: { type: 'totalPrice' } });
  }
  if (existing.stackingMode !== 'Stacking') {
    actions.push({ action: 'changeStackingMode', stackingMode: 'Stacking' });
  }
  if (existing.requiresDiscountCode) {
    actions.push({ action: 'changeRequiresDiscountCode', requiresDiscountCode: false });
  }
  if (!existing.isActive) {
    actions.push({ action: 'changeIsActive', isActive: true });
  }
  if (existing.sortOrder !== sortOrder) {
    actions.push({ action: 'changeSortOrder', sortOrder });
  }
  if (actions.length === 0) {
    return;
  }
  await client
    .cartDiscounts()
    .withKey({ key })
    .post({ body: { version: existing.version, actions } })
    .execute();
  logger.info(`Updated cart discount ${key}`);
}

const describeFieldType = (definition: FieldDefinition): string =>
  definition.type.name === 'Set' ? `Set<${definition.type.elementType.name}>` : definition.type.name;

const sameFieldType = (a: FieldDefinition, b: FieldDefinition): boolean =>
  describeFieldType(a) === describeFieldType(b);

const sameMoney = (existing: CartDiscount, wanted: CartDiscountValueAbsoluteDraft): boolean => {
  if (existing.value.type !== 'absolute') {
    return false;
  }
  const have = existing.value.money.map((m) => `${m.currencyCode}:${m.centAmount}`).sort();
  const want = wanted.money.map((m) => `${m.currencyCode}:${m.centAmount}`).sort();
  return have.length === want.length && have.every((entry, i) => entry === want[i]);
};

async function getOr404<T>(call: () => Promise<{ body: T }>): Promise<T | null> {
  try {
    return (await call()).body;
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'statusCode' in e && (e as { statusCode: unknown }).statusCode === 404) {
      return null;
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd processor && npx jest test/connectors/loyalty-provisioning.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd processor
git add src/connectors/loyalty-provisioning.ts test/connectors/loyalty-provisioning.spec.ts
git commit -m "feat(giftcard): provision denomination discounts per store instead of globally"
```

---

### Task 4: Wire post-deploy to the new config

**Files:**
- Modify: `processor/src/connectors/post-deploy.ts`

**Interfaces:**
- Consumes: `config.loyaltyDiscountStores` (Task 2), `provisionLoyaltyRedemption` with the new `ProvisioningOptions` shape (Task 3).

No new test: `post-deploy.ts` has no dedicated spec today (it is exercised live in Task 9). This step is a pure call-site update; a `tsc` type error would catch a mismatch, checked in Step 2.

- [ ] **Step 1: Implement** — in `src/connectors/post-deploy.ts`, replace the `provisionLoyaltyRedemption` call's options:

```ts
import { paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { provisionLoyaltyRedemption } from './loyalty-provisioning';

/**
 * Connect runs this once per deployment. It converges every configured store onto what the
 * redemption needs there - the shared cart Type with the two custom fields, and that store's own
 * scoped set of denomination CartDiscounts - and is safe to re-run: existing objects are extended or
 * left alone, never recreated.
 */
async function postDeploy() {
  const config = getConfig();
  await provisionLoyaltyRedemption(
    paymentSDK.ctAPI.client,
    {
      typeKey: config.loyaltyCartTypeKey,
      redemptionIdField: config.loyaltyRedemptionIdField,
      denominationsField: config.loyaltyDenominationsField,
      discountKeyPrefix: config.loyaltyDiscountKeyPrefix,
      stores: config.loyaltyDiscountStores,
      sortOrderBase: config.loyaltyDiscountSortOrderBase,
    },
    { info: (message) => process.stdout.write(`${message}\n`) },
  );
}

async function runPostDeployScripts() {
  try {
    await postDeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-deploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

runPostDeployScripts();
```

- [ ] **Step 2: Type-check**

Run: `cd processor && npx tsc --noEmit`
Expected: no errors touching `post-deploy.ts` or `loyalty-provisioning.ts`.

- [ ] **Step 3: Commit**

```bash
cd processor
git add src/connectors/post-deploy.ts
git commit -m "feat(giftcard): post-deploy provisions denominations per configured store"
```

---

### Task 5: Currency-aware redeem

**Files:**
- Modify: `processor/src/services/loyalty-redemption.service.ts:312-322` (the `decomposeOrRefuse` method)
- Modify: `processor/test/loyalty-redemption.service.spec.ts`

**Interfaces:**
- Consumes: `decompose(minorUnits, levels)` (Task 1), `getConfig().loyaltyDiscountLevelsByCurrency` (Task 2).
- No change to `redeem()`'s public behavior beyond: a currency absent from `loyaltyDiscountLevelsByCurrency` now fails fast with `CurrencyNotMatch` instead of implicitly assuming 18 levels.

- [ ] **Step 1: Write the failing tests** — in `test/loyalty-redemption.service.spec.ts`:

First, update the shared `setupConfig` helper (used by every test) to carry the new field:

```ts
const setupConfig = (extra: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(Config, 'getConfig').mockReturnValue({
    loyaltyApiUrl: LOYALTY_URL,
    loyaltyTimeoutMs: 5000,
    loyaltyApiKey: '',
    healthCheckTimeout: 5000,
    projectKey: 'p',
    loyaltyDiscountLevelsByCurrency: { EUR: 18 },
    ...extra,
  } as any);
```

Then add, inside `describe('redeem', ...)`, alongside the existing `'refuses an amount the denominations cannot compose before touching the ledger'` test:

```ts
    test('decomposes against the levels configured for the cart currency, not a fixed 18', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18, RON: 21 } });
      const cart = getCartWithCustomerEmail('demo@example.com', {
        totalPrice: { type: 'centPrecision', currencyCode: 'RON', centAmount: 2000000, fractionDigits: 2 },
      });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(cart);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue({
        centAmount: 2000000,
        currencyCode: 'RON',
        fractionDigits: 2,
      });
      let holdBody: Record<string, unknown> = {};
      server.use(
        http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, async ({ request }) => {
          holdBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ redemptionId: holdBody.redemptionId, points: 300000, balance: 0 });
        }),
      );
      // 300000 minor units exceeds 18 levels' reach (262143) but not 21's (2097151).
      cartFields.nextTotalAfterWrite = 2000000 - 300000;

      const result = await service.redeem({ data: { code: '', redeemAmount: { centAmount: 300000, currencyCode: 'RON' } } });

      expect(result.appliedAmount).toStrictEqual({ centAmount: 300000, currencyCode: 'RON' });
      expect(cartFields.writes[0].denominations).toContain('D262144');
    });

    test('refuses a currency with no configured denominations before touching the ledger', async () => {
      setupConfig({ loyaltyDiscountLevelsByCurrency: { EUR: 18 } });
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(
        getCartWithCustomerEmail('demo@example.com', {
          totalPrice: { type: 'centPrecision', currencyCode: 'PLN', centAmount: 100000, fractionDigits: 2 },
        }),
      );
      let held = 0;
      server.use(http.post(`${LOYALTY_URL}/loyalty/redemption/hold`, () => { held++; return HttpResponse.json({}); }));

      await expect(
        service.redeem({ data: { code: '', redeemAmount: { centAmount: 100, currencyCode: 'PLN' } } }),
      ).rejects.toMatchObject({ code: 'CurrencyNotMatch', httpErrorStatus: 400 });
      expect(held).toBe(0);
    });
```

- [ ] **Step 2: Run to see it fail**

Run: `cd processor && npx jest test/loyalty-redemption.service.spec.ts -t "levels configured|no configured denominations"`
Expected: FAIL — `decomposeOrRefuse` still calls `decompose(amount.centAmount)` with one argument and ignores currency-specific levels, so RON at 300000 throws `AmountNotDecomposable` instead of succeeding, and PLN is not rejected up front as `CurrencyNotMatch`.

- [ ] **Step 3: Implement** — replace the `decomposeOrRefuse` method in `src/services/loyalty-redemption.service.ts` (currently lines 312-322):

```ts
  private decomposeOrRefuse(amount: AmountSchemaDTO): string[] {
    const levels = getConfig().loyaltyDiscountLevelsByCurrency[amount.currencyCode];
    if (!levels) {
      throw new MockCustomError({
        message: `no loyalty denominations are configured for ${amount.currencyCode}`,
        code: 400,
        key: 'CurrencyNotMatch',
      });
    }
    try {
      return decompose(amount.centAmount, levels);
    } catch (e) {
      throw new MockCustomError({
        message: e instanceof Error ? e.message : String(e),
        code: 400,
        key: 'AmountNotDecomposable',
      });
    }
  }
```

And update the `decompose` import at the top of the file (line 39) — no change needed, it already imports `decompose` by name; only its call signature inside the method body changes.

- [ ] **Step 4: Run to see it pass**

Run: `cd processor && npx jest test/loyalty-redemption.service.spec.ts`
Expected: PASS, including the two new tests and every pre-existing test (the default `setupConfig()` now includes `loyaltyDiscountLevelsByCurrency: { EUR: 18 }`, matching every existing EUR-amount test).

- [ ] **Step 5: Commit**

```bash
cd processor
git add src/services/loyalty-redemption.service.ts test/loyalty-redemption.service.spec.ts
git commit -m "feat(giftcard): decompose redeem amounts against the levels configured for the cart currency"
```

---

### Task 6: Sandbox prerequisites — SEK price and legacy discount cleanup

Two one-off operational steps against `krzysztof-project-13` (sandbox), not permanent code. Both are safe: no real customer orders reference either object.

**Why:** (a) `NR1BAG` has standalone prices in EUR and RON but not SEK — Task 8's live SE test needs one to create a cart there. (b) The project currently carries 18 legacy GLOBAL `loyalty-D*` discounts (EUR-only, from before this plan) plus two non-binary stray keys (`loyalty-D100`, `loyalty-D200`) from earlier manual testing. Left in place, the global EUR ones would double-apply alongside the new `loyalty-lu-D*` set on every `lu` cart (both match the same cart predicate; global discounts are not restricted to any one store). They must be deactivated before Task 9's live provisioning run.

- [ ] **Step 1: Add a SEK standalone price for `NR1BAG`**

Run (uses the sandbox credentials already in `processor/.env`):

```bash
cd processor
set -a; source .env; set +a
curl -s -X POST -u "$CTP_CLIENT_ID:$CTP_CLIENT_SECRET" "$CTP_AUTH_URL/oauth/token" -d "grant_type=client_credentials" -o /tmp/tok.json
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/tok.json'))['access_token'])")
rm -f /tmp/tok.json
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST "$CTP_API_URL/$CTP_PROJECT_KEY/standalone-prices" \
  -d '{"sku":"NR1BAG","value":{"type":"centPrecision","currencyCode":"SEK","centAmount":54900},"country":"SE"}' \
  -o /tmp/price.json
python3 -c "import json; d=json.load(open('/tmp/price.json')); print('id' in d and 'created' or d)"
rm -f /tmp/price.json
```

Expected: prints `created`. (54900 = 549.00 SEK, matching the existing NOK price's rough magnitude for the same bag.)

- [ ] **Step 2: Deactivate the 18 legacy global `loyalty-D*` discounts and the 2 stray ones**

Run:

```bash
cd processor
set -a; source .env; set +a
curl -s -X POST -u "$CTP_CLIENT_ID:$CTP_CLIENT_SECRET" "$CTP_AUTH_URL/oauth/token" -d "grant_type=client_credentials" -o /tmp/tok.json
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/tok.json'))['access_token'])")
rm -f /tmp/tok.json
for key in D1 D2 D4 D8 D16 D32 D64 D128 D256 D512 D1024 D2048 D4096 D8192 D16384 D32768 D65536 D131072 D100 D200; do
  FULL_KEY="loyalty-$key"
  CURRENT=$(curl -s -H "Authorization: Bearer $TOKEN" "$CTP_API_URL/$CTP_PROJECT_KEY/cart-discounts/key=$FULL_KEY")
  VERSION=$(python3 -c "import json,sys; d=json.loads('''$CURRENT'''); print(d.get('version',''))")
  if [ -z "$VERSION" ]; then
    echo "skip $FULL_KEY: not found"
    continue
  fi
  curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST "$CTP_API_URL/$CTP_PROJECT_KEY/cart-discounts/key=$FULL_KEY" \
    -d "{\"version\":$VERSION,\"actions\":[{\"action\":\"changeIsActive\",\"isActive\":false}]}" \
    -o /dev/null -w "$FULL_KEY: %{http_code}\n"
done
```

Expected: `200` for each of the 20 keys (a `409` means the version drifted between the GET and the POST — re-run for that one key).

- [ ] **Step 3: Verify no active automatic discount still uses the plain (non-prefixed-by-store) `loyalty-D*` keys**

```bash
cd processor
set -a; source .env; set +a
curl -s -X POST -u "$CTP_CLIENT_ID:$CTP_CLIENT_SECRET" "$CTP_AUTH_URL/oauth/token" -d "grant_type=client_credentials" -o /tmp/tok.json
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/tok.json'))['access_token'])")
rm -f /tmp/tok.json
curl -s -H "Authorization: Bearer $TOKEN" "$CTP_API_URL/$CTP_PROJECT_KEY/cart-discounts?limit=50&where=isActive%3Dtrue" | python3 -c "
import sys, json
d = json.load(sys.stdin)
leftover = [r['key'] for r in d.get('results', []) if r.get('key','').startswith('loyalty-D')]
print('leftover active global loyalty-D* discounts:', leftover)
"
```

Expected: `leftover active global loyalty-D* discounts: []`

No commit for this task (no source files changed).

---

### Task 7: Store-aware system test support

**Files:**
- Modify: `processor/test/system/support/commercetools.ts`
- Modify: `processor/test/system/support/env.ts`

**Interfaces:**
- Produces:
  ```ts
  // On SystemEnv:
  loyaltyStores: { storeKey: string; currency: string; country: string }[];
  // On commercetools(env):
  createCart(opts: CreateCartOptions & { storeKey?: string; currency?: string; country?: string }): Promise<Cart>;
  ```
  Consumed by Task 8.

- [ ] **Step 1: Implement `env.ts`** — add a `loyaltyStores` field, parsed the same way `config.ts` parses `LOYALTY_DISCOUNT_STORES` (kept independent on purpose: the system test's env is allowed to target a different, smaller set of stores than what the processor under test actually provisions):

In `test/system/support/env.ts`, add to the `SystemEnv` type:

```ts
  loyaltyStores: { storeKey: string; currency: string; country: string }[];
```

And in `systemEnv()`, add before the final `checkoutApplicationKey` line:

```ts
    loyaltyStores: (process.env.SYSTEM_LOYALTY_STORES || 'lu:EUR:LU,ro:RON:RO,se:SEK:SE')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [storeKey, currency, country] = entry.split(':');
        return { storeKey, currency, country };
      }),
```

- [ ] **Step 2: Implement `commercetools.ts`** — extend `CreateCartOptions` and `createCart` to optionally target a store:

Replace the `CreateCartOptions` type and the `createCart` method:

```ts
type CreateCartOptions = {
  email: string;
  /** Give the cart the storefront's custom type up front, so the processor takes the setCustomField path. */
  withStorefrontType?: boolean;
  /** Creates the cart in this Store (`/in-store/key=...`) instead of at the project level. */
  storeKey?: string;
  /** Overrides `env.currency` - required together with `storeKey` when the store's market differs. */
  currency?: string;
  /** Overrides `env.country` - required together with `storeKey` when the store's market differs. */
  country?: string;
};
```

Since the fluent platform-sdk `api` builder used elsewhere in this file has no ergonomic `.inStore(key).carts()` wiring here, and adding one is out of scope for this plan, build the request with the same raw `fetch` + `token()` pattern this file already uses for `createSession`:

```ts
    async createCart({
      email,
      withStorefrontType = false,
      storeKey,
      currency = env.currency,
      country = env.country,
    }: CreateCartOptions): Promise<Cart> {
      const path = storeKey
        ? `${apiUrl}/${projectKey}/in-store/key=${storeKey}/carts`
        : `${apiUrl}/${projectKey}/carts`;
      const response = await fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currency,
          country,
          customerEmail: email,
          lineItems: [{ sku: env.sku, quantity: 1 }],
          shippingAddress: { country },
          ...(withStorefrontType && {
            custom: { type: { typeId: 'type', key: env.storefrontCartTypeKey }, fields: {} },
          }),
        }),
      });
      if (!response.ok) {
        throw new Error(`cart creation failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as Cart;
    },
```

This replaces the old `api.carts().post(...)` call. `apiUrl` and `projectKey` are already in scope (destructured at the top of `commercetools()`); no other change to the surrounding function is needed.

- [ ] **Step 3: Run the existing system-test support compiles**

Run: `cd processor && npx tsc --noEmit`
Expected: no errors in `test/system/support/commercetools.ts` or `env.ts`. (System tests themselves are `describe.skip`ped without `SYSTEM_PROCESSOR_URL` set, so this is a compile-only check here.)

- [ ] **Step 4: Commit**

```bash
cd processor
git add test/system/support/commercetools.ts test/system/support/env.ts
git commit -m "test(giftcard): let system tests create carts in a specific store and currency"
```

---

### Task 8: Live multi-store redeem system test

**Files:**
- Create: `processor/test/system/multi-store-redeem.system.spec.ts`

**Interfaces:**
- Consumes: `commercetools(env).createCart` with `storeKey`/`currency`/`country` (Task 7); `SystemEnv.loyaltyStores` (Task 7).

- [ ] **Step 1: Write the test**

```ts
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
```

- [ ] **Step 2: Run against the sandbox**

Requires the system-test env vars pointed at `krzysztof-project-13` (`SYSTEM_PROCESSOR_URL`, `SYSTEM_CTP_*`, `SYSTEM_LOYALTY_*` — already documented in `.envrc-example` per the connector plan's Task 2 note) and the processor running locally (`npm run dev` in another terminal, or `SYSTEM_PROCESSOR_URL` pointed at a deployed instance).

Run: `cd processor && npm run test:system -- multi-store-redeem`
Expected: FAIL until Task 9's provisioning has actually run against the sandbox (the `lu`/`ro`/`se` store-scoped discounts do not exist yet) — this is the acceptance test for Task 9, not for this task. Confirm here only that it compiles and the three cases attempt real HTTP calls (a `ECONNREFUSED`/`404` is fine at this point; a TypeScript error is not).

No commit criterion beyond compiling — Task 9 makes it pass.

- [ ] **Step 3: Commit**

```bash
cd processor
git add test/system/multi-store-redeem.system.spec.ts
git commit -m "test(giftcard): add a live system test redeeming in lu, ro and se"
```

---

### Task 9: Run provisioning against the sandbox and verify live

**Files:** none (execution only).

- [ ] **Step 1: Build**

Run: `cd processor && npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 2: Run post-deploy against the sandbox**

Run: `cd processor && npm run connector:post-deploy`
Expected: log lines `Created cart discount loyalty-lu-D1` … `loyalty-lu-D131072` (18), `loyalty-ro-D1` … `loyalty-ro-D1048576` (21), `loyalty-se-D1` … `loyalty-se-D2097152` (22) — 61 lines total, plus (if the Type needed no change) no `Created cart type`/`Added N field(s)` line.

- [ ] **Step 3: Verify live in commercetools**

```bash
cd processor
set -a; source .env; set +a
curl -s -X POST -u "$CTP_CLIENT_ID:$CTP_CLIENT_SECRET" "$CTP_AUTH_URL/oauth/token" -d "grant_type=client_credentials" -o /tmp/tok.json
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/tok.json'))['access_token'])")
rm -f /tmp/tok.json
for prefix in loyalty-lu- loyalty-ro- loyalty-se-; do
  curl -s -H "Authorization: Bearer $TOKEN" "$CTP_API_URL/$CTP_PROJECT_KEY/cart-discounts?limit=50&where=key(\"$prefix\")" | python3 -c "
import sys, json
d = json.load(sys.stdin)
matches = [r for r in d.get('results', []) if r['key'].startswith('$prefix')]
print('$prefix', len(matches))
"
done
```

Expected: `loyalty-lu- 18`, `loyalty-ro- 21`, `loyalty-se- 22`.

- [ ] **Step 4: Start the processor and run the live system test**

Run: `cd processor && npm run dev &` then, once it is listening, `npm run test:system -- multi-store-redeem`
Expected: PASS for all three cases (`lu`/EUR, `ro`/RON, `se`/SEK).

- [ ] **Step 5: Full verification**

Run: `cd processor && npm run lint && npm test && npm run build`
Expected: PASS.

No commit for this task — it is a live verification pass, not a code change.

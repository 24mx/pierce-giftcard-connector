# Testing — who tests what, and how to test against this connector

The pay-with-points flow spans three deployables owned by two teams: the loyalty backend
(`pierce-loyalty`) and this connector belong to the loyalty engineer; the storefront
(`ecom-fe-sveltekit`) belongs to the storefront team. Each repo mocks its neighbours in its own unit
tests, so a contract change can pass all three suites and still break the integrated flow (this
happened with `paymentId` → `redemptionId`). The split below closes that gap. The backend carries the
same document as `doc/out/Loyalty_Points_Flow_Test_Responsibilities_EN.md`; keep the two in step.

## The four layers

| Layer | Answers | Where | Runs |
|---|---|---|---|
| **1. Unit per repo** | "does my code do what I think?" | `processor/test/**/*.spec.ts` (jest, msw for the backend, in-memory cart fields client) | every PR (`verify.yml`) |
| **2. Contract** | "do we mean the same thing by `/redeem`?" | `packages/loyalty-connector-contract` (published), pinned by `processor/test/contract/*.spec.ts` | every PR, no environment |
| **3. Flow through the API** | "do connector + backend + commercetools actually compose?" | `processor/test/system/*.system.spec.ts`, `npm run test:system` | after a connector or backend staging deploy, nightly (`system-tests.yml`) |
| **4. Widget in a browser** | "does the storefront drive the contract correctly?" | storefront repo, Playwright `checkout/points.spec.ts` | storefront pipeline, plus `repository_dispatch` from `system-tests.yml` |

This repo owns layers 1–3. It does not own a browser test and should not grow one.

## Layer 1 — unit tests in `processor/test`

- `loyalty-redemption.service.spec.ts` — the orchestration: hold → write fields → verify the drop →
  `DiscountNotApplied` rollback; release order (void, then clear, `FinalizationInProgress` aborts);
  finalize; `openRedemptionId` / `openRedemptionLocked` on balance; payment-intents operations refused.
  Backend is msw, the cart fields client is the in-memory `FakeCartFields`.
- `clients/cart-redemption-fields.client.spec.ts` — `setCustomType` vs `setCustomField`, clear stands
  down when the cart carries another id, **the one-retry version-conflict path** (this is the only
  place that path is tested; it cannot be forced deterministically from outside).
- `clients/loyalty.client.spec.ts` — URLs, headers, error mapping of the backend client.
- `services/denominations.spec.ts` — decomposition into `D1…D2^(levels-1)`, where `levels` is the
  currency's own level count (see [`docs/LOYALTY_DENOMINATIONS_EN.md`](docs/LOYALTY_DENOMINATIONS_EN.md)).
- `connectors/loyalty-provisioning.spec.ts` — idempotent Type + one Store-scoped denomination set per
  configured Store, and the convergence of an existing discount that drifted.
- `config/config.spec.ts` — `LOYALTY_DISCOUNT_STORES` parsing and its validation errors.

Rule of thumb: if a scenario needs a real commercetools cart *and* a real hold at the same time, it
is not a unit test. Put it in layer 3.

## Layer 2 — the contract package

`packages/loyalty-connector-contract` is the single description of the storefront-facing API:

- TypeBox schemas for `/balance`, `/redeem`, `/finalize`, `/release` requests and responses (the
  same objects the Fastify routes validate with);
- `LOYALTY_ERROR_KEYS` — every `key` this processor can answer with (see the table below);
- `examples/*.json` — one request and one response per route, validated against the schemas by the
  package's own tests.

`processor/test/contract/schemas-match-contract.spec.ts` fails when a route schema drifts from the
package, and `error-keys-match-contract.spec.ts` fails when the service uses a key the package does not
list. A change that alters shapes or keys is a **major** version bump; the storefront's build then
fails until it adopts the new version.

## Layer 3 — the system suite

`processor/test/system/` talks to a **deployed** processor, a **deployed** backend and a real
commercetools project. It is skipped entirely unless `SYSTEM_PROCESSOR_URL` is set, so `npm test` is
unaffected. Configuration (all in `.env.template`, section "system tests"):

| Variable | Meaning |
|---|---|
| `SYSTEM_PROCESSOR_URL` | this processor on staging |
| `SYSTEM_LOYALTY_API_URL`, `SYSTEM_LOYALTY_API_KEY` | the backend and the key its `/loyalty/**` filter expects |
| `SYSTEM_CTP_*` | a commercetools API client with `manage_orders manage_sessions manage_cart_discounts view_types` — the suite creates carts and sessions and toggles one discount |
| `SYSTEM_SKU`, `SYSTEM_COUNTRY`, `SYSTEM_CURRENCY` | a sellable variant and the fallback market to build carts in |
| `SYSTEM_LOYALTY_STORES` | comma-separated `storeKey:currency:country` triples (default `lu:EUR:LU,ro:RON:RO,se:SEK:SE`). Denomination discounts are Store-scoped, so every cart the suite creates is created **in a Store**; the single-store scenarios use the first entry |
| `STOREFRONT_REPO` (repository variable), `STOREFRONT_DISPATCH_TOKEN` (secret) | `system-tests.yml` only: where and with what PAT to send the `repository_dispatch` after a green run |

Scenarios, one file each:

| File | Proves |
|---|---|
| `redeem-release-finalize.system.spec.ts` | redeem writes the two fields and the gross total drops by exactly the amount; balance is debited; release clears the fields and credits back; finalize then release is 409 `FinalizationInProgress` |
| `existing-type.system.spec.ts` | a cart already carrying the storefront's custom type keeps it and only gains the two fields |
| `discount-not-applied.system.spec.ts` | with one denomination discount deactivated, redeem answers 409 `DiscountNotApplied`, the hold is voided and the cart carries no fields. While this file runs, `loyalty-<storeKey>-D1` (the first Store in `SYSTEM_LOYALTY_STORES`) is off on the shared project: any other redeem of an odd cent amount **in that Store** fails the same way until `afterAll` restores it |
| `abandonment.system.spec.ts` | after redeem, the backend's sweep narrowed to this customer (`test-hooks/sweep?ttlMinutes=0&userId=…`) clears the cart and the balance is whole again |
| `multi-store-redeem.system.spec.ts` | one case per entry in `SYSTEM_LOYALTY_STORES`: a cart in that Store redeems in that Store's own currency against that Store's own scoped denomination set |

Every test creates its own cart and customer email, and `afterEach` calls the backend's
`test-hooks/holds/release` for that email and deletes the cart, so a failed run leaves nothing behind.

## How to test against this connector (for the storefront team)

**Authentication.** Every route takes `X-Session-Id`: a commercetools Checkout session whose
`cart.cartRef.id` is the shopper's cart. The processor reads the cart id from the session and the
customer from the cart's `customerEmail`; there is no bearer token and no enabler.

**Routes** (bodies and responses are the contract package's types):

| Route | Body | 200 | Errors |
|---|---|---|---|
| `POST /balance` | `{code}` (any string) | `points`, `amount`, `maxPoints`, `rate`, `openRedemptionId`, `openRedemptionPoints`, `openRedemptionLocked` | `CustomerNotIdentified` |
| `POST /redeem` | `{code, redeemAmount: {centAmount, currencyCode}}` | `{redemptionId, points, appliedAmount}` | `InsufficientFunds`, `CurrencyNotMatch`, `CartAlreadyHeld`, `AmountNotDecomposable`, `DiscountNotApplied`, `FinalizationInProgress` |
| `POST /finalize` | `{redemptionId}` | `{result}` | `RedemptionNotOnCart` |
| `POST /release` | `{redemptionId}` | `{result}` | `RedemptionNotOnCart` (404), `FinalizationInProgress` (409) |

**What the widget should do with each error key**

| Key | Meaning | Widget |
|---|---|---|
| `RedemptionNotOnCart` | the cart no longer carries this redemption (another tab removed it, or it was never applied) | drop the "applied" state, re-quote |
| `FinalizationInProgress` | a checkout submission locked the hold; the lock expires on its own (staging: 30 s) | show "locked", disable remove; today the widget re-quotes only on page load, so a browser test reloads after the lock |
| `DiscountNotApplied` | commercetools did not take the amount off the cart; nothing was kept | show a generic failure, re-quote |
| `InsufficientFunds`, `AmountNotDecomposable`, `CurrencyNotMatch` | the request cannot be honoured as sent | re-quote and clamp the slider |
| `CartAlreadyHeld` | a concurrent redeem won | re-quote (the balance response reports the open redemption) |

**Test data on staging.** The backend exposes, behind its `X-Api-Key`:

- `POST /loyalty/demo/points` `{userId, points, reason}` — grant points to a test customer (userId is
  the lower-cased email);
- `GET /loyalty/redemption/balance?userId=…&currency=EUR` — the ledger's view, for back-door assertions;
- `POST /loyalty/redemption/test-hooks/holds/release` `{userId}` — cleanup: voids every open hold, answers `{released, locked}` (a captured hold is in neither list); `userId` is the lower-cased email;
- `POST /loyalty/redemption/test-hooks/sweep?ttlMinutes=0&userId=…` — run the reconciliation now for one customer; without `userId` it sweeps everyone's holds, so always pass it on a shared environment;
- `POST /loyalty/redemption/order-signal` — settle an order where staging has no Kafka feed.

Ask the loyalty engineer for the staging URLs and the test API key; they are not in this repo.

**What layer 4 should and should not cover.** Drive the widget (quote, apply, update, remove,
proceed, two tabs, refused card after finalize) and assert through the commercetools SDK (cart custom
fields, discount portions) and the backend balance. Do one full purchase with points plus a card.
Do not re-test hold semantics, the sweep or the coverage gate; the backend's tests own those.

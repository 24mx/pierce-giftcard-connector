# Loyalty redemption: binary denomination CartDiscounts

**Status:** describes the design implemented by `docs/superpowers/plans/2026-09-23-cart-discount-redemption.md` (the redemption mechanism) and `docs/superpowers/plans/2026-09-25-per-store-loyalty-denominations.md` (per-store, per-currency level counts).

## 1. Why denominations at all

A commercetools `CartDiscount`'s value is static (fixed at creation), but a points redemption is an arbitrary amount chosen at checkout time. commercetools support (`SUPPORT-41640`, quoted in the per-store plan) confirmed the only approach that stacks correctly with marketing promotions is:

> Model points as a defined set of absolute-value cart discounts for set increments... selected by a cart custom-field predicate, with `stackingMode: Stacking` and a `sortOrder` below the promos.

A negative custom line item (the natural-looking alternative) was tested live and rejected: it silently drops any marketing promotion whose threshold the redemption pushes the cart below, because a custom line item has no `stackingMode`/`sortOrder` for the promotion engine to order against.

## 2. How the binary representation works

A fixed number of `CartDiscount`s exist per store, one per power of two of that store's currency's minor unit: `D1`, `D2`, `D4`, `D8`, … Each is:

- **Absolute**, worth exactly its own minor-unit value (`D1024` = 1024 minor units of that store's currency — a literal number, not a rate-converted figure).
- **Gated** by `cartPredicate: custom.loyaltyRedemption contains "Dn"` — it only ever applies to a cart whose custom field lists that exact key.
- **Scoped to one Store** (`stores: [{typeId:'store', key: storeKey}]`), so it only evaluates against carts in that store, and — just as importantly — lives inside that store's own separate 100-active-automatic-discount budget instead of the project-wide one.

To redeem an amount, the connector decomposes it into binary digits and writes the matching keys onto the cart:

```
1234 minor units = 1024 + 128 + 64 + 16 + 2
                 → cart.custom.loyaltyRedemption = ["D1024", "D128", "D64", "D16", "D2"]
```

commercetools then applies all five matching `CartDiscount`s simultaneously (`stackingMode: Stacking`), summing to exactly 1234. Any integer number of minor units from 1 up to `2^levels − 1` is reachable this way, using only `levels` discount objects — the minimum possible for exact coverage of every integer in that range (a classical result: `k` "used at most once" values can produce at most `2^k` distinct sums, so binary is optimal, not just convenient).

**The FX rate never touches these objects.** `D1024` means 1024 minor units of whatever currency it is provisioned in — a literal number, the same in every currency. The actual points→money conversion (the loyalty ledger's "100 points = €1", converted to the cart's own currency) happens once, upstream, in the loyalty backend, when it computes the amount to redeem. The connector only ever decomposes an already-converted, already-in-the-right-currency figure. This is deliberate: baking the FX rate into the bucket *values* would mean re-provisioning every bucket whenever the rate moves, and would break exact decomposition (a non-integer rate produces rounding gaps).

## 3. How many buckets a currency needs

Because `D1` always means "1 raw minor unit," a currency worth less per minor unit than EUR needs **more** buckets to reach the same real, EUR-equivalent ceiling. Using EUR's own 18-bucket reach (`2^18 − 1 = 262,143` cents = **€2,621.43**) as the target every currency should match:

| Currency | rateToEur (local units per €1) | Minor units needed for €2,621.43 | Levels required | Max reach at that level count |
|---|---:|---:|---:|---|
| EUR | 1.00 | 262,143 | **18** | €2,621.43 |
| USD | 1.00 | 262,143 | **18** | $2,621.43 |
| GBP | 0.85 | 222,822 | **18** | £2,621.43 |
| CHF | 0.96 | 251,658 | **18** | 2,621.43 CHF |
| RON | 4.97 | 1,303,051 | **21** | 20,971.51 RON |
| PLN | 4.25 | 1,114,108 | **21** | 20,971.51 PLN |
| DKK | 7.46 | 1,955,587 | **21** | 20,971.51 DKK |
| SEK | 11.50 | 3,014,645 | **22** | 41,943.03 SEK |
| NOK | 11.80 | 3,093,288 | **22** | 41,943.03 NOK |
| CZK | 25.30 | 6,632,219 | **23** | 83,886.07 CZK |
| HUF | 390.00 | 102,235,770 | **27** | 1,342,177.27 HUF |

Rates are the ones seeded in pierce-loyalty's `FX_RATE` table (`catalog/src/main/resources/db/migration/V1__schema.sql`). HUF's row assumes `fractionDigits: 2` — confirmed live against a real HUF price already in the commercetools project, even though fillér coins have not circulated in decades. If HUF were configured with `fractionDigits: 0` instead, it would need only 20 levels, not 27 — this is a live, per-project fact to check before provisioning a new currency, not something to assume from the ISO 4217 table.

Levels needed always round up to `⌈log2(minor_units_needed + 1)⌉`; a currency's binary reach jumps in powers of two (e.g. RON's 21 levels reach 20,971.51 RON, far more than the €2,621 target — the "waste" is unavoidable rounding up to the next whole level, not a design choice).

**Why per-Store, not one shared multi-currency set:** a live check against `pierce-prod` found 90 of the project's 91 active automatic discounts already global (project-wide), leaving ~10 of the documented 100-discount cap. A shared global set covering many currencies would compete for that same, nearly-exhausted budget. Each commercetools Store has its own independent 100-cap, so provisioning each store's denominations scoped to that store avoids the problem entirely, and lets each store carry exactly the level count its own currency needs.

## 4. A possible simplification: the 100-point step

`pierce-loyalty`'s `RedemptionHoldService` already redeems in **fixed steps of 100 points** (`MAX_POINTS_STEP`) — a documented, existing constraint: *"the storefront's points selector redeems in fixed steps of 100... a native `<input type="range">` can only ever reach a `max` that is itself a multiple of its step."* Since 100 points = exactly €1, every real redemption request is therefore already a whole multiple of "one step" — never a fractional one.

**If — and only if — this is confirmed as a hard, backend-enforced invariant** (not only a storefront UI nicety an API caller could bypass), the buckets can represent **steps** instead of raw minor units. A step's size in a given currency is `round(rateToEur(currency) × 100)` minor units — the money value of 100 points in that currency. Because every redemption is a whole number of steps, the number of levels needed becomes **the same in every currency**, since it is now counting steps (a currency-independent quantity), not minor units:

| Currency | Step size (100 pts, minor units) | Levels for ~2,621 steps |
|---|---:|---:|
| EUR | 100 | **12** |
| RON | 497 | **12** |
| SEK | 1,150 | **12** |
| CZK | 2,530 | **12** |
| HUF | 39,000 | **12** |

Twelve levels reach `2^12 − 1 = 4,095` steps in every currency — more headroom than today's 18-level EUR ceiling, using fewer objects everywhere. Unlike an arbitrary rounding "quantum," this introduces **no precision loss**: a customer physically cannot request an amount that isn't a whole number of steps, so there is nothing to round away.

**What this requires before it can be built:**
1. Product/business confirmation that the 100-point step is permanent system behavior, not just today's UI choice.
2. `pierce-loyalty`'s `/hold` (or whatever computes the redeem amount) must derive that amount as `steps × step_unit(currency)` using the *same* `step_unit` constant the connector's buckets are built from — not an independent `points × rate` calculation each time, which could drift from the bucket values by a minor unit or two at large step counts due to compounding rounding.
3. `/hold` should reject any amount that is not an exact multiple of the configured step, closing the loophole where a non-slider caller (a test, a future API integration) could request an amount the bucket system cannot represent.

This plan deliberately ships the **full-precision** (raw minor unit) version first — §3's table — and treats §4 as a follow-up simplification once (1) is confirmed.

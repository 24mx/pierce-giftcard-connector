# @24mx/loyalty-connector-contract

The storefront-facing API of the Pierce loyalty gift card connector, as data: TypeBox schemas for
`/balance`, `/redeem`, `/finalize`, `/release`, the list of error keys, and one example per message.

    npm install @24mx/loyalty-connector-contract

    import type { RedeemRequest, RedeemResponse, LoyaltyErrorKey } from '@24mx/loyalty-connector-contract';

Every route takes `X-Session-Id` (a commercetools Checkout session for the shopper's cart). Errors
come back as `{ status: { state: <key>, errors: [{ code, message }] } }`.

## Denominations

The arithmetic the connector projects a points discount with: one absolute automatic CartDiscount per
power of two of the cart currency's minor unit, per Store, unlocked when the cart's denominations field
lists its key.

    import { decompose, maxDecomposableMinorUnits, DEFAULT_LOYALTY_DISCOUNT_STORES } from '@24mx/loyalty-connector-contract';

    decompose(1234, 19); // ['D1024', 'D128', 'D64', 'D16', 'D2']

`denominationDiscountKey`, `denominationDiscountName`, `denominationCartPredicate` and
`denominationSortOrder` name the CartDiscounts the post-deploy step provisions; the `DEFAULT_*`
constants are the processor's LOYALTY_* defaults, which a deployment may override.

Versioning: a change to any schema, to the error-key list or to the result of a denomination
function is a **major** bump; a new export is a minor one. The connector's own tests
(`processor/test/contract`) fail when its routes or its denomination copy drift from this package, so a
published version always describes a deployed processor.

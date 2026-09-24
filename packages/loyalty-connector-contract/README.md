# @piercegroup/loyalty-connector-contract

The storefront-facing API of the Pierce loyalty gift card connector, as data: TypeBox schemas for
`/balance`, `/redeem`, `/finalize`, `/release`, the list of error keys, and one example per message.

    npm install @piercegroup/loyalty-connector-contract

    import type { RedeemRequest, RedeemResponse, LoyaltyErrorKey } from '@piercegroup/loyalty-connector-contract';

Every route takes `X-Session-Id` (a commercetools Checkout session for the shopper's cart). Errors
come back as `{ status: { state: <key>, errors: [{ code, message }] } }`.

Versioning: a change to any schema or to the error-key list is a **major** bump. The connector's own
tests (`processor/test/contract`) fail when its routes drift from this package, so a published version
always describes a deployed processor.

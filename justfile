# Pierce loyalty gift card connector — dev tasks.
# `just processor` and `just tunnel` are long-running — run them in separate terminals.
# The loyalty backend that owns the points ledger lives in its own repository.

set shell := ["bash", "-cu"]

# The loyalty backend takes 8080 locally, so the processor moves aside to 8081.
loyalty_port := "8080"
processor_port := "8081"
loyalty_url := "http://localhost:" + loyalty_port
processor_url := "http://localhost:" + processor_port

# List available recipes.
default:
    @just --list

# Run the connector processor against the sandbox. Needs processor/.env. Ctrl-C to stop.
processor port=processor_port:
    cd processor && PORT={{port}} npm run dev

# Prints a https://*.trycloudflare.com address; put it in LOYALTY_API_URL of the deployment.
# Ctrl-C closes the tunnel, and close it as soon as the test is over: it publishes a development
# machine, so keep the window as short as the work needs.
# Expose the local loyalty backend under a public https URL, for a Connect deployment to reach.
tunnel port=loyalty_port:
    cloudflared tunnel --url http://localhost:{{port}} --no-autoupdate

# For a tunnel running outside your own terminal — one you started in the background, or that an
# agent started for you. A `just tunnel` in your own shell just needs Ctrl-C.
# Close the tunnel, so the local backend stops being publicly reachable.
tunnel-stop:
    @pkill -f "cloudflared tunnel" && echo "tunnel closed" || echo "no cloudflared tunnel was running"

# Unit tests.
test:
    cd processor && npm test

# Unit tests in watch mode.
test-watch:
    cd processor && npm run test:watch

# Prettier + eslint.
lint:
    cd processor && npm run lint

# Fix what prettier and eslint can fix on their own.
lint-fix:
    cd processor && npm run lint:fix

# Typecheck and compile to dist/.
build:
    cd processor && npm run build

# Everything CI would check.
check: lint build test

# Mints a Checkout session for a fresh EUR cart, then balance -> redeem -> cancel -> insufficient.
# Writes real Cart/Session/Payment objects. Needs `just processor` and the loyalty backend running.
# Drive the whole connector flow against the sandbox.
e2e url=processor_url:
    node processor/scripts/e2e-checkout-flow.mjs processor/.env {{url}}

# The purchase path the flow above never reaches: redeem -> real Order -> order signal -> capture.
# Stands in for the Kafka consumer. Tops the demo user up if the ledger is short, and asserts.
e2e-order url=processor_url:
    node processor/scripts/e2e-order-signal.mjs processor/.env {{url}}

# Spendable points of a loyalty user (ledger balance minus every open hold).
points-balance user="demo@example.com" base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    auth=(); [ -n "${LOYALTY_API_KEY:-}" ] && auth=(-H "X-Api-Key: ${LOYALTY_API_KEY}")
    curl -s "${auth[@]}" "{{base}}/loyalty/giftcard/balance?userId={{user}}&currency=EUR"
    echo

# Credit demo points, so there is something to redeem.
points-add user="demo@example.com" points="5000" base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    auth=(); [ -n "${LOYALTY_API_KEY:-}" ] && auth=(-H "X-Api-Key: ${LOYALTY_API_KEY}")
    curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      -d '{"userId":"{{user}}","points":{{points}},"reason":"local dev"}' \
      "{{base}}/loyalty/demo/points"
    echo

# Release a hold that a test left behind.
points-void payment base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    auth=(); [ -n "${LOYALTY_API_KEY:-}" ] && auth=(-H "X-Api-Key: ${LOYALTY_API_KEY}")
    curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      -d '{"paymentId":"{{payment}}"}' "{{base}}/loyalty/giftcard/void"
    echo

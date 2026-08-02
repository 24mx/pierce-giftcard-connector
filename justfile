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

# ---------------------------------------------------------------------------
# Shipping a change to commercetools
# ---------------------------------------------------------------------------
# Connect never reads your disk, and never reads a branch. It reads one immutable git tag from a
# public repository. So a change reaches CT only by: commit -> new tag -> push -> repoint the draft
# -> rebuild. `just release vX.Y.Z` does every step after the commit; `just redeploy` then restarts
# the running deployment on the new build.

# The tag pushed to the public mirror. The private repo stays the working remote.
public_remote := "public"

# Publish the current commit as a new connector version and rebuild it in CT.
release tag:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "$(git status --porcelain)" ]; then
        echo "working tree is dirty — commit first, a tag must name a finished state" >&2
        exit 1
    fi
    just check
    git tag -a {{tag}} -m "Connector release {{tag}}"
    git push {{public_remote}} HEAD:main
    git push {{public_remote}} {{tag}}
    node scripts/ct-connector.mjs set-tag {{tag}}
    node scripts/ct-connector.mjs preview
    # A deployment can only reference a published connector, so the new tag has to be published
    # before any deployment can pick it up.
    node scripts/ct-connector.mjs publish
    echo
    echo "Released {{tag}}. Now run 'just connector-status' and compare the deployment's"
    echo "connectorVersion against the draft: a deployment pins the connector version it was"
    echo "created with, so if it has not moved, replace it rather than redeploying."

# Draft state, previewable report, and which deployments this project runs.
connector-status:
    node scripts/ct-connector.mjs status

# Private publication only — never lists the connector on the marketplace. A deployment can only
# reference a published connector, so a new tag needs this before `just deploy` sees it.
# Publish the previewable draft so the project can deploy it.
connector-publish:
    node scripts/ct-connector.mjs publish

# Pass the https://*.trycloudflare.com address from `just tunnel` — a deployment cannot reach
# localhost. Reads every other value from processor/.env.
# Create this connector's deployment in the project.
deploy tunnel_url:
    node scripts/ct-connector.mjs deploy {{tunnel_url}}

# Rebuild the draft without cutting a tag — for retrying a failed build.
connector-preview:
    node scripts/ct-connector.mjs preview

# Restarts the same build with the same configuration — it cannot change LOYALTY_API_URL and it
# cannot pick up a newer connector version. For a new tunnel address use `just retunnel`.
# Restart this connector's deployment.
redeploy:
    node scripts/ct-connector.mjs redeploy

# Point the deployment at a new tunnel address. Neither a deployment's configuration nor a payment
# integration's deployment reference can be edited, so this builds a new deployment, moves the
# Checkout integration onto it, and deletes the old one. Takes a few minutes.
# Move the whole stack onto a new tunnel URL.
retunnel tunnel_url:
    node scripts/ct-connector.mjs retunnel {{tunnel_url}}

# Stands in for the Kafka consumer. Tops the demo user up if the ledger is short, and asserts.
# The purchase path `just e2e` never reaches: redeem -> real Order -> order signal -> capture.
e2e-order url=processor_url:
    node processor/scripts/e2e-order-signal.mjs processor/.env {{url}}

# Spendable points of a loyalty user (ledger balance minus every open hold).
points-balance user="demo@example.com" base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    # The key lives in processor/.env, not in your shell — an exported one still wins if you set it.
    key="${LOYALTY_API_KEY:-$(grep -h '^LOYALTY_API_KEY=' processor/.env 2>/dev/null | cut -d= -f2- | tr -d '\042\047')}"
    auth=(); [ -n "$key" ] && auth=(-H "X-Api-Key: $key")
    curl -s "${auth[@]}" "{{base}}/loyalty/giftcard/balance?userId={{user}}&currency=EUR"
    echo

# Credit demo points, so there is something to redeem.
points-add user="demo@example.com" points="5000" base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    # The key lives in processor/.env, not in your shell — an exported one still wins if you set it.
    key="${LOYALTY_API_KEY:-$(grep -h '^LOYALTY_API_KEY=' processor/.env 2>/dev/null | cut -d= -f2- | tr -d '\042\047')}"
    auth=(); [ -n "$key" ] && auth=(-H "X-Api-Key: $key")
    curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      -d '{"userId":"{{user}}","points":{{points}},"reason":"local dev"}' \
      "{{base}}/loyalty/demo/points"
    echo

# Release a hold that a test left behind.
points-void payment base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    # The key lives in processor/.env, not in your shell — an exported one still wins if you set it.
    key="${LOYALTY_API_KEY:-$(grep -h '^LOYALTY_API_KEY=' processor/.env 2>/dev/null | cut -d= -f2- | tr -d '\042\047')}"
    auth=(); [ -n "$key" ] && auth=(-H "X-Api-Key: $key")
    curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      -d '{"paymentId":"{{payment}}"}' "{{base}}/loyalty/giftcard/void"
    echo

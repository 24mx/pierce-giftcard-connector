# Pierce loyalty gift card connector — dev tasks.
# `just processor` and `just ngrok` are long-running — run them in separate terminals.
# `just funnel` is not: it hands the config to tailscaled and returns.
# The loyalty backend that owns the points ledger lives in its own repository.

set shell := ["bash", "-cu"]

# The loyalty backend takes 8080 locally, so the processor moves aside to 8081.
loyalty_port := "8080"
processor_port := "8081"
loyalty_url := "http://localhost:" + loyalty_port
processor_url := "http://localhost:" + processor_port

env_file := "processor/.env"

# Both public addresses are permanent, and neither is written down here: this repository is public,
# and a Funnel hostname names a development machine while an ngrok domain names an account. They
# live in processor/.env instead, as FUNNEL_DOMAIN and NGROK_DOMAIN — bare hostnames, no scheme.
# FUNNEL_DOMAIN is optional: without it `just funnel-url` asks tailscaled for this machine's
# hostname, which is the same answer. NGROK_DOMAIN has no such fallback, since only the account
# knows what it reserved.

# List available recipes.
default:
    @just --list

# Values this public repository deliberately does not carry. An exported shell variable wins over
# processor/.env; a missing key is an empty string, for the caller to reject or fall back on.
[private]
env-value key:
    #!/usr/bin/env bash
    set -euo pipefail
    name="{{key}}"
    printf '%s' "${!name:-$(grep -h "^{{key}}=" {{env_file}} 2>/dev/null | cut -d= -f2- | tr -d '\042\047')}"

# Run the connector processor against the sandbox. Needs processor/.env. Ctrl-C to stop.
processor port=processor_port:
    cd processor && PORT={{port}} npm run dev

# ---------------------------------------------------------------------------
# Exposing the local loyalty backend
# ---------------------------------------------------------------------------
# A deployment cannot reach localhost, so the backend needs a public https address. A deployment
# also freezes LOYALTY_API_URL at creation and nothing can edit it afterwards, so every change of
# address costs a `just retunnel`: a new deployment plus a new Checkout integration, minutes each
# time. Both options below therefore use a permanent address, and Funnel is the default — ngrok is
# the fallback for when Tailscale is unavailable.
# Either way this publishes a development machine — close it when the work is done.

# Tailscale Funnel, the permanent address. `--bg` stores the config in tailscaled, so the command
# returns at once and the address comes back on its own after a reboot: it outlives both the
# terminal and the machine restarting. Funnel listens publicly on 443 and proxies to the local port.
# Publish the loyalty backend under this machine's permanent Funnel address.
funnel port=loyalty_port:
    tailscale funnel --bg {{port}}
    @just funnel-url

# FUNNEL_DOMAIN if processor/.env names one, otherwise whatever tailscaled says this machine is —
# the same value, so the entry only matters when you want a specific node rather than this one.
# Print this machine's Funnel address — the value for `just deploy` / `just retunnel`.
funnel-url:
    #!/usr/bin/env bash
    set -euo pipefail
    domain="$(just env-value FUNNEL_DOMAIN)"
    if [ -z "$domain" ]; then
        domain=$(tailscale status --json |
          python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    fi
    echo "https://${domain}"

# What this machine publishes, and which local port it proxies to.
funnel-status:
    tailscale funnel status

# Funnel survives reboots, so this is the only thing that stops publishing the backend.
# Stop publishing over Funnel.
funnel-stop:
    tailscale funnel reset

# The other permanent address, for when Tailscale's control plane is having a bad day — the free
# plan reserves one domain per account. Long-running: Ctrl-C closes it and, unlike Funnel, nothing
# brings it back by itself.
# Publish the loyalty backend under the reserved ngrok domain.
ngrok port=loyalty_port domain="":
    #!/usr/bin/env bash
    set -euo pipefail
    domain="{{domain}}"
    if [ -z "$domain" ]; then
        domain="$(just env-value NGROK_DOMAIN)"
    fi
    if [ -z "$domain" ]; then
        echo "NGROK_DOMAIN is not set — put the domain reserved on your ngrok account in {{env_file}}" >&2
        exit 1
    fi
    ngrok http {{port}} --url="$domain"

# A local curl proves nothing about a Funnel address. tailscaled routes every ts.net lookup straight
# to Tailscale's own nameserver, so this machine resolves a Funnel hostname that public DNS may not
# carry at all — it answers here and is unreachable from everywhere else. So ask public resolvers
# instead, and two of them, because one serving a stale negative answer is not the same thing as the
# address being down. Then call /balance through it: the path a Connect deployment takes.
# Prove a public address really reaches the loyalty backend from the internet.
tunnel-check url:
    #!/usr/bin/env bash
    set -euo pipefail
    host=$(echo "{{url}}" | sed -E 's#^https?://##; s#/.*##')
    resolve() {
        curl -s --max-time 15 -H 'accept: application/dns-json' "$1" |
          python3 -c 'import json,sys; a=json.load(sys.stdin).get("Answer") or []; print(next((r["data"] for r in a if r.get("type")==1), ""))'
    }
    google=$(resolve "https://dns.google/resolve?name=${host}&type=A" || true)
    cloudflare=$(resolve "https://cloudflare-dns.com/dns-query?name=${host}&type=A" || true)
    adguard=$(resolve "https://dns.adguard-dns.com/resolve?name=${host}&type=A" || true)
    echo "public DNS — google: ${google:-NXDOMAIN}  cloudflare: ${cloudflare:-NXDOMAIN}  adguard: ${adguard:-NXDOMAIN}"
    ip="${google:-${cloudflare:-$adguard}}"
    if [ -z "$ip" ]; then
        echo "${host} resolves for no public resolver — nothing on the internet can reach it" >&2
        exit 1
    fi
    # Three resolvers, because one of them is not a verdict: during a Tailscale incident Google and
    # Cloudflare both served NXDOMAIN for a Funnel name that AdGuard resolved and that answered fine.
    # Whoever disagrees is a real risk, though — a deployment inherits whatever resolver it happens
    # to use, so partial resolution means the address works for some callers and not others.
    if [ -z "$google" ] || [ -z "$cloudflare" ] || [ -z "$adguard" ]; then
        echo "WARNING: public resolvers disagree — reachable through some, unreachable through others" >&2
    fi
    # The key lives in processor/.env, not in your shell — an exported one still wins if you set it.
    key="$(just env-value LOYALTY_API_KEY)"
    curl -s -w '\n--- http=%{http_code} ip=%{remote_ip} tls_verify=%{ssl_verify_result}\n' \
      --max-time 30 --resolve "${host}:443:${ip}" -H "X-Api-Key: ${key}" \
      "{{url}}/loyalty/giftcard/balance?userId=demo%40example.com&currency=EUR"

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

# The remote Connect reads: the tag has to exist there, under the URL the connector draft names.
# `just connector-status` prints that URL — this remote must be the one pointing at it.
public_remote := "origin"

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

# Pass the public address of the loyalty backend — `just funnel-url` or the ngrok domain. A
# deployment cannot reach localhost. Every other value comes from processor/.env.
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
# Both `just funnel` and `just ngrok` hold their address permanently, so this should be a one-time
# cost — needing it twice for the same machine means the address moved and something is wrong.
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
    key="$(just env-value LOYALTY_API_KEY)"
    auth=(); [ -n "$key" ] && auth=(-H "X-Api-Key: $key")
    curl -s "${auth[@]}" "{{base}}/loyalty/giftcard/balance?userId={{user}}&currency=EUR"
    echo

# Credit demo points, so there is something to redeem.
points-add user="demo@example.com" points="5000" base=loyalty_url:
    #!/usr/bin/env bash
    set -eo pipefail
    # The key lives in processor/.env, not in your shell — an exported one still wins if you set it.
    key="$(just env-value LOYALTY_API_KEY)"
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
    key="$(just env-value LOYALTY_API_KEY)"
    auth=(); [ -n "$key" ] && auth=(-H "X-Api-Key: $key")
    curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' \
      -d '{"paymentId":"{{payment}}"}' "{{base}}/loyalty/giftcard/void"
    echo

# Local development

Command reference and local testing guide for the Pierce fork. The root `README.md` is upstream
template documentation; everything here is specific to this fork, where the "gift card" is a
customer's loyalty point balance.

Every command is a `just` recipe — run `just` with no arguments for the same list with one-line
descriptions.

## Prerequisites

| What | Why |
|---|---|
| Node 24.18.0 (see `.nvmrc`) | processor and the harness scripts |
| [`just`](https://github.com/casey/just) | every command below |
| `tailscale` (Homebrew formula) | public address for the backend — the App Store / standalone Mac app cannot serve Funnel |
| `ngrok` | fallback public address |
| `processor/.env` | copied from `.env.template`, filled in with project credentials and the two tunnel domains |
| The loyalty backend, running on `:8080` | owns the points ledger; lives in the `pierce-loyalty` repository together with the demo checkout UI |

The backend takes 8080, so the processor moves aside to **8081**.

`processor/.env` supplies every value the CT deployment gets, except `LOYALTY_API_URL` which is
passed on the command line. `LOYALTY_API_KEY` is read from it by the harness scripts and by the
`points-*` recipes, so an exported shell variable is not needed — though an exported one wins.

It also carries the two tunnel addresses, which the `justfile` reads and the processor never sees.
This repository is public, and a Funnel hostname names your machine while a reserved ngrok domain
names your account, so neither is committed:

| Key | Needed for |
|---|---|
| `FUNNEL_DOMAIN` | optional — without it `just funnel-url` asks `tailscaled` and gets the same answer. Set it only to name a node other than the one you are on |
| `NGROK_DOMAIN` | required by `just ngrok`, which has nothing to fall back on: only the account knows what it reserved |

Both are bare hostnames, no `https://` prefix — `just funnel-url` adds the scheme.

## Commands

### Running locally

| Command | What it does |
|---|---|
| `just processor` | runs the processor on 8081 against the sandbox. Long-running, Ctrl-C to stop |

### Exposing the backend to commercetools

A deployment runs in CT's cloud and cannot reach `localhost`, so the loyalty backend needs a public
https address.

| Command | What it does |
|---|---|
| `just funnel` | publishes `:8080` under this machine's permanent Tailscale Funnel address, then prints it |
| `just funnel-url` | prints that address — `FUNNEL_DOMAIN` if set, otherwise whatever `tailscaled` reports. The value for `just deploy` / `just retunnel` |
| `just funnel-status` | what is published, and which local port it proxies to |
| `just funnel-stop` | stops publishing (`tailscale funnel reset`) |
| `just ngrok` | the fallback: publishes `:8080` under `NGROK_DOMAIN`. Long-running |
| `just tunnel-check <url>` | proves the address is reachable **from the internet** |

`just funnel` returns immediately: `--bg` stores the config in `tailscaled`, so the address comes
back on its own after a reboot. `just ngrok` does not — Ctrl-C ends it and nothing restarts it.

### Quality gates

| Command | What it does |
|---|---|
| `just test` | unit tests |
| `just test-watch` | unit tests in watch mode |
| `just lint` | prettier + eslint |
| `just lint-fix` | fixes what those two can fix alone |
| `just build` | typecheck and compile to `dist/` |
| `just check` | lint + build + test — everything CI checks |

### Local end-to-end harnesses

Both drive the locally running processor and write real Cart / Session / Payment objects into the
sandbox project. They need `just processor` and the loyalty backend up.

| Command | What it covers |
|---|---|
| `just e2e` | mints a Checkout session for a fresh EUR cart, then balance → redeem → cancel → insufficient |
| `just e2e-order` | the purchase path `just e2e` never reaches: redeem → real Order → order signal → capture. Stands in for the Kafka consumer |

`just e2e-order` asserts against the **ledger**, not the spendable balance: a hold and a capture
lower spendable by the same amount, but only a capture writes a ledger row.

### Loyalty ledger helpers

| Command | What it does |
|---|---|
| `just points-balance [user]` | spendable points — ledger balance minus every open hold |
| `just points-add [user] [points]` | credits demo points, so there is something to redeem |
| `just points-void <paymentId>` | releases a hold a test left behind |

### Shipping to commercetools

| Command | What it does |
|---|---|
| `just release vX.Y.Z` | `just check`, tag, push to the public mirror, repoint the draft, rebuild, publish |
| `just connector-status` | draft state, previewable report, and every deployment in the project |
| `just connector-preview` | rebuilds the draft without cutting a tag — for retrying a failed build |
| `just connector-publish` | publishes the previewable draft (privately — never listed on the marketplace) |
| `just deploy <url>` | creates this connector's deployment, pointed at `<url>` |
| `just redeploy` | restarts the running deployment on the same build and the same configuration |
| `just retunnel <url>` | moves the whole stack onto a new address: new deployment, Checkout integration swapped onto it, old one deleted |

## Two ways to test

### 1. Locally, without touching a deployment

Fastest loop, and enough for anything that is not about the widget itself. Three terminals:

```bash
# terminal 1 — the loyalty backend, from the pierce-loyalty repository
# terminal 2
just processor
# terminal 3
just points-add            # make sure there is something to redeem
just e2e
just e2e-order
```

No public address is involved: the harnesses call the processor on localhost, and the processor
calls the backend on localhost.

### 2. Through real Checkout, with the deployed connector

Needed whenever the change touches the enabler, the widget, or anything a shopper sees.

```bash
just funnel                                  # once per machine
just tunnel-check "$(just funnel-url)"        # must print http=200 before going further
just retunnel "$(just funnel-url)"            # once — the address never changes afterwards
just connector-status                         # confirm the new deployment carries the address
```

Then drive the demo checkout UI from the `pierce-loyalty` repository.

## Constraints worth knowing before they bite

**Connect never reads your disk, and never reads a branch.** It reads one immutable git tag from a
public repository. A change reaches CT only as: commit → new tag → push → repoint the draft →
rebuild. That is what `just release` does, and it is why an edited working tree changes nothing in
CT.

**A deployment freezes its configuration and its connector version at creation.** `just redeploy`
can change neither: not `LOYALTY_API_URL`, not the connector version. A new address or a new version
means a *new* deployment — `just retunnel` chains that with swapping the Checkout integration,
because a payment integration's `connectorDeployment` reference is frozen too. It takes a few
minutes and leaves a gap of a few seconds where the gift card is not offered in Checkout.

**With a permanent address, `just retunnel` is a one-time cost.** Needing it twice for the same
machine means the address moved, which is a problem to diagnose rather than to work around.

**A local `curl` — or a browser on your machine — proves nothing about a Funnel address.**
`tailscaled` installs a split-DNS route sending every `ts.net` lookup straight to Tailscale's own
nameserver, which answers with the public ingress address. So the request does leave the machine and
does reach the backend, while a public resolver may not have the name at all. `just tunnel-check`
asks three public resolvers instead, then calls `/balance` through what they return — the path a
deployment takes. It takes three because one is not a verdict in either direction: a resolver can
serve `NXDOMAIN` for a name that answers perfectly well elsewhere.

**Publishing the backend publishes a development machine.** Funnel survives reboots, so it keeps
doing so until `just funnel-stop`. Close it when the work is done.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_NGROK_8012`, `dial tcp [::1]:80: connection refused` | ngrok started without a port, so it forwarded to `:80` | `just ngrok`, which passes 8080 |
| `NGROK_DOMAIN is not set` | a fresh clone — the domain is not committed, because this repository is public | add `NGROK_DOMAIN` to `processor/.env`, or pass it once: `just ngrok 8080 <domain>` |
| `404` on the public address root | there is no route at `/`; the tunnel is fine | call `/loyalty/giftcard/balance`, or `just tunnel-check` |
| Funnel address gives `NXDOMAIN`, and `tailscale cert <host>` fails with `set-dns response: 500` | Tailscale's coordination service publishes both that DNS record and the ACME challenge; a control-plane incident blocks both | check <https://status.tailscale.com>, then re-run. Everything local (`funnel status`, `CertDomains`, node capabilities) looks healthy meanwhile, so trust the 500 over the local view |
| The Funnel address works in your browser, and you want to conclude the deployment is fine | your machine resolves `ts.net` through Tailscale's own nameserver, so a browser here says nothing about public DNS | `just tunnel-check`, which asks resolvers that have no such shortcut |
| One resolver says `NXDOMAIN` for a Funnel address that plainly works | observed during a Tailscale coordination-service incident: Google and Cloudflare both served `NXDOMAIN` while AdGuard resolved the same name and the address answered `200` | a single resolver is not a verdict. `just tunnel-check` asks three and warns when they disagree — and disagreement is still a real risk, because a deployment inherits whichever resolver it happens to use |
| `401` from the deployment's `/operations/status` | that route is behind a CT-issued JWT | expected; it only proves the service is up |
| Backend answers `/balance` but `/health` returns `503` | the backend reports itself unhealthy | a backend matter, not a tunnel one — but the connector's health check will show it as down |
| The points slider is ignored and the whole balance is spent | the code must name an amount as `Valid-<centAmount>-<CURRENCY>`, and the currency must match the cart. Anything else is not an instruction, so the full balance is offered | check the code the widget sends |
| `just release` fails on a dirty working tree | a tag must name a finished state | commit first |

## Other resources

* [Developer documentation](/docs/TECH_DOCUMENTATION.md)
* [Pierce connector guidelines](/docs/PIERCE_CONNECTOR_GUIDELINES_EN.md)
* [Pierce design](/docs/PIERCE_DESIGN_EN.md)

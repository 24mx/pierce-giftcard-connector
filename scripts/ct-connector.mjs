// Talks to the commercetools Connect API about this connector.
//
// Connect reads the code from a public git tag, never from your disk and never from a branch, so
// every change reaches CT the same way: commit, tag, push, repoint the draft, rebuild. The `release`
// recipe in the justfile chains exactly that; the subcommands here are the individual steps.
//
// Usage: [CONNECT_ENV=<name>] node scripts/ct-connector.mjs <command> [args]
//
// CONNECT_ENV picks the target: unset reads processor/.env (the sandbox), `test1` reads
// processor/.env.test1, and so on. Each file names its own project, API client and, through
// CONNECTOR_KEY, its own connector draft -- a draft lives in one organization and lists the
// projects allowed to deploy it, so the sandbox and pierce-test1 each have their own.
//
// Two API clients, each taken from the env file when it sets them, otherwise from the macOS Keychain
// (account = client id, password = client secret; only for a named CONNECT_ENV):
//   this script's own, for Connect and Checkout   DEPLOY_CLIENT_ID/SECRET  or  pierce-deploy-connector-<env>
//   the deployment's CTP_CLIENT_ID/SECRET          CTP_CLIENT_ID/SECRET     or  pierce-loyalty-giftcard-<env>
// With neither, the script's client falls back to the deployment's one, which is how the sandbox runs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const CONNECT_URL = 'https://connect.europe-west1.gcp.commercetools.com';
const CONNECT_ENV = process.env.CONNECT_ENV || '';
const ENV_FILE = CONNECT_ENV ? `processor/.env.${CONNECT_ENV}` : 'processor/.env';

if (!existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} does not exist; copy processor/.env.template and fill it in for ${CONNECT_ENV || 'the sandbox'}`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
);

const CONNECTOR_KEY = env.CONNECTOR_KEY || 'pierce-loyalty-giftcard';

const keychainClient = (service) => {
  if (!CONNECT_ENV) {
    return null;
  }
  try {
    const read = (...extra) => execFileSync('security', ['find-generic-password', '-s', service, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const id = read().match(/"acct"<blob>="([^"]*)"/)?.[1];
    const secret = read('-w').trim();
    return id && secret ? { id, secret, source: `Keychain ${service}` } : null;
  } catch {
    // `security` exits non-zero when the entry does not exist.
    return null;
  }
};

const envClient = (prefix) => (env[`${prefix}_ID`] && env[`${prefix}_SECRET`] ? { id: env[`${prefix}_ID`], secret: env[`${prefix}_SECRET`], source: `${ENV_FILE} ${prefix}_*` } : null);

const clientOrExit = (role, ...candidates) => {
  const client = candidates.find(Boolean);
  if (!client) {
    console.error(`no API client for ${role}: set it in ${ENV_FILE} or add a Keychain entry`);
    console.error(`  security add-generic-password -s "<entry>" -a "<CLIENT_ID>" -w "<CLIENT_SECRET>" -U`);
    process.exit(1);
  }
  return client;
};

// Read lazily: only creating a deployment needs it, and status or publish should not demand it.
const runtimeClient = () => clientOrExit('the deployment (CTP_CLIENT_ID)', envClient('CTP_CLIENT'), keychainClient(`pierce-loyalty-giftcard-${CONNECT_ENV}`));
const deployClient = clientOrExit(
  'this script (DEPLOY_CLIENT_ID)',
  envClient('DEPLOY_CLIENT'),
  keychainClient(`pierce-deploy-connector-${CONNECT_ENV}`),
  envClient('CTP_CLIENT'),
);
// Every command acts on a real project, so say which one before doing anything.
console.error(`[${CONNECT_ENV || 'sandbox'}] project=${env.CTP_PROJECT_KEY} connector=${CONNECTOR_KEY} (${ENV_FILE})`);
console.error(`    script client: ${deployClient.source}`);

const token = await (async () => {
  const res = await fetch(`${env.CTP_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${deployClient.id}:${deployClient.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    console.error(`token failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()).access_token;
})();

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const call = async (method, path, body) => {
  const res = await fetch(`${CONNECT_URL}${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}  ${text.slice(0, 600)}`);
    process.exit(1);
  }
  return parsed;
};

const draft = () => call('GET', `/connectors/drafts/key=${CONNECTOR_KEY}`);
const updateDraft = async (actions) => call('POST', `/connectors/drafts/key=${CONNECTOR_KEY}`, { version: (await draft()).version, actions });
const deployments = () => call('GET', `/${env.CTP_PROJECT_KEY}/deployments`);
const myDeployments = async () => (await deployments()).results?.filter((dep) => dep.connector?.key === CONNECTOR_KEY) ?? [];

// --- Checkout API: the payment integration that puts this connector in front of a shopper -------
const CHECKOUT_URL = env.CTP_CHECKOUT_URL || 'https://checkout.europe-west1.gcp.commercetools.com';
const INTEGRATION_NAME = 'pierce-loyalty-points';

const checkout = async (method, path, body) => {
  const res = await fetch(`${CHECKOUT_URL}/${env.CTP_PROJECT_KEY}${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}  ${text.slice(0, 500)}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
};

const myIntegration = async () =>
  (await checkout('GET', '/payment-integrations')).results?.find((pi) => pi.name === INTEGRATION_NAME);

const createDeployment = async (loyaltyUrl) => {
  const required = ['CTP_PROJECT_KEY', 'CTP_AUTH_URL', 'CTP_API_URL', 'CTP_SESSION_URL', 'CTP_JWKS_URL', 'CTP_JWT_ISSUER', 'LOYALTY_API_KEY'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    console.error(`${ENV_FILE} is missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  // A deployment's configuration is frozen at creation, so an unfilled "[...]" from the template would
  // ship as a real value with no way to correct it short of a new deployment.
  const placeholders = Object.keys(env).filter((key) => /^\[.*\]$/.test(env[key]));
  if (placeholders.length) {
    console.error(`${ENV_FILE} still has placeholders: ${placeholders.join(', ')}`);
    process.exit(1);
  }
  const client = runtimeClient();
  console.log(`deployment client: ${client.source}`);
  return call('POST', `/${env.CTP_PROJECT_KEY}/deployments`, {
    connector: { key: CONNECTOR_KEY },
    region: 'europe-west1.gcp',
    configurations: [
      {
        applicationName: 'processor',
        standardConfiguration: [
          { key: 'CTP_PROJECT_KEY', value: env.CTP_PROJECT_KEY },
          { key: 'CTP_AUTH_URL', value: env.CTP_AUTH_URL },
          { key: 'CTP_API_URL', value: env.CTP_API_URL },
          { key: 'CTP_SESSION_URL', value: env.CTP_SESSION_URL },
          { key: 'CTP_CLIENT_ID', value: client.id },
          { key: 'CTP_JWKS_URL', value: env.CTP_JWKS_URL },
          { key: 'CTP_JWT_ISSUER', value: env.CTP_JWT_ISSUER },
          { key: 'LOYALTY_API_URL', value: loyaltyUrl.replace(/\/$/, '') },
          { key: 'LOYALTY_TIMEOUT_MS', value: env.LOYALTY_TIMEOUT_MS || '5000' },
          // The redemption's cart fields and discount catalogue; only sent when overridden, so the
          // connect.yaml defaults (which the loyalty backend's defaults mirror) apply otherwise.
          ...[
            'LOYALTY_CART_TYPE_KEY',
            'LOYALTY_REDEMPTION_ID_FIELD',
            'LOYALTY_DENOMINATIONS_FIELD',
            'LOYALTY_DISCOUNT_KEY_PREFIX',
            'LOYALTY_DISCOUNT_STORES',
            'LOYALTY_DISCOUNT_SORT_ORDER_BASE',
          ]
            .filter((key) => env[key])
            .map((key) => ({ key, value: env[key] })),
        ],
        securedConfiguration: [
          { key: 'CTP_CLIENT_SECRET', value: client.secret },
          { key: 'LOYALTY_API_KEY', value: env.LOYALTY_API_KEY },
          // Cloudflare Access service token for the backend's public hostname; sent only when set.
          ...['LOYALTY_CF_ACCESS_CLIENT_ID', 'LOYALTY_CF_ACCESS_CLIENT_SECRET']
            .filter((key) => env[key])
            .map((key) => ({ key, value: env[key] })),
        ],
      },
      { applicationName: 'enabler' },
    ],
  });
};

const awaitDeployed = async (id) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const dep = (await myDeployments()).find((d) => d.id === id);
    if (dep && dep.status !== 'Deploying' && dep.status !== 'Queued') {
      console.log(`\n   ${dep.status}`);
      return dep;
    }
    process.stdout.write(attempt === 0 ? '   deploying' : '.');
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.error('\n   still deploying after 10 minutes');
  process.exit(1);
};

// A tunnel address on the command line wins; otherwise LOYALTY_API_URL of the env file, which for a
// shared environment such as test1 is the backend's fixed address rather than a tunnel.
const publicUrlOrExit = (arg, verb) => {
  const url = arg || env.LOYALTY_API_URL;
  if (!url) {
    console.error(`usage: ${verb} <public-loyalty-url>    (the address from \`just funnel-url\`, or LOYALTY_API_URL in ${ENV_FILE})`);
    process.exit(1);
  }
  if (/localhost|127\.0\.0\.1/.test(url)) {
    // From inside the deployment, localhost is the deployment itself.
    console.error('a deployment cannot reach localhost; start `just funnel` and pass its https URL');
    process.exit(1);
  }
  return url;
};

/** CT rebuilds asynchronously; the report only becomes readable once it stops saying "pending". */
const awaitPreview = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await draft();
    if (current.isPreviewable !== 'pending') {
      console.log(`isPreviewable: ${current.isPreviewable}`);
      for (const entry of current.previewableReport?.entries ?? []) {
        console.log(`   ${entry.type === 'Information' ? 'ok  ' : entry.type}  ${entry.title}`);
        if (entry.message) {
          console.log(`         ${entry.message}`);
        }
      }
      // A string, not a boolean: the field carries "true" / "false" / "pending", and comparing it
      // against `true` made every preview report failure — `just release` died here each time,
      // after a build that had actually succeeded, and never reached publish.
      return String(current.isPreviewable) === 'true';
    }
    process.stdout.write(attempt === 0 ? '   building' : '.');
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log('\n   still pending after 10 minutes; check again with `just connector-status`');
  return false;
};

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'status': {
    const d = await draft();
    console.log(`key          ${d.key}`);
    console.log(`status       ${d.status}`);
    console.log(`repository   ${d.repository?.url}`);
    console.log(`tag          ${d.repository?.tag}`);
    console.log(`previewable  ${d.isPreviewable}`);
    for (const entry of d.previewableReport?.entries ?? []) {
      console.log(`   ${entry.type === 'Information' ? 'ok  ' : entry.type}  ${entry.title}`);
    }
    // The project also carries the two sample connectors that shipped with the checkout demo, so
    // the listing marks which deployment is actually ours rather than assuming there is only one.
    const list = await deployments();
    console.log(`deployments  ${list.results?.length ?? 0}`);
    for (const dep of list.results ?? []) {
      const mine = dep.connector?.key === CONNECTOR_KEY;
      // connectorVersion matters: a deployment pins the connector version it was created with and
      // never moves off it, so a republished connector shows up here as drift from the draft.
      console.log(`   ${mine ? '->' : '  '} ${dep.connector?.key ?? dep.id}  ${dep.status}  tag=${dep.connector?.repository?.tag ?? '?'}  connectorVersion=${dep.connector?.version ?? '?'}`);
      if (mine) {
        for (const app of dep.applications ?? []) {
          console.log(`        ${app.applicationName}: ${app.url}`);
        }
        // The address the deployment calls the ledger on -- stale after the tunnel restarts.
        const loyalty = (dep.applications ?? [])
          .flatMap((app) => app.standardConfiguration ?? [])
          .find((entry) => entry.key === 'LOYALTY_API_URL');
        if (loyalty) {
          console.log(`        LOYALTY_API_URL: ${loyalty.value}`);
        }
      }
    }
    if (!(list.results ?? []).some((dep) => dep.connector?.key === CONNECTOR_KEY)) {
      console.log('   (none of these is this connector -- create it with `just deploy <tunnel-url>`)');
    }
    break;
  }

  case 'set-tag': {
    const [tag] = args;
    if (!tag) {
      console.error('usage: set-tag <git-tag>');
      process.exit(1);
    }
    const d = await draft();
    const updated = await updateDraft([{ action: 'setRepository', url: d.repository.url, tag }]);
    console.log(`draft now points at ${updated.repository.tag}`);
    break;
  }

  case 'preview': {
    await updateDraft([{ action: 'updatePreviewable' }]);
    process.exit((await awaitPreview()) ? 0 : 1);
  }

  case 'publish': {
    // Private publication: the connector becomes deployable in your own projects and nothing more.
    // Listing it on the marketplace is a separate action (triggerCertification) that this never does.
    await updateDraft([{ action: 'publish', certification: false }]);
    console.log('publishing (CT processes this asynchronously)');
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await draft();
      if (current.status !== 'Processing') {
        console.log(`status: ${current.status}`);
        process.exit(current.status === 'Published' ? 0 : 1);
      }
      process.stdout.write(attempt === 0 ? '   working' : '.');
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log('\n   still processing; check again with `just connector-status`');
    break;
  }

  case 'deploy': {
    const created = await createDeployment(publicUrlOrExit(args[0], 'deploy'));
    console.log(`deployment ${created.id} requested; watch it with \`just connector-status\``);
    break;
  }

  case 'retunnel': {
    // A deployment's configuration is frozen at creation: the endpoint takes no configurations key
    // and `redeploy` is its only action. And a payment integration's connectorDeployment is frozen
    // too. So a new tunnel address costs a new deployment AND a new integration -- this chains both,
    // building the replacements before tearing the old ones down.
    const loyaltyUrl = publicUrlOrExit(args[0], 'retunnel');
    const oldDeployments = await myDeployments();
    const oldIntegration = await myIntegration();

    console.log('1. new deployment');
    const fresh = await awaitDeployed((await createDeployment(loyaltyUrl)).id);
    if (fresh.status !== 'Deployed') {
      console.error(`   deployment ended as ${fresh.status}; leaving the old one alone`);
      process.exit(1);
    }

    if (oldIntegration) {
      console.log('2. swap the Checkout integration');
      // Name looks unique per application, so the old one goes first; the gap is a few seconds.
      await checkout('DELETE', `/payment-integrations/${oldIntegration.id}?version=${oldIntegration.version}`);
      const made = await checkout('POST', '/payment-integrations', {
        application: oldIntegration.application,
        type: oldIntegration.type,
        name: INTEGRATION_NAME,
        componentType: oldIntegration.componentType,
        connectorDeployment: { id: fresh.id, typeId: 'deployment' },
        ...(oldIntegration.displayInfo && { displayInfo: oldIntegration.displayInfo }),
      });
      if (made.status !== 'Active') {
        await checkout('POST', `/payment-integrations/${made.id}`, {
          version: made.version,
          actions: [{ action: 'setStatus', status: 'Active' }],
        });
      }
      console.log(`   integration ${made.id} -> deployment ${fresh.id}`);
    }

    console.log('3. remove the superseded deployment(s)');
    for (const dep of oldDeployments) {
      const res = await fetch(`${CONNECT_URL}/${env.CTP_PROJECT_KEY}/deployments/${dep.id}?version=${dep.version}`, { method: 'DELETE', headers });
      console.log(`   ${dep.id} -> HTTP ${res.status}`);
    }
    console.log(`\nLOYALTY_API_URL is now ${loyaltyUrl}`);
    break;
  }

  case 'redeploy': {
    const list = await deployments();
    // Matched by connector key, never by position: this project also holds the sample connectors'
    // deployments, and redeploying one of those would be someone else's outage.
    const mine = (list.results ?? []).filter((dep) => dep.connector?.key === CONNECTOR_KEY);
    if (mine.length === 0) {
      console.error(`no deployment of ${CONNECTOR_KEY} exists yet; create one with \`just deploy <tunnel-url>\``);
      process.exit(1);
    }
    if (mine.length > 1) {
      // Picking one by position would be a coin flip, and the wrong side restarts whichever
      // deployment the checkout is actually wired to.
      console.error(`${mine.length} deployments of ${CONNECTOR_KEY} exist; delete the stale one first:`);
      for (const dep of mine) {
        console.error(`   ${dep.id}  ${dep.status}  connectorVersion=${dep.connector?.version}`);
      }
      process.exit(1);
    }
    const target = mine[0];
    // redeploy is the only update action a deployment accepts: config edits ride along with it.
    await call('POST', `/${env.CTP_PROJECT_KEY}/deployments/${target.id}`, {
      version: target.version,
      actions: [{ action: 'redeploy' }],
    });
    console.log(`redeploy requested for ${target.id}; watch it with \`just connector-status\``);
    break;
  }

  default:
    console.error('commands: status | set-tag <tag> | preview | publish | deploy <url> | retunnel <url> | redeploy');
    process.exit(1);
}

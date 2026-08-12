// Talks to the commercetools Connect API about this connector.
//
// Connect reads the code from a public git tag, never from your disk and never from a branch, so
// every change reaches CT the same way: commit, tag, push, repoint the draft, rebuild. The `release`
// recipe in the justfile chains exactly that; the subcommands here are the individual steps.
//
// Usage: node scripts/ct-connector.mjs <command> [args]
import { readFileSync } from 'node:fs';

const CONNECTOR_KEY = 'pierce-loyalty-giftcard';
const CONNECT_URL = 'https://connect.europe-west1.gcp.commercetools.com';
const ENV_FILE = 'processor/.env';

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
);

const token = await (async () => {
  const res = await fetch(`${env.CTP_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.CTP_CLIENT_ID}:${env.CTP_CLIENT_SECRET}`).toString('base64')}`,
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
  const required = ['CTP_PROJECT_KEY', 'CTP_AUTH_URL', 'CTP_API_URL', 'CTP_SESSION_URL', 'CTP_CLIENT_ID', 'CTP_JWKS_URL', 'CTP_JWT_ISSUER', 'CTP_CLIENT_SECRET', 'LOYALTY_API_KEY'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    console.error(`${ENV_FILE} is missing: ${missing.join(', ')}`);
    process.exit(1);
  }
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
          { key: 'CTP_CLIENT_ID', value: env.CTP_CLIENT_ID },
          { key: 'CTP_JWKS_URL', value: env.CTP_JWKS_URL },
          { key: 'CTP_JWT_ISSUER', value: env.CTP_JWT_ISSUER },
          { key: 'LOYALTY_API_URL', value: loyaltyUrl.replace(/\/$/, '') },
          { key: 'LOYALTY_TIMEOUT_MS', value: env.LOYALTY_TIMEOUT_MS || '5000' },
          { key: 'GIFTCARD_ZERO_CT_COVERAGE', value: env.GIFTCARD_ZERO_CT_COVERAGE || 'false' },
        ],
        securedConfiguration: [
          { key: 'CTP_CLIENT_SECRET', value: env.CTP_CLIENT_SECRET },
          { key: 'LOYALTY_API_KEY', value: env.LOYALTY_API_KEY },
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

const publicUrlOrExit = (url, verb) => {
  if (!url) {
    console.error(`usage: ${verb} <public-loyalty-url>    (the address from \`just funnel-url\`)`);
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
      return current.isPreviewable === true;
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

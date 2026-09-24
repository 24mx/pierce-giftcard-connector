// Drives the locally running processor through a real Checkout session against the sandbox.
// Writes real Cart / Session / Payment objects into the commercetools project.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
);

const PROCESSOR = process.argv[3] ?? 'http://localhost:8081';
const LOYALTY = env.LOYALTY_API_URL;
// The connector sends this header itself; the direct probes below must do the same once the
// backend's LoyaltyApiKeyFilter is active, or they read 401 instead of a balance.
const LOYALTY_HEADERS = env.LOYALTY_API_KEY ? { 'X-Api-Key': env.LOYALTY_API_KEY } : {};
const USER = 'demo@example.com';

const step = (n, t) => console.log(`\n--- ${n}. ${t} ---`);
const show = async (res) => {
  const body = await res.text();
  console.log(`HTTP ${res.status}  ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
const spendable = async (label) => {
  const r = await fetch(`${LOYALTY}/loyalty/redemption/balance?userId=${encodeURIComponent(USER)}&currency=EUR`, {
    headers: LOYALTY_HEADERS,
  });
  if (!r.ok) {
    console.log(`   loyalty spendable ${label}: unavailable (HTTP ${r.status})`);
    return null;
  }
  const b = await r.json();
  console.log(`   loyalty spendable ${label}: ${b.points}`);
  return b.points;
};

step(1, 'admin token');
const tokenRes = await fetch(`${env.CTP_AUTH_URL}/oauth/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${env.CTP_CLIENT_ID}:${env.CTP_CLIENT_SECRET}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
});
if (!tokenRes.ok) {
  console.error('token failed', tokenRes.status, await tokenRes.text());
  process.exit(1);
}
const token = (await tokenRes.json()).access_token;
console.log('   ok');

step(2, 'create EUR cart for ' + USER);
const cartRes = await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/carts`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currency: 'EUR',
    country: 'DE',
    customerEmail: USER,
    taxMode: 'External',
    customLineItems: [
      {
        name: { en: 'Connector smoke test item' },
        quantity: 1,
        money: { currencyCode: 'EUR', centAmount: 4999 },
        slug: 'connector-smoke-test-item',
        externalTaxRate: { name: 'DE 19%', amount: 0.19, country: 'DE', includedInPrice: true },
      },
    ],
  }),
});
const cart = await show(cartRes);
if (!cart?.id) process.exit(1);
console.log(`   cart ${cart.id}  total ${cart.totalPrice.centAmount} ${cart.totalPrice.currencyCode}`);

step(3, 'create Checkout session');
const sessionRes = await fetch(`${env.CTP_SESSION_URL}/${env.CTP_PROJECT_KEY}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cart: { cartRef: { id: cart.id } },
    metadata: { processorUrl: PROCESSOR },
  }),
});
const session = await show(sessionRes);
if (!session?.id) process.exit(1);

const sessionHeaders = { 'Content-Type': 'application/json', 'X-Session-Id': session.id };

await spendable('before');

step(4, 'POST /balance through the connector');
await show(
  await fetch(`${PROCESSOR}/balance`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ code: 'ignored-by-design' }),
  }),
);

step(5, 'POST /redeem 2400 through the connector');
const redeem = await show(
  await fetch(`${PROCESSOR}/redeem`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ code: 'ignored-by-design', redeemAmount: { centAmount: 2400, currencyCode: 'EUR' } }),
  }),
);
await spendable('after redeem');

if (redeem?.redemptionId) {
  step(6, 'inspect the redemption written onto the cart');
  const cartAfter = await (
    await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/carts/${cart.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  console.log(`   custom fields=${JSON.stringify(cartAfter.custom?.fields)}`);
  console.log(`   totalPrice=${cartAfter.totalPrice?.centAmount} ${cartAfter.totalPrice?.currencyCode}`);
  console.log(
    `   discountOnTotalPrice=${JSON.stringify(cartAfter.discountOnTotalPrice?.includedDiscounts?.map((d) => `${d.discount.id}: ${d.discountedAmount.centAmount}`))}`,
  );
  console.log(`   appliedAmount reported by the connector=${redeem.appliedAmount?.centAmount}`);

  step(7, 'POST /release (customer removes the points)');
  await show(
    await fetch(`${PROCESSOR}/release`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ redemptionId: redeem.redemptionId }),
    }),
  );
  await spendable('after release');

  const cartFinal = await (
    await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/carts/${cart.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  console.log(
    `   custom fields=${JSON.stringify(cartFinal.custom?.fields)} totalPrice=${cartFinal.totalPrice?.centAmount}`,
  );
}

step(8, 'insufficient points: redeem more than spendable');
await show(
  await fetch(`${PROCESSOR}/redeem`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ code: 'ignored-by-design', redeemAmount: { centAmount: 999999, currencyCode: 'EUR' } }),
  }),
);

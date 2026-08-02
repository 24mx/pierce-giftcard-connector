// Drives the purchase path the cancel-flow harness never reaches: redeem, turn the cart into a
// real Order, then deliver the order signal that a Kafka consumer will deliver in production.
//
// The proof that points were actually spent is the ledger, not the spendable balance: a hold and a
// capture both lower spendable by the same amount, but only a capture writes a ledger row.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
);

const PROCESSOR = process.argv[3] ?? 'http://localhost:8081';
const LOYALTY = env.LOYALTY_API_URL;
const LOYALTY_HEADERS = env.LOYALTY_API_KEY ? { 'X-Api-Key': env.LOYALTY_API_KEY } : {};
const USER = 'demo@example.com';
const REDEEM = 2400;

const step = (n, t) => console.log(`\n--- ${n}. ${t} ---`);
const show = async (res) => {
  const body = await res.text();
  console.log(`HTTP ${res.status}  ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
const spendable = async (label) => {
  const r = await fetch(`${LOYALTY}/loyalty/giftcard/balance?userId=${encodeURIComponent(USER)}&currency=EUR`, {
    headers: LOYALTY_HEADERS,
  });
  if (!r.ok) {
    console.log(`   spendable ${label}: unavailable (HTTP ${r.status})`);
    return null;
  }
  const b = await r.json();
  console.log(`   spendable ${label}: ${b.points}`);
  return b.points;
};
const ledgerRows = async (label) => {
  const r = await fetch(`${LOYALTY}/loyalty/demo/ledger/${encodeURIComponent(USER)}`, { headers: LOYALTY_HEADERS });
  if (!r.ok) {
    console.log(`   ledger ${label}: unavailable (HTTP ${r.status})`);
    return null;
  }
  const rows = await r.json();
  const list = Array.isArray(rows) ? rows : (rows.entries ?? rows.transactions ?? []);
  console.log(`   ledger ${label}: ${list.length} row(s)`);
  return list;
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
const ctHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
console.log('   ok');

step(2, 'create EUR cart for ' + USER);
// A shipping address is what an order needs and a cancel-only flow never has to provide.
const cart = await show(
  await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/carts`, {
    method: 'POST',
    headers: ctHeaders,
    body: JSON.stringify({
      currency: 'EUR',
      country: 'DE',
      customerEmail: USER,
      taxMode: 'External',
      shippingAddress: { country: 'DE', firstName: 'Order', lastName: 'Signal', streetName: 'Demo Street', streetNumber: '1', postalCode: '10115', city: 'Berlin' },
      customLineItems: [
        {
          name: { en: 'Order signal smoke test item' },
          quantity: 1,
          money: { currencyCode: 'EUR', centAmount: 4999 },
          slug: 'order-signal-smoke-test-item',
          externalTaxRate: { name: 'DE 19%', amount: 0.19, country: 'DE', includedInPrice: true },
        },
      ],
    }),
  }),
);
if (!cart?.id) process.exit(1);

step(3, 'create Checkout session');
const session = await show(
  await fetch(`${env.CTP_SESSION_URL}/${env.CTP_PROJECT_KEY}/sessions`, {
    method: 'POST',
    headers: ctHeaders,
    body: JSON.stringify({ cart: { cartRef: { id: cart.id } }, metadata: { processorUrl: PROCESSOR } }),
  }),
);
if (!session?.id) process.exit(1);

let before = await spendable('before');
if (before !== null && before < REDEEM) {
  step('3b', `top up: ${before} points is not enough to redeem ${REDEEM}`);
  await show(
    await fetch(`${LOYALTY}/loyalty/demo/points`, {
      method: 'POST',
      headers: { ...LOYALTY_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, points: REDEEM * 2, reason: 'order signal smoke test' }),
    }),
  );
  before = await spendable('after top up');
}
const ledgerBefore = await ledgerRows('before');

step(4, `POST /redeem ${REDEEM} through the connector`);
const redeem = await show(
  await fetch(`${PROCESSOR}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': session.id },
    body: JSON.stringify({ code: 'ignored-by-design', redeemAmount: { centAmount: REDEEM, currencyCode: 'EUR' } }),
  }),
);
if (!redeem?.paymentReference) {
  console.error('redeem produced no payment; nothing to settle');
  process.exit(1);
}
const heldSpendable = await spendable('after redeem (held, not yet spent)');
const ledgerHeld = await ledgerRows('after redeem');

step(5, 'turn the cart into a real Order');
const cartNow = await (await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/carts/${cart.id}`, { headers: ctHeaders })).json();
const order = await show(
  await fetch(`${env.CTP_API_URL}/${env.CTP_PROJECT_KEY}/orders`, {
    method: 'POST',
    headers: ctHeaders,
    body: JSON.stringify({ cart: { id: cart.id, typeId: 'cart' }, version: cartNow.version }),
  }),
);
if (!order?.id) process.exit(1);
console.log(`   order ${order.id}  payments=${JSON.stringify(order.paymentInfo?.payments?.map((p) => p.id))}`);

step(6, 'deliver the order signal (Kafka stands in here)');
const signal = await show(
  await fetch(`${LOYALTY}/loyalty/giftcard/order-signal`, {
    method: 'POST',
    headers: { ...LOYALTY_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.id }),
  }),
);
const afterCapture = await spendable('after capture');
const ledgerAfter = await ledgerRows('after capture');

step(7, 'replay the same signal (a consumer redelivers)');
await show(
  await fetch(`${LOYALTY}/loyalty/giftcard/order-signal`, {
    method: 'POST',
    headers: { ...LOYALTY_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.id }),
  }),
);
const afterReplay = await spendable('after replay');
const ledgerReplay = await ledgerRows('after replay');

step(8, 'a signal naming an order this project never had');
const unknown = await show(
  await fetch(`${LOYALTY}/loyalty/giftcard/order-signal`, {
    method: 'POST',
    headers: { ...LOYALTY_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'not-an-order-id' }),
  }),
);

step(9, 'verdict');
const checks = [
  ['redeem lowered spendable by ' + REDEEM, before !== null && heldSpendable === before - REDEEM],
  ['hold alone wrote no ledger row', ledgerBefore !== null && ledgerHeld?.length === ledgerBefore.length],
  ['signal captured exactly one hold', signal?.captured === 1],
  ['capture wrote a ledger row', ledgerAfter && ledgerHeld && ledgerAfter.length === ledgerHeld.length + 1],
  ['spendable stayed down after capture', afterCapture === heldSpendable],
  ['replay spent nothing more', afterReplay === afterCapture && ledgerReplay?.length === ledgerAfter?.length],
  // A signal a consumer cannot retry past is worse than a slow one: it blocks the partition.
  ['an unknown order settles nothing instead of failing', unknown?.captured === 0],
];
for (const [label, ok] of checks) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

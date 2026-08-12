export const config = {
  // Required by Payment SDK
  projectKey: process.env.CTP_PROJECT_KEY || 'projectKey',
  clientId: process.env.CTP_CLIENT_ID || 'xxx',
  clientSecret: process.env.CTP_CLIENT_SECRET || 'xxx',
  jwksUrl: process.env.CTP_JWKS_URL || 'https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json',
  jwtIssuer: process.env.CTP_JWT_ISSUER || 'https://mc-api.europe-west1.gcp.commercetools.com',
  authUrl: process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com',
  apiUrl: process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com',
  sessionUrl: process.env.CTP_SESSION_URL || 'https://session.europe-west1.gcp.commercetools.com/',
  checkoutUrl: process.env.CTP_CHECKOUT_URL || 'https://checkout.europe-west1.gcp.commercetools.com',
  healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000'),

  // Connect deploys the processor on 8080; override it locally when something else holds that port
  port: parseInt(process.env.PORT || '8080'),

  // Pierce loyalty backend, the owner of the points ledger
  loyaltyApiUrl: process.env.LOYALTY_API_URL || '',
  loyaltyTimeoutMs: parseInt(process.env.LOYALTY_TIMEOUT_MS || '5000'),
  // Shared secret for /loyalty/**. Empty means the backend is unsecured - fine on a laptop only.
  loyaltyApiKey: process.env.LOYALTY_API_KEY || '',

  // TEMPORARY workaround, see redeem() in mock-giftcard.service.ts: zeroes the CT-side amount of
  // the redeem Payment so it no longer reduces what commercetools Checkout asks the card connector
  // to cover, working around a VAT cross-check that connector does on its own. The real loyalty
  // hold is unaffected. Drop this flag once that connector prorates its own amount instead.
  giftcardZeroCtCoverage: process.env.GIFTCARD_ZERO_CT_COVERAGE === 'true',

  // Required by logger
  loggerLevel: process.env.LOGGER_LEVEL || 'info',
};

export const getConfig = () => {
  return config;
};

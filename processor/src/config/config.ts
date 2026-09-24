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

  // The redemption's projection onto the commercetools cart. The loyalty backend reads the same field
  // names off the order (loyalty.redemption.commercetools.* in pierce-loyalty), so the two deployments
  // must agree on them. The Type is created by the post-deploy hook; point LOYALTY_CART_TYPE_KEY at the
  // storefront's own cart type instead if carts already carry one, and the hook extends that type.
  loyaltyCartTypeKey: process.env.LOYALTY_CART_TYPE_KEY || 'pierce-loyalty-cart',
  loyaltyRedemptionIdField: process.env.LOYALTY_REDEMPTION_ID_FIELD || 'loyaltyRedemptionId',
  loyaltyDenominationsField: process.env.LOYALTY_DENOMINATIONS_FIELD || 'loyaltyRedemption',
  // The automatic CartDiscounts that carry the points: loyalty-D1 … loyalty-D131072, one Money entry
  // per currency listed here, sortOrder below every marketing promotion.
  loyaltyDiscountKeyPrefix: process.env.LOYALTY_DISCOUNT_KEY_PREFIX || 'loyalty-',
  loyaltyDiscountCurrencies: (process.env.LOYALTY_DISCOUNT_CURRENCIES || 'EUR')
    .split(',')
    .map((currency) => currency.trim().toUpperCase())
    .filter((currency) => currency.length === 3),
  loyaltyDiscountSortOrderBase: process.env.LOYALTY_DISCOUNT_SORT_ORDER_BASE || '0.000001',

  // Required by logger
  loggerLevel: process.env.LOGGER_LEVEL || 'info',
};

export const getConfig = () => {
  return config;
};

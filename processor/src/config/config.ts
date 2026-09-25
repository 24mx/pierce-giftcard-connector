export type LoyaltyDiscountStore = { storeKey: string; currency: string; levels: number };

const parseLoyaltyDiscountStores = (raw: string): LoyaltyDiscountStore[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [storeKey, currency, levels] = entry.split(':');
      return { storeKey: storeKey.trim(), currency: currency.trim().toUpperCase(), levels: parseInt(levels, 10) };
    });

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
  // The automatic CartDiscounts that carry the points: loyalty-<storeKey>-D1 … loyalty-<storeKey>-D2^(levels-1),
  // scoped to that Store so each set lives inside the Store's own 100-active-automatic-discount budget
  // instead of the project-wide one (SUPPORT-41640 confirms the cap is project-wide + 100 per Store).
  // Format: "storeKey:currency:levels" comma-separated. `levels` is how many binary denominations that
  // currency needs to reach the same real EUR-equivalent ceiling as EUR's 18 (a weaker currency against
  // EUR needs more levels — see denominations.ts). Recompute `levels` if the currency's FX rate moves
  // enough to matter; this is a provisioning-time constant, not something read live.
  loyaltyDiscountKeyPrefix: process.env.LOYALTY_DISCOUNT_KEY_PREFIX || 'loyalty-',
  loyaltyDiscountStores: parseLoyaltyDiscountStores(
    process.env.LOYALTY_DISCOUNT_STORES || 'lu:EUR:18,ro:RON:21,se:SEK:22',
  ),
  get loyaltyDiscountLevelsByCurrency(): Record<string, number> {
    return this.loyaltyDiscountStores.reduce<Record<string, number>>(
      (levels, store) => ({ ...levels, [store.currency]: Math.max(levels[store.currency] ?? 0, store.levels) }),
      {},
    );
  },
  loyaltyDiscountSortOrderBase: process.env.LOYALTY_DISCOUNT_SORT_ORDER_BASE || '0.000001',

  // Required by logger
  loggerLevel: process.env.LOGGER_LEVEL || 'info',
};

export const getConfig = () => {
  return config;
};

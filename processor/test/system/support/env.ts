import { describe } from '@jest/globals';

export type SystemEnv = {
  processorUrl: string;
  loyaltyApiUrl: string;
  loyaltyApiKey: string;
  ctp: {
    projectKey: string;
    clientId: string;
    clientSecret: string;
    authUrl: string;
    apiUrl: string;
    sessionUrl: string;
  };
  sku: string;
  country: string;
  currency: string;
  storefrontCartTypeKey: string;
  checkoutApplicationKey: string | undefined;
  loyaltyStores: { storeKey: string; currency: string; country: string }[];
};

const stripSlash = (url: string) => url.replace(/\/+$/, '');

/** Null when the suite is off (no SYSTEM_PROCESSOR_URL); throws naming the first missing variable otherwise. */
export const systemEnv = (): SystemEnv | null => {
  const processorUrl = process.env.SYSTEM_PROCESSOR_URL;
  if (!processorUrl) {
    return null;
  }
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is required when SYSTEM_PROCESSOR_URL is set`);
    }
    return value;
  };
  return {
    processorUrl: stripSlash(processorUrl),
    loyaltyApiUrl: stripSlash(need('SYSTEM_LOYALTY_API_URL')),
    loyaltyApiKey: need('SYSTEM_LOYALTY_API_KEY'),
    ctp: {
      projectKey: need('SYSTEM_CTP_PROJECT_KEY'),
      clientId: need('SYSTEM_CTP_CLIENT_ID'),
      clientSecret: need('SYSTEM_CTP_CLIENT_SECRET'),
      authUrl: process.env.SYSTEM_CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com',
      apiUrl: process.env.SYSTEM_CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com',
      sessionUrl: stripSlash(
        process.env.SYSTEM_CTP_SESSION_URL || 'https://session.europe-west1.gcp.commercetools.com',
      ),
    },
    sku: need('SYSTEM_SKU'),
    country: process.env.SYSTEM_COUNTRY || 'DE',
    currency: process.env.SYSTEM_CURRENCY || 'EUR',
    storefrontCartTypeKey:
      process.env.SYSTEM_STOREFRONT_CART_TYPE_KEY || process.env.LOYALTY_CART_TYPE_KEY || 'pierce-loyalty-cart',
    checkoutApplicationKey: process.env.SYSTEM_CHECKOUT_APPLICATION_KEY,
    loyaltyStores: (process.env.SYSTEM_LOYALTY_STORES || 'lu:EUR:LU,ro:RON:RO,se:SEK:SE')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [storeKey, currency, country] = entry.split(':');
        return { storeKey, currency, country };
      }),
  };
};

/** `describe` when the suite is configured, `describe.skip` otherwise — so `npm test` never dials out. */
export const describeSystem = systemEnv() ? describe : describe.skip;

export const testEmail = (): string => `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

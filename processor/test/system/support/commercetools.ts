import { Cart, createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { ClientBuilder } from '@commercetools/ts-client';
import { SystemEnv } from './env';

type CreateCartOptions = {
  email: string;
  /** Give the cart the storefront's custom type up front, so the processor takes the setCustomField path. */
  withStorefrontType?: boolean;
};

export const commercetools = (env: SystemEnv) => {
  const { projectKey, clientId, clientSecret, authUrl, apiUrl, sessionUrl } = env.ctp;
  const client = new ClientBuilder()
    .withClientCredentialsFlow({ host: authUrl, projectKey, credentials: { clientId, clientSecret } })
    .withHttpMiddleware({ host: apiUrl })
    .build();
  const api = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey });

  const token = async (): Promise<string> => {
    const response = await fetch(`${authUrl}/oauth/token?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    });
    if (!response.ok) {
      throw new Error(`token request failed: ${response.status} ${await response.text()}`);
    }
    return ((await response.json()) as { access_token: string }).access_token;
  };

  const getCart = async (id: string): Promise<Cart> => (await api.carts().withId({ ID: id }).get().execute()).body;

  return {
    async createCart({ email, withStorefrontType = false }: CreateCartOptions): Promise<Cart> {
      const response = await api
        .carts()
        .post({
          body: {
            currency: env.currency,
            country: env.country,
            customerEmail: email,
            lineItems: [{ sku: env.sku, quantity: 1 }],
            shippingAddress: { country: env.country },
            ...(withStorefrontType && {
              custom: { type: { typeId: 'type', key: env.storefrontCartTypeKey }, fields: {} },
            }),
          },
        })
        .execute();
      return response.body;
    },

    getCart,

    /** Best effort: a cart that is already gone (404) is the outcome wanted, not an error. */
    async deleteCart(cart: Cart): Promise<void> {
      try {
        const fresh = await getCart(cart.id);
        await api
          .carts()
          .withId({ ID: fresh.id })
          .delete({ queryArgs: { version: fresh.version } })
          .execute();
      } catch (e) {
        if (!isNotFound(e)) {
          throw e;
        }
      }
    },

    /** A Checkout session for the cart — what the storefront puts in X-Session-Id. */
    async createSession(cartId: string): Promise<string> {
      const response = await fetch(`${sessionUrl}/${projectKey}/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cart: { cartRef: { id: cartId } },
          ...(env.checkoutApplicationKey && { metadata: { applicationKey: env.checkoutApplicationKey } }),
        }),
      });
      if (!response.ok) {
        throw new Error(`session creation failed: ${response.status} ${await response.text()}`);
      }
      return ((await response.json()) as { id: string }).id;
    },

    /** Flips one denomination discount; the DiscountNotApplied scenario turns `loyalty-D1` off and back on. */
    async setDiscountActive(key: string, active: boolean): Promise<void> {
      const current = (await api.cartDiscounts().withKey({ key }).get().execute()).body;
      if (current.isActive === active) {
        return;
      }
      await api
        .cartDiscounts()
        .withKey({ key })
        .post({ body: { version: current.version, actions: [{ action: 'changeIsActive', isActive: active }] } })
        .execute();
    },
  };
};

const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'statusCode' in e && (e as { statusCode: unknown }).statusCode === 404;

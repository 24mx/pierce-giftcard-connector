import { Cart, CartDiscountDraft, createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { ClientBuilder } from '@commercetools/ts-client';
import { SystemEnv } from './env';

type CreateCartOptions = {
  email: string;
  /** Give the cart the storefront's custom type up front, so the processor takes the setCustomField path. */
  withStorefrontType?: boolean;
  /** Creates the cart in this Store (`/in-store/key=...`) instead of at the project level. */
  storeKey?: string;
  /** Overrides `env.currency` - required together with `storeKey` when the store's market differs. */
  currency?: string;
  /** Overrides `env.country` - required together with `storeKey` when the store's market differs. */
  country?: string;
  /** Units of `env.sku` on the cart; more than one leaves room for a voucher and points side by side. */
  quantity?: number;
};

/**
 * A code-gated CartDiscount plus the one DiscountCode that unlocks it - how marketing vouchers and gift
 * cards exist in production. `ensureVoucher` creates both when missing and re-activates the discount.
 */
export type VoucherFixture = {
  code: string;
  discount: Omit<CartDiscountDraft, 'requiresDiscountCode' | 'isActive'>;
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

  /**
   * The processor names the points owner by the cart's customer ACCOUNT and refuses a guest cart
   * (CustomerNotIdentified), so every test cart belongs to a fresh customer with the test email.
   */
  const createCustomer = async (email: string): Promise<string> =>
    (
      await api
        .customers()
        .post({ body: { email, password: `System-${Math.random().toString(36).slice(2)}-1` } })
        .execute()
    ).body.customer.id;

  const deleteCustomer = async (id: string): Promise<void> => {
    try {
      const { version } = (await api.customers().withId({ ID: id }).get().execute()).body;
      await api.customers().withId({ ID: id }).delete({ queryArgs: { version } }).execute();
    } catch (e) {
      if (!isNotFound(e)) {
        throw e;
      }
    }
  };

  const updateCart = async (id: string, actions: object[]): Promise<Cart> => {
    const fresh = await getCart(id);
    const response = await fetch(`${apiUrl}/${projectKey}/carts/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: fresh.version, actions }),
    });
    if (!response.ok) {
      throw new Error(`cart update failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Cart;
  };

  return {
    async createCart({
      email,
      withStorefrontType = false,
      storeKey,
      currency = env.currency,
      country = env.country,
      quantity = 1,
    }: CreateCartOptions): Promise<Cart> {
      const customerId = await createCustomer(email);
      const path = storeKey
        ? `${apiUrl}/${projectKey}/in-store/key=${storeKey}/carts`
        : `${apiUrl}/${projectKey}/carts`;
      const response = await fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currency,
          country,
          customerEmail: email,
          customerId,
          lineItems: [{ sku: env.sku, quantity }],
          shippingAddress: { country },
          ...(withStorefrontType && {
            custom: { type: { typeId: 'type', key: env.storefrontCartTypeKey }, fields: {} },
          }),
        }),
      });
      if (!response.ok) {
        await deleteCustomer(customerId);
        throw new Error(`cart creation failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as Cart;
    },

    getCart,

    /**
     * Best effort: a cart that is already gone (404) is the outcome wanted, not an error. Takes the
     * cart's customer with it, since createCart made one for this cart alone.
     */
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
      if (cart.customerId) {
        await deleteCustomer(cart.customerId);
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

    /**
     * Creates the voucher's CartDiscount and DiscountCode when the project lacks them, and switches the
     * discount back on when someone left it off. An existing discount keeps its definition: the fixture
     * keys are owned by this suite, so a drifted one is fixed by deleting it, not silently rewritten.
     */
    async ensureVoucher({ code, discount }: VoucherFixture): Promise<void> {
      const existing = await api
        .cartDiscounts()
        .get({ queryArgs: { where: `key="${discount.key}"` } })
        .execute();
      let discountId: string;
      if (existing.body.results.length === 0) {
        discountId = (
          await api
            .cartDiscounts()
            .post({ body: { ...discount, requiresDiscountCode: true, isActive: true } })
            .execute()
        ).body.id;
      } else {
        const current = existing.body.results[0];
        discountId = current.id;
        if (!current.isActive) {
          await api
            .cartDiscounts()
            .withId({ ID: current.id })
            .post({ body: { version: current.version, actions: [{ action: 'changeIsActive', isActive: true }] } })
            .execute();
        }
      }
      const codes = await api
        .discountCodes()
        .get({ queryArgs: { where: `code="${code}"` } })
        .execute();
      if (codes.body.results.length === 0) {
        await api
          .discountCodes()
          .post({ body: { code, cartDiscounts: [{ typeId: 'cart-discount', id: discountId }], isActive: true } })
          .execute();
      }
    },

    addDiscountCode: (cartId: string, code: string): Promise<Cart> =>
      updateCart(cartId, [{ action: 'addDiscountCode', code }]),

    async removeDiscountCode(cartId: string, code: string): Promise<Cart> {
      const found = await api
        .discountCodes()
        .get({ queryArgs: { where: `code="${code}"` } })
        .execute();
      const id = found.body.results[0]?.id;
      if (!id) {
        throw new Error(`no discount code ${code}`);
      }
      return updateCart(cartId, [{ action: 'removeDiscountCode', discountCode: { typeId: 'discount-code', id } }]);
    },

    /**
     * How much of the cart's total-price discount each CartDiscount key contributed, in minor units.
     * Line-item vouchers do not show up here (they reduce the line prices instead); the points do.
     */
    async totalPricePortionsByKey(cart: Cart): Promise<Record<string, number>> {
      const portions: Record<string, number> = {};
      for (const included of cart.discountOnTotalPrice?.includedDiscounts ?? []) {
        const key = (await api.cartDiscounts().withId({ ID: included.discount.id }).get().execute()).body.key ?? '';
        portions[key] = (portions[key] ?? 0) + included.discountedAmount.centAmount;
      }
      return portions;
    },
  };
};

const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'statusCode' in e && (e as { statusCode: unknown }).statusCode === 404;

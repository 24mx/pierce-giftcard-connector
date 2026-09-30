import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';

/**
 * Who owns a cart's loyalty points. The answer is the customer ACCOUNT behind the cart, never the
 * email written on the cart: a checkout session proves the caller owns the cart, and a guest can type
 * any address into it, so trusting `cart.customerEmail` would let anyone spend anyone's points.
 */
export interface CustomerEmailClient {
  /** The account email of `customerId`, or null when no such customer exists. */
  emailOf(customerId: string): Promise<string | null>;
}

export class CommercetoolsCustomerEmailClient implements CustomerEmailClient {
  constructor(private readonly client: ByProjectKeyRequestBuilder) {}

  public async emailOf(customerId: string): Promise<string | null> {
    try {
      const response = await this.client.customers().withId({ ID: customerId }).get().execute();
      return response.body.email;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        return null;
      }
      throw e;
    }
  }
}

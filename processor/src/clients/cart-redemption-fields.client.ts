import { Cart, CartUpdateAction } from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';

export type CartRedemptionFields = {
  redemptionId: string | null;
  denominations: string[];
};

export type CartRedemptionFieldsWrite = {
  redemptionId: string;
  denominations: string[];
};

/**
 * `baseline` is the cart the update was really applied to - the caller's snapshot, or the fresh cart a
 * version-conflict retry re-read - so a price drop is measured against the right starting point.
 */
export type CartRedemptionWriteResult = {
  baseline: Cart;
  updated: Cart;
};

/**
 * The redemption's projection onto the cart: two custom fields, which commercetools copies onto the
 * order and whose denominations unlock the automatic loyalty CartDiscounts. Nothing else about the
 * redemption lives in commercetools.
 */
export interface CartRedemptionFieldsClient {
  read(cart: Cart): CartRedemptionFields;
  write(cart: Cart, fields: CartRedemptionFieldsWrite): Promise<CartRedemptionWriteResult>;
  /** Clears the fields only while the cart still carries `expectedRedemptionId`; otherwise leaves it alone. */
  clear(cart: Cart, expectedRedemptionId: string): Promise<Cart>;
}

export type CartRedemptionFieldsOptions = {
  typeKey: string;
  redemptionIdField: string;
  denominationsField: string;
};

export class CommercetoolsCartRedemptionFieldsClient implements CartRedemptionFieldsClient {
  constructor(
    private readonly client: ByProjectKeyRequestBuilder,
    private readonly opts: CartRedemptionFieldsOptions,
  ) {}

  public read(cart: Cart): CartRedemptionFields {
    const fields = cart.custom?.fields ?? {};
    const redemptionId = fields[this.opts.redemptionIdField];
    const denominations = fields[this.opts.denominationsField];
    return {
      redemptionId: typeof redemptionId === 'string' && redemptionId.length > 0 ? redemptionId : null,
      denominations: Array.isArray(denominations)
        ? denominations.filter((d): d is string => typeof d === 'string')
        : [],
    };
  }

  /**
   * A cart with no custom type takes ours in one action; a cart that already has one keeps it and only
   * gets the two fields set. If that type does not define them commercetools answers 400, which is the
   * right outcome for a misconfigured project: the storefront's cart type must then be extended with
   * these fields (the post-deploy hook does that when it is told the key).
   */
  public async write(cart: Cart, fields: CartRedemptionFieldsWrite): Promise<CartRedemptionWriteResult> {
    return this.update(cart, (current) => this.writeActions(current, fields));
  }

  /**
   * Stands down whenever the cart does not carry the expected id - including on a version-conflict
   * retry, where another tab may just have written a NEW redemption whose hold must keep its discount.
   */
  public async clear(cart: Cart, expectedRedemptionId: string): Promise<Cart> {
    if (!cart.custom || this.read(cart).redemptionId !== expectedRedemptionId) {
      return cart;
    }
    const result = await this.update(cart, (current) =>
      this.read(current).redemptionId === expectedRedemptionId
        ? [
            { action: 'setCustomField', name: this.opts.redemptionIdField },
            { action: 'setCustomField', name: this.opts.denominationsField },
          ]
        : [],
    );
    return result.updated;
  }

  private writeActions(cart: Cart, fields: CartRedemptionFieldsWrite): CartUpdateAction[] {
    const values = {
      [this.opts.redemptionIdField]: fields.redemptionId,
      [this.opts.denominationsField]: fields.denominations,
    };
    if (!cart.custom) {
      return [{ action: 'setCustomType', type: { typeId: 'type', key: this.opts.typeKey }, fields: values }];
    }
    return [
      { action: 'setCustomField', name: this.opts.redemptionIdField, value: fields.redemptionId },
      { action: 'setCustomField', name: this.opts.denominationsField, value: fields.denominations },
    ];
  }

  /**
   * One retry on a version conflict: the storefront may have touched the cart between our read and
   * write. An empty action list means the fresh cart no longer needs the update, and it is returned as is.
   */
  private async update(cart: Cart, actions: (current: Cart) => CartUpdateAction[]): Promise<CartRedemptionWriteResult> {
    try {
      return { baseline: cart, updated: await this.post(cart, actions(cart)) };
    } catch (e) {
      if (!isVersionConflict(e)) {
        throw e;
      }
      const fresh = (await this.client.carts().withId({ ID: cart.id }).get().execute()).body;
      const retried = actions(fresh);
      if (retried.length === 0) {
        return { baseline: fresh, updated: fresh };
      }
      return { baseline: fresh, updated: await this.post(fresh, retried) };
    }
  }

  private async post(cart: Cart, actions: CartUpdateAction[]): Promise<Cart> {
    const response = await this.client
      .carts()
      .withId({ ID: cart.id })
      .post({ body: { version: cart.version, actions } })
      .execute();
    return response.body;
  }
}

const isVersionConflict = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'statusCode' in e && (e as { statusCode: unknown }).statusCode === 409;

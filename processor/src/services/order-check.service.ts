import { readSyncRecord } from '../clients/cart-redemption-fields.client';
import { sumDenominations } from './denominations';
import { OrderCheckVerdict, orderCheckVerdict } from './points-sync-record';

export type OrderCheckFields = {
  briqpayHashField: string;
  syncHashField: string;
  syncPointsField: string;
  denominationsField: string;
};

/** The part of the order an Order-create API Extension receives that the check needs. */
export type OrderCheckInput = {
  id?: string;
  cart?: { id: string };
  custom?: { fields: Record<string, unknown> };
};

type Logger = {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
};

/** Custom fields of a cart, or null when it no longer exists. */
export type CartFieldsReader = (cartId: string) => Promise<Record<string, unknown> | null>;

/**
 * Judges an order at creation: refuse when the shopper paid an amount that does not include the points
 * on the order, i.e. Briqpay last saw this cart with a different points amount (see points-sync-record).
 * commercetools copies the cart's custom fields onto the order; if the order arrives without them, the
 * cart is read instead.
 *
 * A fault while judging passes the order: a refusal cancels the shopper's payment, so only a positive
 * finding may cause one. The payment check (Flow 5 in the loyalty backend) still covers what passes here.
 */
export class OrderCheckService {
  constructor(
    private readonly readCartFields: CartFieldsReader,
    private readonly opts: OrderCheckFields,
    private readonly logger: Logger,
  ) {}

  public async check(order: OrderCheckInput): Promise<OrderCheckVerdict> {
    try {
      return await this.judge(order);
    } catch (e) {
      this.logger.error(
        { orderId: order.id, cartId: order.cart?.id, error: e instanceof Error ? e.message : String(e) },
        'Order check could not judge the order - letting it through',
      );
      return 'pass';
    }
  }

  private async judge(order: OrderCheckInput): Promise<OrderCheckVerdict> {
    const fields = order.custom?.fields ?? (order.cart ? await this.readCartFields(order.cart.id) : null) ?? {};
    const record = readSyncRecord(fields, this.opts);
    const hash = fields[this.opts.briqpayHashField];
    const denominations = fields[this.opts.denominationsField];
    const orderHash = typeof hash === 'string' && hash.length > 0 ? hash : null;
    const orderPoints = sumDenominations(
      Array.isArray(denominations) ? denominations.filter((d): d is string => typeof d === 'string') : [],
    );
    const verdict = orderCheckVerdict(record, orderHash, orderPoints);
    if (verdict === 'refuse') {
      this.logger.warn(
        { orderId: order.id, cartId: order.cart?.id, record, orderHash, orderPoints },
        'Order check refused an order: points changed after Briqpay last saw the cart',
      );
    }
    return verdict;
  }
}

import { describe, expect, test } from '@jest/globals';
import { OrderCheckService } from '../../src/services/order-check.service';

const FIELDS = {
  briqpayHashField: 'briqpay-synced-payload-hash',
  syncHashField: 'loyaltySyncHash',
  syncPointsField: 'loyaltySyncPoints',
  denominationsField: 'loyaltyRedemption',
};

const silent = { warn: () => undefined, error: () => undefined };

const order = (fields: Record<string, unknown> | undefined) => ({
  id: 'order-1',
  cart: { typeId: 'cart' as const, id: 'cart-1' },
  ...(fields === undefined ? {} : { custom: { type: { typeId: 'type' as const, id: 't' }, fields } }),
});

const noCartRead = async () => {
  throw new Error('the test did not expect a cart read');
};

describe('OrderCheckService', () => {
  test('refuses an order whose points were removed after Briqpay last saw the cart', async () => {
    const service = new OrderCheckService(noCartRead, FIELDS, silent);

    const verdict = await service.check(
      order({ 'briqpay-synced-payload-hash': 'h1', loyaltySyncHash: 'h1', loyaltySyncPoints: 1500 }),
    );

    expect(verdict).toBe('refuse');
  });

  test('passes an order whose points Briqpay saw', async () => {
    const service = new OrderCheckService(noCartRead, FIELDS, silent);

    const verdict = await service.check(
      order({
        'briqpay-synced-payload-hash': 'h1',
        loyaltySyncHash: 'h1',
        loyaltySyncPoints: 1026,
        loyaltyRedemption: ['D1024', 'D2'],
      }),
    );

    expect(verdict).toBe('pass');
  });

  test('passes an order from a cart Briqpay synced after the last points change', async () => {
    const service = new OrderCheckService(noCartRead, FIELDS, silent);

    const verdict = await service.check(
      order({ 'briqpay-synced-payload-hash': 'h2', loyaltySyncHash: 'h1', loyaltySyncPoints: 1500 }),
    );

    expect(verdict).toBe('pass');
  });

  test('reads the cart when the order handed to the extension carries no custom fields', async () => {
    const reads: string[] = [];
    const service = new OrderCheckService(
      async (cartId) => {
        reads.push(cartId);
        return { 'briqpay-synced-payload-hash': 'h1', loyaltySyncHash: 'h1', loyaltySyncPoints: 1500 };
      },
      FIELDS,
      silent,
    );

    const verdict = await service.check(order(undefined));

    expect(reads).toStrictEqual(['cart-1']);
    expect(verdict).toBe('refuse');
  });

  test('passes and reports when the order cannot be judged, so a fault never blocks a sale', async () => {
    const errors: unknown[] = [];
    const service = new OrderCheckService(noCartRead, FIELDS, {
      warn: () => undefined,
      error: (fields: unknown) => errors.push(fields),
    });

    const verdict = await service.check(
      order({
        'briqpay-synced-payload-hash': 'h1',
        loyaltySyncHash: 'h1',
        loyaltySyncPoints: 1500,
        loyaltyRedemption: ['X'],
      }),
    );

    expect(verdict).toBe('pass');
    expect(errors).toHaveLength(1);
  });
});

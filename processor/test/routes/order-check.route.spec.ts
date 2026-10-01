import { describe, expect, test } from '@jest/globals';
import Fastify from 'fastify';
import { orderCheckRoutes } from '../../src/routes/order-check.route';
import { OrderCheckInput, OrderCheckService } from '../../src/services/order-check.service';
import { OrderCheckVerdict } from '../../src/services/points-sync-record';

const AUTH = 'Basic c2VjcmV0';

const build = async (verdict: OrderCheckVerdict) => {
  const checked: OrderCheckInput[] = [];
  const service = {
    check: async (order: OrderCheckInput) => {
      checked.push(order);
      return verdict;
    },
  } as unknown as OrderCheckService;
  const app = Fastify();
  await app.register(orderCheckRoutes, { orderCheckService: service, authHeader: AUTH });
  await app.ready();
  return { app, checked };
};

const orderCreate = { action: 'Create', resource: { typeId: 'order', id: 'order-1', obj: { id: 'order-1' } } };

describe('order-check route', () => {
  test('answers no actions when the order passes', async () => {
    const { app, checked } = await build('pass');

    const response = await app.inject({
      method: 'POST',
      url: '/order-check',
      payload: orderCreate,
      headers: { authorization: AUTH },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ actions: [] });
    expect(checked).toStrictEqual([{ id: 'order-1' }]);
  });

  test('answers a commercetools validation error when the order is refused', async () => {
    const { app } = await build('refuse');

    const response = await app.inject({
      method: 'POST',
      url: '/order-check',
      payload: orderCreate,
      headers: { authorization: AUTH },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ code: 'InvalidOperation' }] });
  });

  test.each([[undefined], ['Basic wrong']])('rejects a call with authorization %s', async (authorization) => {
    const { app, checked } = await build('pass');

    const response = await app.inject({
      method: 'POST',
      url: '/order-check',
      payload: orderCreate,
      headers: authorization === undefined ? {} : { authorization },
    });

    expect(response.statusCode).toBe(401);
    expect(checked).toStrictEqual([]);
  });

  test('lets through anything other than an order being created', async () => {
    const { app, checked } = await build('refuse');

    const response = await app.inject({
      method: 'POST',
      url: '/order-check',
      payload: { action: 'Update', resource: { typeId: 'order', id: 'order-1', obj: { id: 'order-1' } } },
      headers: { authorization: AUTH },
    });

    expect(response.statusCode).toBe(200);
    expect(checked).toStrictEqual([]);
  });
});

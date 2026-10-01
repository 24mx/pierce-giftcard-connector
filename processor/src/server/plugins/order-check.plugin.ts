import { FastifyInstance } from 'fastify';
import { getConfig } from '../../config/config';
import { orderCheckRoutes } from '../../routes/order-check.route';
import { app } from '../app';

export default async function (server: FastifyInstance) {
  await server.register(orderCheckRoutes, {
    orderCheckService: app.services.orderCheckService,
    authHeader: getConfig().orderCheckAuthHeader,
  });
}

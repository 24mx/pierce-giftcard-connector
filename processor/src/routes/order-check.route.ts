import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { OrderCheckInput, OrderCheckService } from '../services/order-check.service';

type RoutesOptions = {
  orderCheckService: OrderCheckService;
  /** The Authorization header value the API Extension is registered with. */
  authHeader: string;
};

type ExtensionInput = {
  action?: string;
  resource?: { typeId?: string; obj?: OrderCheckInput };
};

/**
 * The commercetools API Extension on Order create. commercetools accepts the order on 200 with no
 * actions and refuses it on 400 with errors; the failed order creation then triggers Checkout's
 * automated reversal of the payment.
 */
export const orderCheckRoutes = async (fastify: FastifyInstance, opts: FastifyPluginOptions & RoutesOptions) => {
  fastify.post<{ Body: ExtensionInput }>(
    '/order-check',
    {
      preHandler: async (request, reply) => {
        if (!sameSecret(request.headers.authorization, opts.authHeader)) {
          return reply.status(401).send({ message: 'Unauthorized' });
        }
      },
    },
    async (request, reply) => {
      const { action, resource } = request.body ?? {};
      if (action !== 'Create' || resource?.typeId !== 'order' || !resource.obj) {
        return reply.status(200).send({ actions: [] });
      }
      const verdict = await opts.orderCheckService.check(resource.obj);
      if (verdict === 'refuse') {
        return reply.status(400).send({
          errors: [
            {
              code: 'InvalidOperation',
              message:
                'The loyalty points on this cart changed after the payment was started. Please review your cart and pay again.',
            },
          ],
        });
      }
      return reply.status(200).send({ actions: [] });
    },
  );
};

/** An empty configured secret never matches, so a misconfigured deployment cannot run unauthenticated. */
const sameSecret = (received: string | undefined, expected: string): boolean => {
  if (!received || expected.length === 0) {
    return false;
  }
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

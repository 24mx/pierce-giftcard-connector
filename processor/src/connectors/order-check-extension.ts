import { ExtensionDestination, ExtensionTrigger } from '@commercetools/platform-sdk';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { getOr404 } from './loyalty-provisioning';

export const ORDER_CHECK_EXTENSION_KEY = 'pierce-loyalty-order-check';

export type OrderCheckExtensionOptions = {
  enabled: boolean;
  /** CONNECT_SERVICE_URL of this processor. */
  serviceUrl: string;
  authHeader: string;
  syncPointsField: string;
};

type Logger = { info(message: string): void };

/**
 * Converges the Order-create API Extension onto the configuration: registered (or updated) when the
 * check is enabled, removed when it is not. The trigger fires only for carts that ever had points (the
 * sync record is written with every points change), so an outage of this connector cannot block
 * orders without points.
 */
export async function ensureOrderCheckExtension(
  client: ByProjectKeyRequestBuilder,
  opts: OrderCheckExtensionOptions,
  logger: Logger,
): Promise<void> {
  if (!opts.enabled) {
    await removeOrderCheckExtension(client, logger);
    return;
  }
  if (opts.serviceUrl.length === 0) {
    throw new Error('ORDER_CHECK_ENABLED is true but CONNECT_SERVICE_URL is empty');
  }
  if (opts.authHeader.length === 0) {
    throw new Error('ORDER_CHECK_ENABLED is true but ORDER_CHECK_AUTH_HEADER is empty');
  }
  const destination: ExtensionDestination = {
    type: 'HTTP',
    url: orderCheckUrl(opts.serviceUrl),
    authentication: { type: 'AuthorizationHeader', headerValue: opts.authHeader },
  };
  const triggers: ExtensionTrigger[] = [
    { resourceTypeId: 'order', actions: ['Create'], condition: `custom(fields(${opts.syncPointsField} is defined))` },
  ];
  const existing = await getOr404(() =>
    client.extensions().withKey({ key: ORDER_CHECK_EXTENSION_KEY }).get().execute(),
  );
  if (!existing) {
    await client
      .extensions()
      .post({ body: { key: ORDER_CHECK_EXTENSION_KEY, destination, triggers } })
      .execute();
    logger.info(`Registered API Extension ${ORDER_CHECK_EXTENSION_KEY}`);
    return;
  }
  await client
    .extensions()
    .withKey({ key: ORDER_CHECK_EXTENSION_KEY })
    .post({
      body: {
        version: existing.version,
        actions: [
          { action: 'changeDestination', destination },
          { action: 'changeTriggers', triggers },
        ],
      },
    })
    .execute();
  logger.info(`Updated API Extension ${ORDER_CHECK_EXTENSION_KEY}`);
}

/**
 * Removes the extension. With `ownServiceUrl` (an undeploying deployment) only while it still points at
 * that deployment: a redeploy registers the new deployment first and undeploys the old one after, so
 * the old one must not take the new one's extension with it.
 */
export async function removeOrderCheckExtension(
  client: ByProjectKeyRequestBuilder,
  logger: Logger,
  ownServiceUrl?: string,
): Promise<void> {
  const existing = await getOr404(() =>
    client.extensions().withKey({ key: ORDER_CHECK_EXTENSION_KEY }).get().execute(),
  );
  if (!existing) {
    return;
  }
  if (ownServiceUrl !== undefined && destinationUrl(existing.destination) !== orderCheckUrl(ownServiceUrl)) {
    logger.info(`API Extension ${ORDER_CHECK_EXTENSION_KEY} belongs to another deployment - left in place`);
    return;
  }
  await client
    .extensions()
    .withKey({ key: ORDER_CHECK_EXTENSION_KEY })
    .delete({ queryArgs: { version: existing.version } })
    .execute();
  logger.info(`Removed API Extension ${ORDER_CHECK_EXTENSION_KEY}`);
}

const orderCheckUrl = (serviceUrl: string): string => `${serviceUrl.replace(/\/+$/, '')}/order-check`;

const destinationUrl = (destination: ExtensionDestination): string | undefined =>
  destination.type === 'HTTP' ? destination.url : undefined;

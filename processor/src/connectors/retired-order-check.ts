import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';

/** Key of the Order-create API Extension that v0.12.x registered. */
export const RETIRED_ORDER_CHECK_EXTENSION_KEY = 'pierce-loyalty-order-check';

type Logger = { info(message: string): void };

/**
 * Deletes the order-check API Extension an earlier version may have left in the project. The check was
 * withdrawn because commercetools Checkout does not reverse the payment of an order an extension refuses.
 * Left registered, the extension would point at a deployment that no longer exists and fail every order
 * from a cart that ever had points.
 */
export async function removeRetiredOrderCheck(client: ByProjectKeyRequestBuilder, logger: Logger): Promise<void> {
  const extension = client.extensions().withKey({ key: RETIRED_ORDER_CHECK_EXTENSION_KEY });
  let version: number;
  try {
    version = (await extension.get().execute()).body.version;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) {
      return;
    }
    throw error;
  }
  await extension.delete({ queryArgs: { version } }).execute();
  logger.info(`Removed the retired API Extension ${RETIRED_ORDER_CHECK_EXTENSION_KEY}`);
}

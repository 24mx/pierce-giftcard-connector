import { paymentSDK } from '../payment-sdk';
import { removeOrderCheckExtension } from './order-check-extension';

/**
 * Removes the order-check API Extension: left behind, commercetools would keep calling a processor that
 * no longer exists and every order with points would fail. The cart Type and the denomination
 * CartDiscounts stay - orders already reference them, and a redeploy converges onto the same objects.
 */
async function preUndeploy() {
  await removeOrderCheckExtension(paymentSDK.ctAPI.client, {
    info: (message: string) => process.stdout.write(`${message}\n`),
  });
}

async function run() {
  try {
    await preUndeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Pre-undeploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}
run();

import { paymentSDK } from '../payment-sdk';
import { cartRedemptionFromConfig } from '../redemption/denomination-cart-redemption';
import { removeRetiredOrderCheck } from './retired-order-check';

/**
 * Connect runs this once per deployment. It sets up what the cart representation of a redemption
 * needs in commercetools (see CartRedemption#provision) and is safe to re-run: existing objects are
 * extended or left alone, never recreated. It also deletes the order-check API Extension of v0.12.x.
 */
async function postDeploy() {
  const logger = { info: (message: string) => process.stdout.write(`${message}\n`) };
  await cartRedemptionFromConfig(paymentSDK.ctAPI.client).provision(logger);
  await removeRetiredOrderCheck(paymentSDK.ctAPI.client, logger);
}

async function runPostDeployScripts() {
  try {
    await postDeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Post-deploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

runPostDeployScripts();

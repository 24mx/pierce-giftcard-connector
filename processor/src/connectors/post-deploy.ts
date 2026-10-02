import { paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { provisionLoyaltyRedemption } from './loyalty-provisioning';
import { removeRetiredOrderCheck } from './retired-order-check';

/**
 * Connect runs this once per deployment. It converges every configured store onto what the
 * redemption needs there - the shared cart Type with the two custom fields, and that store's own
 * scoped set of denomination CartDiscounts - and is safe to re-run: existing objects are extended or
 * left alone, never recreated. It also deletes the order-check API Extension of v0.12.x.
 */
async function postDeploy() {
  const config = getConfig();
  const logger = { info: (message: string) => process.stdout.write(`${message}\n`) };
  await provisionLoyaltyRedemption(
    paymentSDK.ctAPI.client,
    {
      typeKey: config.loyaltyCartTypeKey,
      redemptionIdField: config.loyaltyRedemptionIdField,
      denominationsField: config.loyaltyDenominationsField,
      discountKeyPrefix: config.loyaltyDiscountKeyPrefix,
      stores: config.loyaltyDiscountStores,
      sortOrderBase: config.loyaltyDiscountSortOrderBase,
    },
    logger,
  );
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

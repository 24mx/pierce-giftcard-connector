import { paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { provisionLoyaltyRedemption } from './loyalty-provisioning';
import { ensureOrderCheckExtension } from './order-check-extension';

/**
 * Connect runs this once per deployment. It converges every configured store onto what the
 * redemption needs there - the shared cart Type with the redemption fields and the sync record, and that store's own
 * scoped set of denomination CartDiscounts - and is safe to re-run: existing objects are extended or
 * left alone, never recreated. The order-check API Extension comes last, so its trigger never fires
 * before the cart Type defines the sync record fields it is conditioned on.
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
      syncHashField: config.loyaltySyncHashField,
      syncPointsField: config.loyaltySyncPointsField,
      discountKeyPrefix: config.loyaltyDiscountKeyPrefix,
      stores: config.loyaltyDiscountStores,
      sortOrderBase: config.loyaltyDiscountSortOrderBase,
    },
    logger,
  );
  await ensureOrderCheckExtension(
    paymentSDK.ctAPI.client,
    {
      enabled: config.orderCheckEnabled,
      serviceUrl: config.connectServiceUrl,
      authHeader: config.orderCheckAuthHeader,
      syncPointsField: config.loyaltySyncPointsField,
    },
    logger,
  );
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

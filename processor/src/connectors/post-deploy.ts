import { paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { provisionLoyaltyRedemption } from './loyalty-provisioning';

/**
 * Connect runs this once per deployment. It converges the project onto what the redemption needs -
 * the cart Type with the two custom fields and the 18 denomination CartDiscounts - and is safe to
 * re-run: existing objects are extended or left alone, never recreated.
 */
async function postDeploy() {
  const config = getConfig();
  await provisionLoyaltyRedemption(
    paymentSDK.ctAPI.client,
    {
      typeKey: config.loyaltyCartTypeKey,
      redemptionIdField: config.loyaltyRedemptionIdField,
      denominationsField: config.loyaltyDenominationsField,
      discountKeyPrefix: config.loyaltyDiscountKeyPrefix,
      currencies: config.loyaltyDiscountCurrencies,
      sortOrderBase: config.loyaltyDiscountSortOrderBase,
    },
    { info: (message) => process.stdout.write(`${message}\n`) },
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

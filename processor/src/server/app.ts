import { appLogger, paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { LoyaltyRedemptionService } from '../services/loyalty-redemption.service';
import { CommercetoolsCartRedemptionFieldsClient } from '../clients/cart-redemption-fields.client';
import { CommercetoolsCustomerEmailClient } from '../clients/customer-email.client';
import { CommercetoolsSessionExpiryClient } from '../clients/session-expiry.client';
import { OrderCheckService } from '../services/order-check.service';
import { DefaultSessionService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-session.service';

const giftCardService = new LoyaltyRedemptionService({
  ctCartService: paymentSDK.ctCartService,
  ctPaymentService: paymentSDK.ctPaymentService,
  ctOrderService: paymentSDK.ctOrderService,
  cartFields: new CommercetoolsCartRedemptionFieldsClient(paymentSDK.ctAPI.client, {
    typeKey: getConfig().loyaltyCartTypeKey,
    redemptionIdField: getConfig().loyaltyRedemptionIdField,
    denominationsField: getConfig().loyaltyDenominationsField,
    briqpayHashField: getConfig().briqpaySyncedPayloadHashField,
    syncHashField: getConfig().loyaltySyncHashField,
    syncPointsField: getConfig().loyaltySyncPointsField,
  }),
  customers: new CommercetoolsCustomerEmailClient(paymentSDK.ctAPI.client),
  // The SDK verifies the session on every request but keeps only a projection of it; its expiry
  // needs one more read through the same session service.
  sessions: new CommercetoolsSessionExpiryClient(
    new DefaultSessionService({
      authorizationService: paymentSDK.ctAuthorizationService,
      sessionUrl: getConfig().sessionUrl,
      projectKey: getConfig().projectKey,
      logger: appLogger,
    }),
  ),
});

const orderCheckService = new OrderCheckService(
  async (cartId) => {
    try {
      const cart = (await paymentSDK.ctAPI.client.carts().withId({ ID: cartId }).get().execute()).body;
      return cart.custom?.fields ?? {};
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'statusCode' in e && e.statusCode === 404) {
        return null;
      }
      throw e;
    }
  },
  {
    briqpayHashField: getConfig().briqpaySyncedPayloadHashField,
    syncHashField: getConfig().loyaltySyncHashField,
    syncPointsField: getConfig().loyaltySyncPointsField,
    denominationsField: getConfig().loyaltyDenominationsField,
  },
  appLogger,
);

export const app = {
  services: {
    giftCardService,
    orderCheckService,
  },
  hooks: {},
};

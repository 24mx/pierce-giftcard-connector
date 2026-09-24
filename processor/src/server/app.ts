import { paymentSDK } from '../payment-sdk';
import { getConfig } from '../config/config';
import { LoyaltyRedemptionService } from '../services/loyalty-redemption.service';
import { CommercetoolsCartRedemptionFieldsClient } from '../clients/cart-redemption-fields.client';

const giftCardService = new LoyaltyRedemptionService({
  ctCartService: paymentSDK.ctCartService,
  ctPaymentService: paymentSDK.ctPaymentService,
  ctOrderService: paymentSDK.ctOrderService,
  cartFields: new CommercetoolsCartRedemptionFieldsClient(paymentSDK.ctAPI.client, {
    typeKey: getConfig().loyaltyCartTypeKey,
    redemptionIdField: getConfig().loyaltyRedemptionIdField,
    denominationsField: getConfig().loyaltyDenominationsField,
  }),
});

export const app = {
  services: {
    giftCardService,
  },
  hooks: {},
};

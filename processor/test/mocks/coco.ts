import { Cart } from '@commercetools/connect-payments-sdk';
import { randomUUID } from 'crypto';

export const getCartOK = (overrides: Partial<Cart> = {}) => {
  const cartId = randomUUID();
  const mockGetCartResult: Cart = {
    id: cartId,
    version: 1,
    lineItems: [],
    customLineItems: [],
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'USD',
      centAmount: 150000,
      fractionDigits: 2,
    },
    cartState: 'Ordered',
    origin: 'Customer',
    taxMode: 'ExternalAmount',
    taxRoundingMode: 'HalfEven',
    taxCalculationMode: 'LineItemLevel',
    shipping: [],
    discountCodes: [],
    directDiscounts: [],
    refusedGifts: [],
    itemShippingAddresses: [],
    inventoryMode: 'ReserveOnOrder',
    shippingMode: 'Single',
    shippingInfo: {
      shippingMethodName: 'shippingMethodName1',
      price: {
        type: 'centPrecision',
        currencyCode: 'USD',
        centAmount: 150000,
        fractionDigits: 2,
      },
      shippingRate: {
        price: {
          type: 'centPrecision',
          currencyCode: 'USD',
          centAmount: 1000,
          fractionDigits: 2,
        },
        tiers: [],
      },
      shippingMethodState: 'MatchesCart',
    },
    createdAt: '2024-01-01T00:00:00Z',
    lastModifiedAt: '2024-01-01T00:00:00Z',
  };
  return { ...mockGetCartResult, ...overrides };
};

/** Cart of an identified customer, in the currency the loyalty backend supports. */
export const getCartWithCustomerEmail = (customerEmail: string, overrides: Partial<Cart> = {}) =>
  getCartOK({
    customerEmail,
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'EUR',
      centAmount: 4999,
      fractionDigits: 2,
    },
    ...overrides,
  });

/** A cart that already carries a redemption from a prior redeem(), discounted by its denominations. */
export const cartCarryingRedemption = (
  customerEmail: string,
  redemptionId: string,
  denominations: string[],
  discountedTotalCents: number,
  overrides: Partial<Cart> = {},
) =>
  getCartWithCustomerEmail(customerEmail, {
    totalPrice: { type: 'centPrecision', currencyCode: 'EUR', centAmount: discountedTotalCents, fractionDigits: 2 },
    custom: {
      type: { typeId: 'type', id: 'loyalty-type-id' },
      fields: { loyaltyRedemptionId: redemptionId, loyaltyRedemption: denominations },
    },
    ...overrides,
  });

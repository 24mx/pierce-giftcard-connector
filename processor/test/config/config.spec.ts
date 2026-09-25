import { describe, expect, test } from '@jest/globals';
import { parseLoyaltyDiscountStores } from '../../src/config/config';

describe('parseLoyaltyDiscountStores', () => {
  test('parses one triple per store, uppercasing the currency', () => {
    expect(parseLoyaltyDiscountStores('lu:EUR:18, ro:ron:21 ,se:SEK:22')).toStrictEqual([
      { storeKey: 'lu', currency: 'EUR', levels: 18 },
      { storeKey: 'ro', currency: 'RON', levels: 21 },
      { storeKey: 'se', currency: 'SEK', levels: 22 },
    ]);
  });

  test.each([
    ['lu', 'three non-empty colon-separated parts'],
    ['lu:EUR', 'three non-empty colon-separated parts'],
    ['lu::18', 'three non-empty colon-separated parts'],
    ['lu:EUR:18:extra', 'three non-empty colon-separated parts'],
    ['lu:EURO:18', 'is not a three-letter code'],
    ['lu:EUR:many', 'is not an integer'],
    ['lu:EUR:18.5', 'is not an integer'],
    ['lu:EUR:0', 'outside 1..31'],
    ['lu:EUR:32', 'outside 1..31'],
  ])('rejects %s, naming the entry and what is wrong', (raw, why) => {
    expect(() => parseLoyaltyDiscountStores(raw)).toThrow(`LOYALTY_DISCOUNT_STORES entry "${raw}" is invalid`);
    expect(() => parseLoyaltyDiscountStores(raw)).toThrow(why);
  });
});

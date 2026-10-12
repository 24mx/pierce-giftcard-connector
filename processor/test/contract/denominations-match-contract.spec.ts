import { describe, expect, test } from '@jest/globals';
import * as contract from '../../../packages/loyalty-connector-contract/src';
import { DEFAULT_LOYALTY_DISCOUNT_STORES, config } from '../../src/config/config';
import * as processor from '../../src/services/denominations';

/** Every level count a store can be configured with (config.ts allows 1..31). */
const LEVELS = Array.from({ length: 31 }, (_, i) => i + 1);

const outcome = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    return (error as Error).message;
  }
};

describe('denominations match the published contract', () => {
  test.each(LEVELS)('%d levels: same keys and ceiling', (levels) => {
    expect(processor.denominationKeys(levels)).toEqual(contract.denominationKeys(levels));
    expect(processor.maxDecomposableMinorUnits(levels)).toBe(contract.maxDecomposableMinorUnits(levels));
  });

  test('same decomposition and refusals around every ceiling and across small amounts', () => {
    const amounts = [0, -1, 0.5, ...Array.from({ length: 2048 }, (_, i) => i + 1)];
    for (const levels of LEVELS) {
      const max = 2 ** levels - 1;
      for (const minorUnits of [...amounts, max - 1, max, max + 1]) {
        expect(outcome(() => processor.decompose(minorUnits, levels))).toEqual(
          outcome(() => contract.decompose(minorUnits, levels)),
        );
      }
    }
  });

  test.each(['D1', 'D1024', 'D3', 'D0', 'X1'])('same reading of key %s', (key) => {
    expect(outcome(() => processor.denominationMinorUnits(key))).toEqual(
      outcome(() => contract.denominationMinorUnits(key)),
    );
  });

  test('same discount naming', () => {
    for (let storeIndex = 0; storeIndex < 3; storeIndex++) {
      for (let index = 0; index < 31; index++) {
        expect(processor.denominationSortOrder('0.000001', storeIndex, index)).toBe(
          contract.denominationSortOrder('0.000001', storeIndex, index),
        );
      }
    }
    expect(processor.denominationDiscountKey('loyalty-', 'lu', 'D8')).toBe(
      contract.denominationDiscountKey('loyalty-', 'lu', 'D8'),
    );
    expect(processor.denominationDiscountName('lu', 'D8')).toBe(contract.denominationDiscountName('lu', 'D8'));
    expect(processor.denominationCartPredicate('f', 'D8')).toBe(contract.denominationCartPredicate('f', 'D8'));
  });

  test('the contract defaults are the processor defaults', () => {
    expect(contract.DEFAULT_LOYALTY_DISCOUNT_STORES).toBe(DEFAULT_LOYALTY_DISCOUNT_STORES);
    const unset = (name: string) => process.env[name] === undefined;
    if (unset('LOYALTY_DISCOUNT_KEY_PREFIX')) {
      expect(config.loyaltyDiscountKeyPrefix).toBe(contract.DEFAULT_DISCOUNT_KEY_PREFIX);
    }
    if (unset('LOYALTY_DISCOUNT_SORT_ORDER_BASE')) {
      expect(config.loyaltyDiscountSortOrderBase).toBe(contract.DEFAULT_DISCOUNT_SORT_ORDER_BASE);
    }
    if (unset('LOYALTY_DENOMINATIONS_FIELD')) {
      expect(config.loyaltyDenominationsField).toBe(contract.DEFAULT_DENOMINATIONS_FIELD);
    }
    if (unset('LOYALTY_REDEMPTION_ID_FIELD')) {
      expect(config.loyaltyRedemptionIdField).toBe(contract.DEFAULT_REDEMPTION_ID_FIELD);
    }
    if (unset('LOYALTY_CART_TYPE_KEY')) {
      expect(config.loyaltyCartTypeKey).toBe(contract.DEFAULT_CART_TYPE_KEY);
    }
  });
});

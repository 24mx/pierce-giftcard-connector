import { describe, expect, test } from '@jest/globals';
import {
  decompose,
  denominationCartPredicate,
  denominationDiscountKey,
  denominationDiscountName,
  denominationKey,
  denominationKeys,
  denominationMinorUnits,
  denominationSortOrder,
  maxDecomposableMinorUnits,
  sumDenominations,
} from '../src';

describe('denominations', () => {
  test.each([
    [18, 262143, 'D131072'],
    [19, 524287, 'D262144'],
    [22, 4194303, 'D2097152'],
    [23, 8388607, 'D4194304'],
  ])('%d levels reach %d minor units, topping out at %s', (levels, max, topKey) => {
    expect(denominationKeys(levels)).toHaveLength(levels);
    expect(denominationKeys(levels)[0]).toBe('D1');
    expect(denominationKeys(levels)[levels - 1]).toBe(topKey);
    expect(maxDecomposableMinorUnits(levels)).toBe(max);
  });

  test.each([
    [1, 18, ['D1']],
    [1234, 18, ['D1024', 'D128', 'D64', 'D16', 'D2']],
    [262143, 18, denominationKeys(18).slice().reverse()],
  ])('decomposes %d with %d levels, largest first', (minorUnits, levels, keys) => {
    expect(decompose(minorUnits, levels)).toEqual(keys);
  });

  test('every amount up to the ceiling sums back to itself', () => {
    for (let minorUnits = 1; minorUnits <= 4096; minorUnits++) {
      expect(sumDenominations(decompose(minorUnits, 13))).toBe(minorUnits);
    }
  });

  test.each([
    [0, 18, 'a positive whole number of minor units is required'],
    [-5, 18, 'a positive whole number of minor units is required'],
    [12.5, 18, 'a positive whole number of minor units is required'],
    [262144, 18, '18 levels reach 262143 at most'],
  ])('refuses %d with %d levels', (minorUnits, levels, message) => {
    expect(() => decompose(minorUnits, levels)).toThrow(message);
  });

  test('reads the minor units back from a key and refuses anything but a power of two', () => {
    expect(denominationMinorUnits(denominationKey(1024))).toBe(1024);
    expect(() => denominationMinorUnits('X1')).toThrow('X1 is not a denomination key');
    expect(() => denominationMinorUnits('D3')).toThrow('D3 is not a power-of-two denomination');
    expect(() => denominationMinorUnits('D0')).toThrow('D0 is not a power-of-two denomination');
  });
});

describe('discount naming', () => {
  test('names one store denomination the way provisioning does', () => {
    expect(denominationDiscountKey('loyalty-', 'lu', 'D1024')).toBe('loyalty-lu-D1024');
    expect(denominationDiscountName('lu', 'D1024')).toBe('Loyalty points lu D1024');
    expect(denominationCartPredicate('loyaltyRedemption', 'D1024')).toBe('custom.loyaltyRedemption contains "D1024"');
  });

  test.each([
    [0, 0, '0.00000101011'],
    [0, 9, '0.00000101101'],
    [1, 9, '0.00000102101'],
    [2, 22, '0.00000103231'],
  ])('store %d denomination %d sorts at %s, never ending in zero', (storeIndex, index, sortOrder) => {
    expect(denominationSortOrder('0.000001', storeIndex, index)).toBe(sortOrder);
  });
});

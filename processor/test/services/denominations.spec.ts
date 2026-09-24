import { describe, expect, test } from '@jest/globals';
import {
  DENOMINATION_COUNT,
  MAX_DECOMPOSABLE_MINOR_UNITS,
  decompose,
  denominationKey,
  denominationKeys,
  denominationMinorUnits,
  sumDenominations,
} from '../../src/services/denominations';

describe('denominations', () => {
  test('there are 18 binary denominations, from one minor unit up', () => {
    expect(denominationKeys()).toHaveLength(DENOMINATION_COUNT);
    expect(denominationKeys()[0]).toBe('D1');
    expect(denominationKeys()[17]).toBe('D131072');
    expect(MAX_DECOMPOSABLE_MINOR_UNITS).toBe(262143);
  });

  test.each([
    [1, ['D1']],
    [2, ['D2']],
    [1234, ['D1024', 'D128', 'D64', 'D16', 'D2']],
    [262143, denominationKeys().slice().reverse()],
  ])('decomposes %d into %j', (amount, keys) => {
    expect(decompose(amount)).toStrictEqual(keys);
  });

  test('sumDenominations is the inverse of decompose', () => {
    for (const amount of [1, 7, 999, 4999, 262143]) {
      expect(sumDenominations(decompose(amount))).toBe(amount);
    }
    expect(sumDenominations([])).toBe(0);
  });

  test.each([0, -5, 12.5, 262144, Number.NaN])('refuses %p', (amount) => {
    expect(() => decompose(amount)).toThrow(RangeError);
  });

  test('reads a denomination key back into minor units and rejects junk', () => {
    expect(denominationMinorUnits(denominationKey(512))).toBe(512);
    expect(() => denominationMinorUnits('loyalty')).toThrow(RangeError);
    expect(() => denominationMinorUnits('D3')).toThrow(RangeError);
  });
});

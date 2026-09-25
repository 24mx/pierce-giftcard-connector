import { describe, expect, test } from '@jest/globals';
import {
  decompose,
  denominationKey,
  denominationKeys,
  denominationMinorUnits,
  maxDecomposableMinorUnits,
  sumDenominations,
} from '../../src/services/denominations';

describe('denominations', () => {
  test.each([
    [18, 262143, 'D131072'],
    [21, 2097151, 'D1048576'],
    [22, 4194303, 'D2097152'],
  ])('%d levels reach %d minor units, topping out at %s', (levels, max, topKey) => {
    expect(denominationKeys(levels)).toHaveLength(levels);
    expect(denominationKeys(levels)[0]).toBe('D1');
    expect(denominationKeys(levels)[levels - 1]).toBe(topKey);
    expect(maxDecomposableMinorUnits(levels)).toBe(max);
  });

  test.each([
    [1, 18, ['D1']],
    [2, 18, ['D2']],
    [1234, 18, ['D1024', 'D128', 'D64', 'D16', 'D2']],
    [262143, 18, denominationKeys(18).slice().reverse()],
    // RON/SEK ceiling checks: amounts that need more than 18 levels' worth of headroom, to prove the
    // extra levels are actually reachable, not just declared. Both vectors are the true binary
    // decomposition (verified with a throwaway Python script, not hand-computed) — do not "simplify".
    [1303051, 21, ['D1048576', 'D131072', 'D65536', 'D32768', 'D16384', 'D8192', 'D512', 'D8', 'D2', 'D1']],
    [3014645, 22, ['D2097152', 'D524288', 'D262144', 'D65536', 'D32768', 'D16384', 'D8192', 'D4096', 'D2048', 'D1024', 'D512', 'D256', 'D128', 'D64', 'D32', 'D16', 'D4', 'D1']],
  ])('decomposes %d at %d levels into %j', (amount, levels, keys) => {
    expect(decompose(amount, levels)).toStrictEqual(keys);
  });

  test('sumDenominations is the inverse of decompose', () => {
    for (const [amount, levels] of [
      [1, 18],
      [7, 18],
      [262143, 18],
      [2097151, 21],
      [4194303, 22],
    ] as const) {
      expect(sumDenominations(decompose(amount, levels))).toBe(amount);
    }
    expect(sumDenominations([])).toBe(0);
  });

  test.each([0, -5, 12.5, Number.NaN])('refuses %p regardless of levels', (amount) => {
    expect(() => decompose(amount, 18)).toThrow(RangeError);
  });

  test('refuses an amount above what the given level count reaches', () => {
    expect(() => decompose(262144, 18)).toThrow(RangeError);
    expect(() => decompose(2097152, 21)).toThrow(RangeError);
  });

  test('reads a denomination key back into minor units and rejects junk', () => {
    expect(denominationMinorUnits(denominationKey(512))).toBe(512);
    expect(() => denominationMinorUnits('loyalty')).toThrow(RangeError);
    expect(() => denominationMinorUnits('D3')).toThrow(RangeError);
  });
});

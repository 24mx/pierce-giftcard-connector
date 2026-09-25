import { describe, expect, test } from '@jest/globals';
import { toRedemptionResult } from '../src/providers/redemption-result';

const APPLIED = { centAmount: 1500, currencyCode: 'EUR' };

describe('toRedemptionResult', () => {
  test('a Success body becomes a successful result carrying the redemption id, points and amount', () => {
    const result = toRedemptionResult({
      result: 'Success',
      redemptionId: 'a1b2',
      points: 1500,
      appliedAmount: APPLIED,
    });

    expect(result).toStrictEqual({
      isSuccess: true,
      redemptionId: 'a1b2',
      points: 1500,
      appliedAmount: APPLIED,
    });
  });

  test.each(['Failure', 'Pending', ''])('a %p body becomes a failed result without leaking fields', (state) => {
    const result = toRedemptionResult({
      result: state,
      redemptionId: 'a1b2',
      points: 1500,
      appliedAmount: APPLIED,
    });

    expect(result).toStrictEqual({ isSuccess: false });
  });
});

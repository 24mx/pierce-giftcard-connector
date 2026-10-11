import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOYALTY_DISCOUNT_STORES, parseLoyaltyDiscountStores } from '../../src/config/config';
import { maxDecomposableMinorUnits } from '../../src/services/denominations';

/**
 * The loyalty backend offers points up to its per-order cap (loyalty.redemption.max-eur-per-order in
 * pierce-loyalty, EUR 5000 - TASK-4). Every store this connector provisions must be able to apply that
 * much in its own currency, or the shopper is offered an amount redeem then refuses as
 * AmountNotDecomposable.
 */
const CAP_EUR = 5000;

/**
 * Local units per 1 EUR, as of 2026-10. The backend converts at its live FX_RATE, so a currency gets
 * FX_HEADROOM on top: the levels must still cover the cap after the currency weakens by that much.
 * EUR converts at exactly 1 and needs none.
 */
const REFERENCE_RATES: Record<string, number> = { EUR: 1, RON: 4.97, SEK: 11.0 };
const FX_HEADROOM = 1.2;

const minorUnitsNeeded = (currency: string): number => {
  const rate = REFERENCE_RATES[currency];
  const headroom = currency === 'EUR' ? 1 : FX_HEADROOM;
  return Math.ceil(CAP_EUR * rate * headroom * 100);
};

describe('denomination capacity', () => {
  const stores = parseLoyaltyDiscountStores(DEFAULT_LOYALTY_DISCOUNT_STORES);

  test.each(stores.map((store) => [store.storeKey, store]))(
    'store %s reaches the per-order cap in its own currency',
    (_storeKey, store) => {
      expect(REFERENCE_RATES).toHaveProperty(store.currency);
      expect(maxDecomposableMinorUnits(store.levels)).toBeGreaterThanOrEqual(minorUnitsNeeded(store.currency));
    },
  );

  test('connect.yaml defaults to the same stores as the processor', () => {
    const connectYaml = readFileSync(join(__dirname, '../../../connect.yaml'), 'utf8');
    const entry = connectYaml.match(/key: LOYALTY_DISCOUNT_STORES[\s\S]*?default: (\S+)/);

    expect(entry?.[1]).toBe(DEFAULT_LOYALTY_DISCOUNT_STORES);
  });
});

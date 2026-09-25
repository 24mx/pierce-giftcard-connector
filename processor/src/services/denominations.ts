/**
 * The points discount is composed from a fixed set of absolute-value CartDiscounts, one per power of
 * two of the cart currency's minor unit (D1 = 1 minor unit, D2, D4, …). The cart's `loyaltyRedemption`
 * custom field lists which of them apply, and every CartDiscount's predicate is
 * `custom.loyaltyRedemption contains "Dn"`. How many levels exist is a property of the CURRENCY, not a
 * global constant: a currency worth less per minor unit than EUR needs more levels to reach the same
 * real EUR-equivalent ceiling (see `config.ts`'s `loyaltyDiscountLevelsByCurrency`). The key always
 * names raw minor units, so the same key set is reusable across every currency that needs that many
 * levels, independent of which Store(s) actually provision it.
 */
const KEY_PATTERN = /^D(\d+)$/;

export const denominationKey = (minorUnits: number): string => `D${minorUnits}`;

export const denominationKeys = (levels: number): string[] =>
  Array.from({ length: levels }, (_, exponent) => denominationKey(2 ** exponent));

export const maxDecomposableMinorUnits = (levels: number): number => 2 ** levels - 1;

export const denominationMinorUnits = (key: string): number => {
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    throw new RangeError(`${key} is not a denomination key`);
  }
  const value = Number(match[1]);
  const isPowerOfTwo = (value & (value - 1)) === 0;
  if (!Number.isInteger(value) || value < 1 || !isPowerOfTwo) {
    throw new RangeError(`${key} is not a power-of-two denomination`);
  }
  return value;
};

/** Largest denominations first, so the list reads the way the amount is built. */
export const decompose = (minorUnits: number, levels: number): string[] => {
  if (!Number.isInteger(minorUnits) || minorUnits < 1) {
    throw new RangeError(`cannot decompose ${minorUnits}: a positive whole number of minor units is required`);
  }
  const max = maxDecomposableMinorUnits(levels);
  if (minorUnits > max) {
    throw new RangeError(`cannot decompose ${minorUnits}: ${levels} levels reach ${max} at most`);
  }
  const keys: string[] = [];
  for (let exponent = levels - 1; exponent >= 0; exponent--) {
    const value = 2 ** exponent;
    if ((minorUnits & value) !== 0) {
      keys.push(denominationKey(value));
    }
  }
  return keys;
};

export const sumDenominations = (keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + denominationMinorUnits(key), 0);

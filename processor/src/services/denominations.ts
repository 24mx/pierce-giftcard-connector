/**
 * The points discount is composed from a fixed set of absolute-value CartDiscounts, one per power of
 * two of the cart currency's minor unit (D1 = 1 cent, D2, D4, … D131072). The cart's `loyaltyRedemption`
 * custom field lists which of them apply, and every CartDiscount's predicate is
 * `custom.loyaltyRedemption contains "Dn"`. Eighteen denominations reach 262,143 minor units
 * (EUR 2,621.43) at one-cent resolution while leaving most of the project's 100-automatic-discount
 * budget untouched. The key names minor units, so the same set serves every two-decimal currency.
 */
export const DENOMINATION_COUNT = 18;
export const MAX_DECOMPOSABLE_MINOR_UNITS = 2 ** DENOMINATION_COUNT - 1;

const KEY_PATTERN = /^D(\d+)$/;

export const denominationKey = (minorUnits: number): string => `D${minorUnits}`;

export const denominationKeys = (): string[] =>
  Array.from({ length: DENOMINATION_COUNT }, (_, exponent) => denominationKey(2 ** exponent));

export const denominationMinorUnits = (key: string): number => {
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    throw new RangeError(`${key} is not a denomination key`);
  }
  const value = Number(match[1]);
  const isPowerOfTwo = (value & (value - 1)) === 0;
  if (!Number.isInteger(value) || value < 1 || value > 2 ** (DENOMINATION_COUNT - 1) || !isPowerOfTwo) {
    throw new RangeError(`${key} is not a power-of-two denomination`);
  }
  return value;
};

/** Largest denominations first, so the list reads the way the amount is built. */
export const decompose = (minorUnits: number): string[] => {
  if (!Number.isInteger(minorUnits) || minorUnits < 1) {
    throw new RangeError(`cannot decompose ${minorUnits}: a positive whole number of minor units is required`);
  }
  if (minorUnits > MAX_DECOMPOSABLE_MINOR_UNITS) {
    throw new RangeError(
      `cannot decompose ${minorUnits}: the denominations reach ${MAX_DECOMPOSABLE_MINOR_UNITS} at most`,
    );
  }
  const keys: string[] = [];
  for (let exponent = DENOMINATION_COUNT - 1; exponent >= 0; exponent--) {
    const value = 2 ** exponent;
    if ((minorUnits & value) !== 0) {
      keys.push(denominationKey(value));
    }
  }
  return keys;
};

export const sumDenominations = (keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + denominationMinorUnits(key), 0);

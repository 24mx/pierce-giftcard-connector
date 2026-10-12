/**
 * How the connector projects a points discount onto a commercetools cart, as pure functions: the
 * amount is composed from absolute automatic CartDiscounts, one per power of two of the cart
 * currency's minor unit (D1 = 1 minor unit, D2, D4, …), scoped per Store. The cart's denominations
 * field lists which of them apply. How many levels a store has is a property of its currency (a
 * currency worth less per minor unit than EUR needs more levels to reach the same EUR ceiling).
 *
 * The processor keeps its own copy (Connect builds `processor/` on its own, without this package);
 * `processor/test/contract/denominations-match-contract.spec.ts` fails when the two drift.
 */
const KEY_PATTERN = /^D(\d+)$/;

/** Defaults of the processor's LOYALTY_* configuration; a deployment may override each of them. */
export const DEFAULT_DISCOUNT_KEY_PREFIX = 'loyalty-';
export const DEFAULT_DISCOUNT_SORT_ORDER_BASE = '0.000001';
export const DEFAULT_DENOMINATIONS_FIELD = 'loyaltyRedemption';
export const DEFAULT_REDEMPTION_ID_FIELD = 'loyaltyRedemptionId';
export const DEFAULT_CART_TYPE_KEY = 'pierce-loyalty-cart';
/** "storeKey:currency:levels", comma-separated (LOYALTY_DISCOUNT_STORES). */
export const DEFAULT_LOYALTY_DISCOUNT_STORES = 'lu:EUR:19,ro:RON:22,se:SEK:23';

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

/** The CartDiscount key of one store's denomination, e.g. `loyalty-lu-D1024`. */
export const denominationDiscountKey = (keyPrefix: string, storeKey: string, denomination: string): string =>
  `${keyPrefix}${storeKey}-${denomination}`;

export const denominationDiscountName = (storeKey: string, denomination: string): string =>
  `Loyalty points ${storeKey} ${denomination}`;

/** The predicate that unlocks a denomination's CartDiscount once the cart lists it. */
export const denominationCartPredicate = (denominationsField: string, denomination: string): string =>
  `custom.${denominationsField} contains "${denomination}"`;

/**
 * commercetools wants a project-wide unique sortOrder in (0, 1) that does not end in zero:
 * `<base><store index, 2 digits><denomination index, 2 digits>1`, both indexes zero-based here.
 */
export const denominationSortOrder = (sortOrderBase: string, storeIndex: number, denominationIndex: number): string =>
  `${sortOrderBase}${String(storeIndex + 1).padStart(2, '0')}${String(denominationIndex + 1).padStart(2, '0')}1`;

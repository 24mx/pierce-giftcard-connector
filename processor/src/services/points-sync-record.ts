/**
 * Which points amount Briqpay last saw on a cart. The Briqpay connector writes a hash of the payload it
 * synced to Briqpay onto the cart, and stops writing it once the shopper pressed pay (the session is
 * then completed). So "at this hash, the points discount was this amount" tells the order check whether
 * the amount the shopper paid for still includes the points on the order.
 *
 * `hash` is null while the cart has no Briqpay session yet. `points` is the sum of the denomination
 * keys (minor units of the cart currency).
 */
export type SyncRecord = {
  hash: string | null;
  points: number;
};

export type OrderCheckVerdict = 'pass' | 'refuse';

/**
 * The record to write with a points change, or null to keep the current one. A hash that moved since
 * the last record means Briqpay synced the cart after that change, so the points before this change are
 * what Briqpay saw at the current hash. An unchanged hash means Briqpay has not seen the cart since the
 * last change, and the record still names the last amount it did see.
 */
export const nextSyncRecord = (
  previous: SyncRecord | null,
  currentHash: string | null,
  pointsBefore: number,
): SyncRecord | null => {
  if (previous !== null && previous.hash === currentHash) {
    return null;
  }
  return { hash: currentHash, points: pointsBefore };
};

/**
 * Refuses an order only when Briqpay saw this exact cart state (same hash) with a different points
 * amount: the shopper then paid an amount that does not include the points on the order (P4 removal,
 * P5 addition after pressing pay).
 */
export const orderCheckVerdict = (
  record: SyncRecord | null,
  orderHash: string | null,
  orderPoints: number,
): OrderCheckVerdict => {
  if (record === null || record.hash !== orderHash || record.points === orderPoints) {
    return 'pass';
  }
  return 'refuse';
};

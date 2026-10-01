import { describe, expect, test } from '@jest/globals';
import { nextSyncRecord, orderCheckVerdict } from '../../src/services/points-sync-record';

describe('nextSyncRecord', () => {
  test('starts a record at the first points change, even before Briqpay has a session', () => {
    expect(nextSyncRecord(null, null, 0)).toStrictEqual({ hash: null, points: 0 });
  });

  test('replaces the record when Briqpay synced the cart since the last change', () => {
    expect(nextSyncRecord({ hash: null, points: 0 }, 'h1', 1500)).toStrictEqual({ hash: 'h1', points: 1500 });
    expect(nextSyncRecord({ hash: 'h1', points: 1500 }, 'h2', 0)).toStrictEqual({ hash: 'h2', points: 0 });
  });

  test('keeps the record when Briqpay has not synced since the last change', () => {
    expect(nextSyncRecord({ hash: 'h1', points: 1500 }, 'h1', 0)).toBeNull();
    expect(nextSyncRecord({ hash: null, points: 0 }, null, 1500)).toBeNull();
  });
});

describe('orderCheckVerdict', () => {
  test('passes an order from a cart that never had points', () => {
    expect(orderCheckVerdict(null, 'h1', 0)).toBe('pass');
  });

  test('passes when Briqpay synced the cart after the last points change', () => {
    expect(orderCheckVerdict({ hash: 'h1', points: 1500 }, 'h2', 0)).toBe('pass');
    expect(orderCheckVerdict({ hash: null, points: 0 }, 'h1', 1500)).toBe('pass');
  });

  test('passes when the points Briqpay saw are the points on the order', () => {
    expect(orderCheckVerdict({ hash: 'h1', points: 1500 }, 'h1', 1500)).toBe('pass');
  });

  test('refuses points removed after Briqpay last saw the cart (P4)', () => {
    expect(orderCheckVerdict({ hash: 'h1', points: 1500 }, 'h1', 0)).toBe('refuse');
  });

  test('refuses points added after Briqpay last saw the cart (P5)', () => {
    expect(orderCheckVerdict({ hash: 'h1', points: 0 }, 'h1', 1500)).toBe('refuse');
  });
});

describe('record over a checkout', () => {
  // Each step: the hash on the cart at that moment, and the points before and after the change.
  const replay = (steps: { hash: string | null; before: number }[]) =>
    steps.reduce<{ hash: string | null; points: number } | null>(
      (record, step) => nextSyncRecord(record, step.hash, step.before) ?? record,
      null,
    );

  test('passes a replace at the same value that Briqpay never re-synced', () => {
    // hold 1500 (no session yet) → Briqpay syncs h1 → release → hold 1500 again, no new sync
    const record = replay([
      { hash: null, before: 0 },
      { hash: 'h1', before: 1500 },
      { hash: 'h1', before: 0 },
    ]);
    expect(orderCheckVerdict(record, 'h1', 1500)).toBe('pass');
  });

  test('refuses a removal after pay even when the shopper toggled points before', () => {
    // hold 1500 → sync h1 → release → sync h2 → hold 1500 → sync h3 → pay → release in a second tab
    const record = replay([
      { hash: null, before: 0 },
      { hash: 'h1', before: 1500 },
      { hash: 'h2', before: 0 },
      { hash: 'h3', before: 1500 },
    ]);
    expect(orderCheckVerdict(record, 'h3', 0)).toBe('refuse');
  });
});

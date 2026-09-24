import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOYALTY_ERROR_KEYS } from '../../../packages/loyalty-connector-contract/src';

const SERVICE = join(__dirname, '../../src/services/loyalty-redemption.service.ts');

/** Every `key: 'X'` literal the service answers with, in source order, de-duplicated. */
const keysUsedByService = (): string[] => {
  const source = readFileSync(SERVICE, 'utf8');
  return [...new Set([...source.matchAll(/key: '([A-Za-z]+)'/g)].map((m) => m[1]))];
};

describe('error keys match the published contract', () => {
  test('the service answers only with keys the contract lists', () => {
    const unknown = keysUsedByService().filter((key) => !(LOYALTY_ERROR_KEYS as readonly string[]).includes(key));
    expect(unknown).toEqual([]);
  });

  test('the contract lists no key the service never answers with', () => {
    const used = keysUsedByService();
    const dead = LOYALTY_ERROR_KEYS.filter((key) => !used.includes(key));
    expect(dead).toEqual([]);
  });
});

import { describe, expect, test } from '@jest/globals';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contract from '../src';

const example = (name: string) => JSON.parse(readFileSync(join(__dirname, '../examples', name), 'utf8'));

describe('examples validate against their schemas', () => {
  test.each([
    ['balance.request.json', contract.BalanceRequestSchema],
    ['balance.response.json', contract.BalanceResponseSchema],
    ['redeem.request.json', contract.RedeemRequestSchema],
    ['redeem.response.json', contract.RedeemResponseSchema],
    ['finalize.request.json', contract.FinalizeRequestSchema],
    ['finalize.response.json', contract.FinalizeResponseSchema],
    ['release.request.json', contract.ReleaseRequestSchema],
    ['release.response.json', contract.ReleaseResponseSchema],
    ['error.response.json', contract.ErrorResponseSchema],
  ])('%s', (file, schema) => {
    const value = example(file);
    expect([...Value.Errors(schema, value)]).toEqual([]);
  });

  test('the error example uses a listed key', () => {
    const { status } = example('error.response.json');
    expect(contract.LOYALTY_ERROR_KEYS).toContain(status.state);
  });
});

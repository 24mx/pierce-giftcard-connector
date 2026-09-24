import { describe, expect, test } from '@jest/globals';
import * as contract from '../../../packages/loyalty-connector-contract/src';
import * as dto from '../../src/dtos/loyalty-redemption.dto';
import { AmountSchema } from '../../src/dtos/operations/payment-intents.dto';

// TypeBox schemas carry symbol-keyed metadata; comparing their JSON form is what a consumer sees.
const plain = (schema: unknown) => JSON.parse(JSON.stringify(schema));

const SCHEMAS = [
  'BalanceRequestSchema',
  'BalanceResponseSchema',
  'RedeemRequestSchema',
  'RedeemResponseSchema',
  'FinalizeRequestSchema',
  'FinalizeResponseSchema',
  'ReleaseRequestSchema',
  'ReleaseResponseSchema',
] as const;

describe('route schemas match the published contract', () => {
  test.each(SCHEMAS)('%s', (name) => {
    expect(plain(dto[name])).toEqual(plain(contract[name]));
  });

  test('AmountSchema', () => {
    expect(plain(AmountSchema)).toEqual(plain(contract.AmountSchema));
  });
});

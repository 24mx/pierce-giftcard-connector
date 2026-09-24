import { afterEach, describe, expect, test } from '@jest/globals';
import { systemEnv } from './env';

describe('system suite gate', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  test('is off when SYSTEM_PROCESSOR_URL is unset', () => {
    delete process.env.SYSTEM_PROCESSOR_URL;
    expect(systemEnv()).toBeNull();
  });

  test('names the first missing variable when the gate is on', () => {
    process.env.SYSTEM_PROCESSOR_URL = 'https://processor.staging';
    delete process.env.SYSTEM_LOYALTY_API_URL;
    expect(() => systemEnv()).toThrow('SYSTEM_LOYALTY_API_URL');
  });
});

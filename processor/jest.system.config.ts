/* eslint-disable @typescript-eslint/no-require-imports */
const base = require('./jest.config.ts');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  roots: ['./test/system'],
  testMatch: ['**/*.system.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Real network calls to staging: one at a time, and patient.
  maxWorkers: 1,
  testTimeout: 90_000,
};

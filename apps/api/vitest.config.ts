import { defineConfig } from 'vitest/config';

// Unit/contract tests live next to source as *.test.ts and never need a database.
// Integration tests live in test/integration and get a database from global-setup
// (DATABASE_URL when set, otherwise an embedded throwaway Postgres).
const integration = process.env['VITEST_INTEGRATION'] === '1';

export default defineConfig({
  test: {
    include: integration ? ['test/integration/**/*.test.ts'] : ['src/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    ...(integration
      ? {
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        }
      : {}),
  },
});

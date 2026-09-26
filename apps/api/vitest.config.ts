import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/publishing-core/src',
);

// Unit/contract tests live next to source as *.test.ts and never need a database.
// Integration tests live in test/integration and get a database from global-setup
// (DATABASE_URL when set, otherwise an embedded throwaway Postgres).
const integration = process.env['VITEST_INTEGRATION'] === '1';

export default defineConfig({
  // Resolve the workspace package from source so tests never need a build step.
  resolve: {
    alias: [
      {
        find: '@postelyo/publishing-core/contract-suite',
        replacement: path.join(core, 'provider-contract.ts'),
      },
      { find: '@postelyo/publishing-core', replacement: path.join(core, 'index.ts') },
    ],
  },
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

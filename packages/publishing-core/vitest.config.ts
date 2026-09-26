import { defineConfig } from 'vitest/config';

// Contract and adapter tests; no database, no network.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
  },
});

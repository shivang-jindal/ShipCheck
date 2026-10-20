import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts', 'shared/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each test file boots its own embedded PostgreSQL; keep them sequential
    // so the machine is not saturated by parallel WASM instances.
    fileParallelism: false,
    pool: 'forks',
  },
});
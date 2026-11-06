import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    // Every file shares one database; the tests reset it between cases, so files must not overlap.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});

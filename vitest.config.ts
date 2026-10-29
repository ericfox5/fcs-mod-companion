import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'worker/test/**/*.test.ts', 'bridge/test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});

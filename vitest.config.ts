import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/extension/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});

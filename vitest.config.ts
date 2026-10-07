import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tools/**/fixtures/**'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // RULES.md T1: kavach detectors and vault require 100% branch coverage.
      include: ['packages/kavach/src/**'],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});

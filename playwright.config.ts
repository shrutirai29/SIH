import { defineConfig } from '@playwright/test';

/**
 * Browser tests (ticket H5).
 *
 * Separate from the vitest suite on purpose: these are slow, they need a built
 * artefact, and they assert different things. `pnpm test` stays fast; `pnpm test:e2e`
 * is what proves the extension actually works.
 */
export default defineConfig({
  testDir: './packages/eval/e2e',
  testMatch: '**/*.spec.ts',
  // Extensions load into a persistent context; parallel workers fight over it.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === 'true' ? 'list' : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /**
   * The suite needs a server, and it used to need you to remember that.
   *
   * Without one, `postStep` clears the guard and then fails at `fetch`, so no
   * transmission is recorded and the diff viewer has nothing to show — which is
   * exactly how the D16 test failed on a clean checkout while `pnpm verify` claimed
   * to be the merge gate and CI ran the same command with nothing listening. A test
   * that only passes when you happen to have a terminal open elsewhere is not a gate.
   *
   * `reuseExistingServer` keeps `pnpm server:mock` in another terminal working, and
   * lets the real FastAPI server stand in when it is the one being exercised.
   */
  webServer: {
    command: 'node tools/mock-server/index.mjs',
    url: 'http://127.0.0.1:8080/v1/health',
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

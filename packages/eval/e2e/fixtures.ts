/**
 * Playwright fixtures for testing the extension in a real browser (ticket H5).
 *
 * WHY THIS EXISTS. Every node test passed while the extension was completely dead:
 * Ajv built its validator with `new Function`, MV3's CSP refused to evaluate it, and
 * the egress guard threw on every step. Node has no CSP, so nothing caught it except a
 * human loading the extension by hand (TODO.md bug #5, ADR-0003).
 *
 * A browser is the only place where the manifest, the service-worker lifecycle, content
 * script injection, the CSP and the real DOM are all true at once. Anything asserted
 * anywhere else is asserted about a simulation.
 */

import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export const EXTENSION_PATH = resolve(repoRoot, 'packages/extension/dist-chrome');
export const DEMO_PORTAL_URL = pathToFileURL(
  resolve(repoRoot, 'packages/eval/fixtures/demo-portal.html'),
).href;

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  /** The MV3 service worker, so tests can drive the extension's own APIs. */
  serviceWorker: Worker;
  /** Everything the service worker logged. Asserted to be free of CSP errors. */
  workerErrors: string[];
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      // MV3 service workers do not start under the old headless mode. `--headless=new`
      // is the shipping renderer and does run them.
      channel: 'chromium',
      args: [
        '--headless=new',
        '--disable-extensions-except=' + EXTENSION_PATH,
        '--load-extension=' + EXTENSION_PATH,
        // file:// pages are the demo portal's home; the content script must reach them.
        '--allow-file-access-from-files',
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 });
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    // chrome-extension://<id>/background.js
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },

  workerErrors: async ({ context, serviceWorker }, use) => {
    const errors: string[] = [];
    serviceWorker.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    context.on('weberror', (e) => errors.push(e.error().message));
    await use(errors);
  },
});

export { expect } from '@playwright/test';

/**
 * Patterns that mean the extension is structurally broken rather than merely failing.
 * A CSP violation is the exact shape of bug #5 and must never appear again.
 */
export const FATAL_CONSOLE_PATTERNS = [
  /EvalError/i,
  /unsafe-eval/i,
  /Content Security Policy/i,
  /require is not defined/i,
  /Cannot read properties of undefined/i,
];

export function assertNoFatalErrors(messages: readonly string[]): void {
  const fatal = messages.filter((m) => FATAL_CONSOLE_PATTERNS.some((p) => p.test(m)));
  if (fatal.length > 0) {
    throw new Error(
      'The extension logged errors that mean it is structurally broken:\n  ' +
        fatal.join('\n  '),
    );
  }
}

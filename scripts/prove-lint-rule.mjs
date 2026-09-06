/**
 * Proves the choke-point lint rule actually fires (PHASEWISE.md P1 exit criterion).
 *
 * A rule that is configured but never demonstrated is indistinguishable from one that
 * silently stopped matching. This lints a file that is a deliberate violation and
 * FAILS if ESLint reports it clean.
 */

import { ESLint } from 'eslint';

const FIXTURE = 'tools/eslint-plugin-prahari/test/fixtures/violation.ts';

const eslint = new ESLint({
  overrideConfigFile: 'eslint.config.js',
  // The fixture is globally ignored so it cannot fail a normal `eslint .` run.
  overrideConfig: { rules: {} },
  ignore: false,
});

const results = await eslint.lintFiles([FIXTURE]);
const messages = results.flatMap((r) => r.messages);
const hits = messages.filter((m) => m.ruleId === 'prahari/no-network-outside-net');

if (hits.length === 0) {
  console.error(
    'FAIL: prahari/no-network-outside-net did not fire on ' + FIXTURE + '.\n' +
      'The choke-point rule is not protecting anything. Fix the rule before merging.',
  );
  console.error(JSON.stringify(messages, null, 2));
  process.exit(1);
}

console.log('ok: the choke-point rule fired ' + String(hits.length) + ' time(s) on the violation fixture');
console.log('    ' + hits[0].message);

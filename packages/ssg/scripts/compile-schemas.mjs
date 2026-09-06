/**
 * Precompiles the JSON Schemas into standalone validator modules.
 *
 * WHY THIS EXISTS: Ajv normally validates by generating JavaScript source and calling
 * `new Function(...)`. MV3 extension pages forbid that — our own CSP says
 * `script-src 'self'`, with no `unsafe-eval` (RULES.md S7) — so a runtime-compiling
 * validator throws `EvalError` inside the extension and the egress guard dies.
 *
 * The fix is NOT to relax the CSP. That would permit arbitrary strings to execute in
 * the most privileged context we have — the one context holding the network
 * permission. Instead we do the compilation here, at build time, and ship a plain
 * module with the validator already written out. No codegen at runtime, no eval, and
 * a faster first validation as a side effect.
 *
 * The JSON Schema remains the single source of truth (RULES.md C1). This output is
 * generated: never edit it, and CI fails if it drifts from a fresh run.
 *
 * Usage: node packages/ssg/scripts/compile-schemas.mjs
 */

import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const schemaDir = resolve(root, 'schema');
const outDir = resolve(root, 'src/generated');

const readSchema = async (name) =>
  JSON.parse(await readFile(resolve(schemaDir, name), 'utf8'));

const HEADER = `/* eslint-disable */
// @ts-nocheck
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by \`pnpm gen:contract\` from packages/ssg/schema/*.json.
 * Precompiled so the egress guard can validate without \`new Function\`, which the
 * extension's CSP forbids. Change the schema and regenerate; never edit this.
 */
`;

async function main() {
  const ssg = await readSchema('ssg-v1.json');
  const manifest = await readSchema('redaction-manifest-v1.json');
  const actionPlan = await readSchema('action-plan-v1.json');

  // Same options as the runtime validator used to use. `strict` is a privacy control:
  // an unknown field is a field nobody redacted (RULES.md P7).
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    code: { source: true, esm: true },
  });

  ajv.addSchema(manifest);
  ajv.addSchema(ssg);
  ajv.addSchema(actionPlan);

  await mkdir(outDir, { recursive: true });

  const targets = [
    ['validate-ssg.mjs', ssg.$id],
    ['validate-action-plan.mjs', actionPlan.$id],
  ];

  const UCS2LENGTH_IMPL = `
function ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  while (pos < len) {
    length++;
    const value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      const extra = str.charCodeAt(pos);
      if ((extra & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}
`;

  for (const [file, id] of targets) {
    const validate = ajv.getSchema(id);
    if (validate === undefined) throw new Error('schema not registered: ' + id);
    let code = standaloneCode(ajv, validate);
    // Eliminate CJS require() calls emitted by Ajv standalone for string length keywords
    code = code.replace(/require\(["']ajv\/dist\/runtime\/ucs2length["']\)(\.default)?/g, 'ucs2length');
    await writeFile(resolve(outDir, file), HEADER + UCS2LENGTH_IMPL + code, 'utf8');
    console.log('wrote src/generated/' + file);
  }

  // Hand-written types for the generated modules. Small enough to keep honest, and it
  // keeps `strict` TypeScript over the guard's call site.
  const dts = `${HEADER}
export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message?: string;
}

export interface PrecompiledValidator {
  (data: unknown): boolean;
  errors?: ValidationError[] | null;
}

declare const validate: PrecompiledValidator;
export default validate;
`;
  await writeFile(resolve(outDir, 'validate-ssg.d.mts'), dts, 'utf8');
  await writeFile(resolve(outDir, 'validate-action-plan.d.mts'), dts, 'utf8');
  console.log('wrote type declarations');
}

await main();

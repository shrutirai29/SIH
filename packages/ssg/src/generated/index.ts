/**
 * Entry point for the precompiled validators.
 *
 * The `validate-*.mjs` siblings are GENERATED (`pnpm gen:contract`); this file is
 * hand-written and is the only thing the rest of the codebase imports.
 *
 * They exist because Ajv's normal path builds a validator with `new Function`, which
 * the extension's CSP forbids (RULES.md S7). Compiling at build time keeps the schema
 * as the source of truth while shipping something that can actually run in MV3.
 */

export { default as validateSsg } from './validate-ssg.mjs';
export { default as validateActionPlan } from './validate-action-plan.mjs';
export type { PrecompiledValidator, ValidationError } from './validate-ssg.mjs';

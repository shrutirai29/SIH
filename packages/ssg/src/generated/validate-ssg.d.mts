/* eslint-disable */
// @ts-nocheck
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by `pnpm gen:contract` from packages/ssg/schema/*.json.
 * Precompiled so the egress guard can validate without `new Function`, which the
 * extension's CSP forbids. Change the schema and regenerate; never edit this.
 */

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

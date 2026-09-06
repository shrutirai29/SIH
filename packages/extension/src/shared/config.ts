/**
 * Build-time configuration. `serverOrigin` is baked in and is the ONLY host the
 * manifest grants network access to (RULES.md P10).
 */

const RAW_ORIGIN =
  (import.meta.env['VITE_PRAHARI_SERVER_ORIGIN'] as string | undefined) ?? 'http://localhost:8080';

export const CONFIG = {
  serverOrigin: RAW_ORIGIN,

  /**
   * Dev-only escape hatch so the walking skeleton can talk to the plain-http mock
   * server on localhost. The guard refuses non-https for anything else, and this flag
   * is false in a production build.
   */
  allowInsecureLocalhost: import.meta.env.DEV,

  privacyMode: 'balanced' as 'strict' | 'balanced' | 'fast',
  tierCeiling: 1 as 0 | 1 | 2,

  /** Hard stop so a broken loop cannot hammer a page or the server. */
  maxSteps: 12,

  /** Milliseconds to wait for the page to settle after an action before re-observing. */
  settleMs: 400,

  /** Upper bound on elements per SSG. The schema caps at 400; the skeleton stays small. */
  maxElements: 50,

  ledgerRetentionDays: 30,
} as const;

export type PrivacyMode = typeof CONFIG.privacyMode;

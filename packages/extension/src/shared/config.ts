const RAW_ORIGIN =
  (import.meta.env['VITE_PRAHARI_SERVER_ORIGIN'] as string | undefined) ??
  'http://localhost:8081';

export const CONFIG = {
  serverOrigin: RAW_ORIGIN,

  allowInsecureLocalhost: import.meta.env.DEV,

  privacyMode: 'balanced' as 'strict' | 'balanced' | 'fast',
  tierCeiling: 1 as 0 | 1 | 2,

  maxSteps: 12,
  settleMs: 400,
  maxElements: 50,

  ledgerRetentionDays: 30,
} as const;

export type PrivacyMode = typeof CONFIG.privacyMode;

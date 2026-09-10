const RAW_ORIGIN =
  (import.meta.env['VITE_PRAHARI_SERVER_ORIGIN'] as string | undefined) ??
  'http://127.0.0.1:8000';

export const CONFIG = {
  serverOrigin: RAW_ORIGIN,

  allowInsecureLocalhost: true,

  privacyMode: 'balanced' as 'strict' | 'balanced' | 'fast',
  tierCeiling: 1 as 0 | 1 | 2,

  maxSteps: 12,
  settleMs: 400,
  maxElements: 50,

  ledgerRetentionDays: 30,
} as const;

export type PrivacyMode = typeof CONFIG.privacyMode;

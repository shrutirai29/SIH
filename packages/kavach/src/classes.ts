/**
 * The PII taxonomy, and the sensitivity lattice that resolves conflicts between
 * detectors.
 *
 * This is configuration, not code: the class list is expected to grow (GLiNER is
 * zero-shot, so Tier-B classes are added by naming them). What must NOT drift is the
 * lattice below — when two detectors disagree about the same span, the more sensitive
 * class wins, and that ordering is a privacy decision, not a tie-break convenience.
 */

/** Tier A — structured, checksum-verifiable. Target recall >= 0.99. */
export type StructuredClass =
  | 'AADHAAR' | 'PAN' | 'GSTIN' | 'IFSC' | 'UPI_VPA' | 'ABHA'
  | 'VOTER_ID' | 'PASSPORT_IN' | 'DL_IN' | 'PHONE_IN'
  | 'CARD_NUMBER' | 'BANK_ACCOUNT' | 'IMEI'
  | 'EMAIL' | 'IP';

/** Credentials. Never vaulted, never reversible, dropped at redaction time. */
export type CredentialClass =
  | 'PASSWORD' | 'OTP' | 'CVV' | 'API_KEY' | 'JWT' | 'PRIVATE_KEY';

/** Tier B — contextual. Found by NER (ticket C10), so this list is configuration. */
export type ContextualClass =
  | 'PERSON_NAME' | 'ADDRESS' | 'DOB' | 'AGE' | 'GENDER'
  | 'HEALTH_CONDITION' | 'MEDICATION' | 'DIAGNOSIS'
  | 'EMPLOYER' | 'SALARY' | 'RELIGION' | 'CASTE';

/** Tier C — visual only, no DOM evidence. Detected by vision (Phase 2). */
export type VisualClass = 'FACE' | 'SIGNATURE' | 'ID_DOCUMENT' | 'QR_CODE' | 'CAMERA_FEED';

export type PiiClass = StructuredClass | CredentialClass | ContextualClass | VisualClass;

/**
 * Groups, ordered most-sensitive first. Position in this array IS the lattice.
 */
export const SENSITIVITY_ORDER = [
  'credential',
  'gov_id',
  'financial',
  'health',
  'biometric',
  'contact',
  'identity',
  'other',
] as const;

export type SensitivityGroup = (typeof SENSITIVITY_ORDER)[number];

const GROUP_OF: Record<PiiClass, SensitivityGroup> = {
  // credential
  PASSWORD: 'credential',
  OTP: 'credential',
  CVV: 'credential',
  API_KEY: 'credential',
  JWT: 'credential',
  PRIVATE_KEY: 'credential',

  // gov_id
  AADHAAR: 'gov_id',
  PAN: 'gov_id',
  GSTIN: 'gov_id',
  ABHA: 'gov_id',
  VOTER_ID: 'gov_id',
  PASSPORT_IN: 'gov_id',
  DL_IN: 'gov_id',

  // financial
  CARD_NUMBER: 'financial',
  BANK_ACCOUNT: 'financial',
  IFSC: 'financial',
  UPI_VPA: 'financial',
  SALARY: 'financial',

  // health
  HEALTH_CONDITION: 'health',
  MEDICATION: 'health',
  DIAGNOSIS: 'health',

  // biometric
  FACE: 'biometric',
  SIGNATURE: 'biometric',
  ID_DOCUMENT: 'biometric',
  CAMERA_FEED: 'biometric',

  // contact
  EMAIL: 'contact',
  PHONE_IN: 'contact',
  ADDRESS: 'contact',
  IP: 'contact',
  IMEI: 'contact',

  // identity
  PERSON_NAME: 'identity',
  DOB: 'identity',
  AGE: 'identity',
  GENDER: 'identity',
  RELIGION: 'identity',
  CASTE: 'identity',
  EMPLOYER: 'identity',
  QR_CODE: 'identity',
};

export function groupOf(cls: string): SensitivityGroup {
  // An unknown class is treated as the most sensitive thing it could be. Fail-closed
  // applies to taxonomy gaps too: a class we have not classified is not "other".
  return GROUP_OF[cls as PiiClass] ?? 'credential';
}

export function rankOf(cls: string): number {
  return SENSITIVITY_ORDER.indexOf(groupOf(cls));
}

/** Returns whichever class the policy must treat as more sensitive. */
export function mostSensitive(a: string, b: string): string {
  return rankOf(a) <= rankOf(b) ? a : b;
}

/**
 * Credentials are never vaulted and never reversible (RULES.md P4). The real value is
 * dropped at redaction time, so there is nothing for any later request to resolve.
 */
export function isCredential(cls: string): boolean {
  return groupOf(cls) === 'credential';
}

/** The sentinel that stands in for a dropped credential. Resolves to nothing, ever. */
export const IRREVERSIBLE_SENTINEL = 'REDACTED';

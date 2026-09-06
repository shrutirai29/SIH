/**
 * KAVACH Layer 0 — DOM rules.
 *
 * ~1ms, deterministic, recall 1.0 on its own classes. When the page tells us a field
 * holds a password, that is not a heuristic to be weighed against others; it is ground
 * truth, and it short-circuits the rest of the cascade.
 *
 * Takes a plain descriptor rather than an `Element` so the rules are pure and testable
 * in node. The content script adapts a live element into this shape.
 */

import type { PiiClass } from '../classes.js';

export interface FieldDescriptor {
  /** Lowercased `input` type, `textarea`, or the tag name for anything else. */
  readonly type: string;
  readonly autocomplete?: string;
  readonly name?: string;
  readonly id?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  /** Text of the associated `<label>`, if any. */
  readonly label?: string;
  readonly inputMode?: string;
}

export interface L0Hit {
  readonly cls: PiiClass;
  /** Deterministic rules are certain; that certainty is what lets us skip L1/L2. */
  readonly confidence: 1;
  readonly source: 'l0-dom';
  readonly evidence: string;
}

/**
 * Label-driven rules for the Indian identifier pack. Ordered: more specific patterns
 * first, because `pan` would otherwise match inside `company`.
 */
const LABEL_RULES: readonly (readonly [RegExp, PiiClass])[] = [
  [/aadhaar|aadhar|uidai|\buid\b/, 'AADHAAR'],
  [/\bgstin\b|\bgst\s*(no|number|id)\b/, 'GSTIN'],
  [/\bifsc\b/, 'IFSC'],
  [/\bupi\b|\bvpa\b|virtual\s*payment/, 'UPI_VPA'],
  [/\babha\b|health\s*id/, 'ABHA'],
  [/\bpan\b|permanent\s*account/, 'PAN'],
  [/voter\s*id|\bepic\b/, 'VOTER_ID'],
  [/passport/, 'PASSPORT_IN'],
  [/driving\s*licen[cs]e|\bdl\s*(no|number)\b/, 'DL_IN'],
  [/account\s*(no|number)|\ba\/c\b/, 'BANK_ACCOUNT'],
  [/\botp\b|one[\s-]*time\s*(password|code)|verification\s*code/, 'OTP'],
  [/\bcvv\b|\bcvc\b|security\s*code/, 'CVV'],
  [/card\s*(no|number)|credit\s*card|debit\s*card/, 'CARD_NUMBER'],
  [/\bimei\b/, 'IMEI'],
  [/salary|income|ctc\b/, 'SALARY'],
  [/diagnos|ailment|condition/, 'HEALTH_CONDITION'],
  [/medication|prescription|\bdrug\b/, 'MEDICATION'],
];

/** `autocomplete` tokens are a standard, so these are exact matches, not patterns. */
const AUTOCOMPLETE_RULES: Record<string, PiiClass> = {
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  'one-time-code': 'OTP',
  'cc-csc': 'CVV',
  'cc-number': 'CARD_NUMBER',
  'cc-name': 'PERSON_NAME',
  'cc-exp': 'CARD_NUMBER',
  'cc-exp-month': 'CARD_NUMBER',
  'cc-exp-year': 'CARD_NUMBER',
  email: 'EMAIL',
  name: 'PERSON_NAME',
  'given-name': 'PERSON_NAME',
  'family-name': 'PERSON_NAME',
  'additional-name': 'PERSON_NAME',
  'honorific-prefix': 'PERSON_NAME',
  nickname: 'PERSON_NAME',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'address-line3': 'ADDRESS',
  'address-level1': 'ADDRESS',
  'address-level2': 'ADDRESS',
  'postal-code': 'ADDRESS',
  country: 'ADDRESS',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  sex: 'GENDER',
  organization: 'EMPLOYER',
};

/**
 * Classifies a form field from its DOM evidence alone.
 * Returns null when the DOM says nothing — that field falls through to L1/L2.
 */
export function classifyField(f: FieldDescriptor): L0Hit | null {
  const hit = (cls: PiiClass, evidence: string): L0Hit => ({
    cls,
    confidence: 1,
    source: 'l0-dom',
    evidence,
  });

  // --- strongest signal: the browser's own field type ------------------------
  if (f.type === 'password') return hit('PASSWORD', 'input[type=password]');

  const autocomplete = (f.autocomplete ?? '').toLowerCase().trim();
  if (autocomplete.length > 0) {
    // The spec allows section/billing/shipping prefixes; the last token carries the
    // meaning. Ignoring the prefix is what makes `shipping street-address` work.
    const tokens = autocomplete.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      if (token === undefined) continue;
      const cls = AUTOCOMPLETE_RULES[token];
      if (cls !== undefined) return hit(cls, 'autocomplete=' + token);
      // `tel`, `tel-national`, `tel-area-code`, ... are a family rather than a fixed
      // set. Test the TOKEN, not the whole attribute: `billing tel` is a phone field
      // and testing the attribute would miss every prefixed one on a real checkout.
      if (token === 'tel' || token.startsWith('tel-')) {
        return hit('PHONE_IN', 'autocomplete=' + token);
      }
    }
  }

  if (f.type === 'email') return hit('EMAIL', 'input[type=email]');
  if (f.type === 'tel') return hit('PHONE_IN', 'input[type=tel]');

  // --- label / name / id / placeholder text ---------------------------------
  const hint = [f.name, f.id, f.placeholder, f.ariaLabel, f.label]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join(' ')
    .toLowerCase();

  if (hint.length > 0) {
    for (const [re, cls] of LABEL_RULES) {
      if (re.test(hint)) return hit(cls, 'label~' + re.source.slice(0, 32));
    }
  }

  // A date input next to a birth-related label is a DOB; a bare date input is not.
  if (f.type === 'date' && /birth|\bdob\b|born/.test(hint)) return hit('DOB', 'date+birth-label');

  // A numeric-mode field labelled like a code, after the OTP label rule missed.
  if (f.inputMode === 'numeric' && /\bcode\b/.test(hint)) return hit('OTP', 'inputmode+code-label');

  return null;
}

/**
 * Site sensitivity. A government or banking origin raises the whole page's policy pack
 * before any field is even looked at.
 */
export type SitePack = 'gov' | 'bank' | 'health' | 'default';

const GOV_SUFFIXES = ['.gov.in', '.nic.in', '.gov', '.gov.uk'];
const BANK_HINTS = /(^|\.)(hdfc|icici|axis|sbi|kotak|yesbank|pnb|bankofbaroda|paytm|phonepe|razorpay|stripe|paypal)\./;
const HEALTH_HINTS = /(^|\.)(apollo|fortis|maxhealthcare|practo|abdm|nha)\.|\bhospital\b|\bclinic\b/;

export function sitePackFor(hostname: string): SitePack {
  const host = hostname.toLowerCase();
  if (GOV_SUFFIXES.some((s) => host.endsWith(s))) return 'gov';
  if (BANK_HINTS.test(host)) return 'bank';
  if (HEALTH_HINTS.test(host)) return 'health';
  return 'default';
}

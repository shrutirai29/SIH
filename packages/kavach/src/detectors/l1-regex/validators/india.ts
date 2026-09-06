/**
 * Structural validators for the Indian identifier pack.
 * Format checks plus real check digits where the scheme defines one.
 */

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** PAN 4th character encodes the holder type; anything else is not a real PAN. */
const PAN_ENTITY_CODES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

export function isValidPan(input: string): boolean {
  const s = input.toUpperCase().trim();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s)) return false;
  const entity = s[3];
  return entity !== undefined && PAN_ENTITY_CODES.has(entity);
}

/**
 * GSTIN: 15 chars = 2-digit state code + 10-char PAN + entity digit + 'Z' + check char.
 * Check character is a base-36 weighted mod-36 sum over the first 14 characters.
 */
export function isValidGstin(input: string): boolean {
  const s = input.toUpperCase().trim();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(s)) return false;

  const stateCode = Number.parseInt(s.slice(0, 2), 10);
  if (stateCode < 1 || stateCode > 38) return false;

  if (!isValidPan(s.slice(2, 12))) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const ch = s[i];
    if (ch === undefined) return false;
    const value = BASE36.indexOf(ch);
    if (value < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = BASE36[(36 - (sum % 36)) % 36];
  return expected !== undefined && expected === s[14];
}

/** IFSC: 4-letter bank code, mandatory '0' at position 5, 6-char branch code. */
export function isValidIfsc(input: string): boolean {
  const s = input.toUpperCase().trim();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s);
}

/**
 * UPI VPA. Deliberately conservative: the handle must not look like an email TLD,
 * otherwise every address on the page becomes a false VPA. The NPCI handle
 * allowlist is ticket D4; this is the shape check that precedes it.
 */
const EMAILISH_TLDS = new Set(['com', 'org', 'net', 'in', 'co', 'io', 'edu', 'gov', 'info', 'dev']);

export function isValidUpiVpa(input: string): boolean {
  const s = input.toLowerCase().trim();
  if (!/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/.test(s)) return false;
  const handle = s.slice(s.indexOf('@') + 1);
  return !EMAILISH_TLDS.has(handle);
}

/** Voter ID (EPIC): 3 letters + 7 digits. */
export function isValidVoterId(input: string): boolean {
  return /^[A-Z]{3}[0-9]{7}$/.test(input.toUpperCase().trim());
}

/** Indian passport: one letter excluding Q/X/Z, then 7 digits. */
export function isValidPassportIn(input: string): boolean {
  return /^[A-PR-WY][0-9]{7}$/.test(input.toUpperCase().trim());
}

/** Indian mobile: optional +91, then a 10-digit number starting 6-9. */
export function isValidPhoneIn(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  return /^(?:\+?91)?[6-9][0-9]{9}$/.test(compact);
}

/** ABHA / health ID: 14 digits, commonly hyphenated 2-4-4-4. */
export function isValidAbha(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  return /^[0-9]{14}$/.test(compact);
}

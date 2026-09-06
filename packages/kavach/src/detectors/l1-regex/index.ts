/**
 * KAVACH Layer 1 — regex + checksum detection.
 *
 * Every pattern that has a real check digit carries its validator here. That pairing
 * is the whole point: validated regex is a near-deterministic detector at ~3ms, where
 * bare regex is a noisy heuristic. See SOLUTION-SPACE.md Branch 3.
 *
 * This pack is the canonical one. `server/app/guards/ingress_pii.py` mirrors it and a
 * CI parity test keeps the two identical (ticket F4) - without that, the ingress guard
 * silently stops being an independent check.
 */

import type { PiiClass } from '../../classes.js';
import {
  isValidAadhaar,
  isValidAbha,
  isValidCardNumber,
  isValidGstin,
  isValidIfsc,
  isValidImei,
  isValidPan,
  isValidPassportIn,
  isValidPhoneIn,
  isValidUpiVpa,
  isValidVoterId,
} from './validators/index.js';

/**
 * The classes L1 can find by pattern. A strict subset of the full taxonomy in
 * `classes.ts`, which is the single source of truth — contextual classes need NER and
 * visual classes need pixels, so neither can appear here.
 */
export type L1Class = Extract<
  PiiClass,
  | 'AADHAAR' | 'PAN' | 'GSTIN' | 'IFSC' | 'UPI_VPA' | 'ABHA'
  | 'VOTER_ID' | 'PASSPORT_IN' | 'PHONE_IN'
  | 'CARD_NUMBER' | 'IMEI'
  | 'EMAIL' | 'IP'
  | 'JWT' | 'API_KEY' | 'PRIVATE_KEY'
>;

export interface PiiPattern {
  readonly cls: L1Class;
  readonly re: RegExp;
  /** Rejects the match when the scheme defines a check digit or structural rule. */
  readonly validate?: (raw: string) => boolean;
  /** Detection confidence when the validator passes (or when there is none). */
  readonly confidence: number;
}

export interface PiiMatch {
  readonly cls: L1Class;
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly confidence: number;
}

/** Shannon entropy in bits per character. Used to gate the generic secret detector. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * The pack. Order matters only for readability - `scanText` returns all matches and
 * fusion (ticket D7) resolves overlaps by the sensitivity lattice.
 *
 * Every regex is written with the `g` flag; `scanText` clones before use so these
 * module-level objects never carry `lastIndex` state between calls.
 */
export const L1_PATTERNS: readonly PiiPattern[] = [
  // --- India pack (checksum-validated where the scheme defines one) --------------
  { cls: 'AADHAAR', re: /\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g, validate: isValidAadhaar, confidence: 0.99 },
  { cls: 'GSTIN', re: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g, validate: isValidGstin, confidence: 0.99 },
  { cls: 'PAN', re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, validate: isValidPan, confidence: 0.97 },
  { cls: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, validate: isValidIfsc, confidence: 0.95 },
  // The trailing lookahead is load-bearing: without it `asha@example.com` matches as
  // far as `asha@example`, and `example` is not in the TLD denylist, so every ordinary
  // email on the page would be reported as a payment address.
  {
    cls: 'UPI_VPA',
    re: /\b[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}\b(?!\.[a-zA-Z])/g,
    validate: isValidUpiVpa,
    confidence: 0.9,
  },
  { cls: 'ABHA', re: /\b[0-9]{2}-[0-9]{4}-[0-9]{4}-[0-9]{4}\b/g, validate: isValidAbha, confidence: 0.95 },
  { cls: 'VOTER_ID', re: /\b[A-Z]{3}[0-9]{7}\b/g, validate: isValidVoterId, confidence: 0.9 },
  { cls: 'PASSPORT_IN', re: /\b[A-PR-WY][0-9]{7}\b/g, validate: isValidPassportIn, confidence: 0.85 },
  { cls: 'PHONE_IN', re: /(?:\+?91[\s-]?)?\b[6-9][0-9]{9}\b/g, validate: isValidPhoneIn, confidence: 0.9 },

  // --- Global -------------------------------------------------------------------
  { cls: 'CARD_NUMBER', re: /\b(?:[0-9][ -]?){13,19}\b/g, validate: isValidCardNumber, confidence: 0.98 },
  { cls: 'IMEI', re: /\b[0-9]{15}\b/g, validate: isValidImei, confidence: 0.9 },
  { cls: 'EMAIL', re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/g, confidence: 0.97 },
  { cls: 'IP', re: /\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b/g, confidence: 0.85 },

  // --- Secrets ------------------------------------------------------------------
  { cls: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, confidence: 0.99 },
  { cls: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, confidence: 1.0 },
  {
    cls: 'API_KEY',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    // Entropy gate keeps documentation placeholders like "sk-xxxxxxxxxxxxxxxx" out.
    validate: (raw) => shannonEntropy(raw) > 3.5,
    confidence: 0.95,
  },
];

/**
 * Runs the whole pack over `text`. Returns every validated match.
 *
 * Callers that care about precision should normalise first (`normalize/`), because
 * split text nodes and zero-width characters defeat every pattern here.
 */
export function scanText(text: string): PiiMatch[] {
  const out: PiiMatch[] = [];
  for (const pattern of L1_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      // Zero-length matches would spin forever; regexes here cannot produce them,
      // but the guard is cheap and this loop must never hang the content script.
      if (raw.length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const trimmed = raw.trim();
      if (pattern.validate !== undefined && !pattern.validate(trimmed)) continue;
      // The span must describe the value it reports. Trimming the value while keeping
      // the raw offsets makes `text.slice(start, end)` differ from `value`, which is a
      // trap for the next pattern added here: the redactor derives its substitution
      // span from these offsets and the vault stores this value, so a mismatch stores
      // one string and overwrites a different one. No live pattern can produce leading
      // whitespace today; this makes that a property of the code rather than luck.
      const lead = raw.length - raw.trimStart().length;
      out.push({
        cls: pattern.cls,
        start: m.index + lead,
        end: m.index + lead + trimmed.length,
        value: trimmed,
        confidence: pattern.confidence,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** True when the pack finds anything at all. The egress guard's hot path. */
export function containsPii(text: string): boolean {
  for (const pattern of L1_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (pattern.validate === undefined || pattern.validate(m[0].trim())) return true;
    }
  }
  return false;
}

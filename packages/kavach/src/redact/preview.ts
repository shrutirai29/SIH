/**
 * Display masks for the "what the server saw" viewer (ticket D16).
 *
 * ## The problem this solves
 *
 * The viewer has to show two things side by side: what was on the screen, and what
 * actually left the machine. The second half is easy — it is the exact transmitted
 * bytes. The first half is the hard one, because **the real values may not leave the
 * tab** (RULES.md P3), and the side panel is a different context.
 *
 * So the left-hand side shows a *shape-preserving mask*, not the value. The user sees
 * enough to recognise the field — the last four digits of their own Aadhaar, the
 * domain of their own email — and a screenshot of the demo cannot be mined for
 * anything. Credentials get no preview at all: they were never vaulted, their real
 * value was dropped at redaction time, and there is nothing to preview.
 *
 * ## Why a mask and not the real value
 *
 * It would be simpler to send the real value to the panel — it is the user's own data,
 * on the user's own machine, and this is not egress. We do not, for two reasons.
 * First, P3 is worth keeping absolute: "vault values never cross a message boundary"
 * has no exceptions to remember. Second, the demo is projected onto a wall, and a
 * privacy tool that shoulder-surfs its own user during the privacy demo would be
 * embarrassing in a way no slide could recover from.
 */

import { isCredential } from '../classes.js';

const DOT = '•';

/** Classes where the trailing characters are the useful, conventional identifier. */
const KEEP_LAST_4 = new Set([
  'AADHAAR',
  'CARD_NUMBER',
  'BANK_ACCOUNT',
  'PHONE_IN',
  'ABHA',
  'IMEI',
]);

/**
 * Zero dots for zero characters. Clamping to a minimum of one (as an earlier version
 * did) makes a one-character local part render as two, so the mask misstates the
 * shape it exists to preserve.
 */
function dots(n: number): string {
  return DOT.repeat(Math.max(n, 0));
}

/** Masks all but the last four characters, preserving spacing so the shape survives. */
function lastFour(value: string): string {
  const compact = value.replace(/\s/g, '');
  if (compact.length <= 4) return dots(compact.length);

  const tail = compact.slice(-4);
  const masked = dots(compact.length - 4) + tail;

  // Re-apply the original grouping so `2345 6789 0124` stays visually a 4-4-4.
  if (!value.includes(' ')) return masked;
  const groups: string[] = [];
  let i = 0;
  for (const part of value.split(/\s+/)) {
    groups.push(masked.slice(i, i + part.length));
    i += part.length;
  }
  return groups.join(' ');
}

/** `asha.patil@example.com` becomes `a•••••••••@e••••••.com`. */
function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return dots(value.length);

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');

  const maskedLocal = (local[0] ?? '') + dots(local.length - 1);
  if (dot <= 0) return maskedLocal + '@' + dots(domain.length);

  const host = domain.slice(0, dot);
  const tld = domain.slice(dot); // includes the dot
  return maskedLocal + '@' + (host[0] ?? '') + dots(host.length - 1) + tld;
}

/** `Asha Ramesh Patil` becomes `A••• R••••• P••••`. */
function maskName(value: string): string {
  return value
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => (w[0] ?? '') + dots(w.length - 1))
    .join(' ');
}

/** Keeps the structural prefix that makes the class recognisable. */
function maskStructured(value: string, keepPrefix: number): string {
  if (value.length <= keepPrefix) return dots(value.length);
  return value.slice(0, keepPrefix) + dots(value.length - keepPrefix);
}

/**
 * Produces the preview shown on the left-hand side of the diff.
 *
 * Returns null for anything whose real value must never be reconstructed even
 * approximately — the caller renders "(never stored)" for those.
 */
export function maskForDisplay(value: string, cls: string): string | null {
  if (value.length === 0) return null;

  // RULES.md P4: credentials are dropped at redaction time. There is no value to
  // preview, and inventing a plausible-looking one would be a lie.
  if (isCredential(cls)) return null;

  if (cls === 'EMAIL') return maskEmail(value);
  if (cls === 'PERSON_NAME') return maskName(value);
  if (cls === 'ADDRESS') {
    // Keep the shape of a multi-line address without any of its content.
    return maskName(value).slice(0, 60);
  }
  if (KEEP_LAST_4.has(cls)) return lastFour(value);

  // PAN, GSTIN, IFSC, VOTER_ID, PASSPORT: the leading characters are a bank or state
  // code, not identity, and keeping them makes the class legible at a glance.
  if (cls === 'IFSC') return maskStructured(value, 4);
  if (cls === 'PAN' || cls === 'GSTIN' || cls === 'VOTER_ID') return maskStructured(value, 2);
  if (cls === 'UPI_VPA') {
    const at = value.indexOf('@');
    return at <= 0 ? dots(value.length) : dots(at) + value.slice(at);
  }
  if (cls === 'DOB') return maskStructured(value, 0);

  return dots(Math.min(value.length, 24));
}

/**
 * One row of the diff: what was on the screen, and what the server received in its
 * place. Contains no recoverable value, so it is safe to send to the side panel.
 */
export interface DiffRow {
  /** SSG element the redaction happened in. */
  readonly elementId: string;
  /** Accessible name of that element, already redacted. */
  readonly label: string;
  readonly cls: string;
  /** Shape-preserving mask, or null for anything never stored. */
  readonly preview: string | null;
  /** What the server got instead. */
  readonly token: string;
  /** Which detectors fired, for "explain this redaction". */
  readonly sources: readonly string[];
  readonly confidence: number;
  /** False for credentials: the client itself cannot resolve these. */
  readonly reversible: boolean;
}

/**
 * The placeholder grammar shared by client and server (SETU contract).
 *
 * A token is an opaque, typed, coreferent *reference* to a real value that never
 * left the user's machine. Format: U+27E6 CLASS _ N U+27E7, e.g. the Aadhaar token
 * for the first distinct Aadhaar seen this session.
 *
 * The bracket characters are U+27E6/U+27E7 (mathematical white square brackets),
 * chosen because they essentially never occur in real page text and survive JSON,
 * UTF-8, and tokenisers intact (RULES.md sec 5, Naming).
 *
 * This module is pure grammar: no crypto, no state. Ordinal allocation and the
 * value binding live in `@prahari/kavach`'s vault, which is the only decoder.
 */

export const TOKEN_OPEN = '\u27e6';
export const TOKEN_CLOSE = '\u27e7';

/** Matches exactly one token and nothing else. */
export const TOKEN_RE = /^\u27e6([A-Z][A-Z0-9_]*)_([0-9]+)\u27e7$/;

/** Finds tokens anywhere inside a larger string. Global — clone before stateful use. */
export const TOKEN_SCAN_RE = /\u27e6([A-Z][A-Z0-9_]*)_([0-9]+)\u27e7/g;

export interface ParsedToken {
  readonly cls: string;
  readonly ordinal: number;
  readonly token: string;
}

/** Builds the canonical token string for a class and ordinal. */
export function formatToken(cls: string, ordinal: number): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(cls)) {
    throw new Error(`invalid token class: ${cls}`);
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`invalid token ordinal: ${String(ordinal)}`);
  }
  return `${TOKEN_OPEN}${cls}_${ordinal}${TOKEN_CLOSE}`;
}

/** Parses a string that must be exactly one token. Returns null if it is not. */
export function parseToken(s: string): ParsedToken | null {
  const m = TOKEN_RE.exec(s);
  if (m === null) return null;
  const cls = m[1];
  const ord = m[2];
  if (cls === undefined || ord === undefined) return null;
  return { cls, ordinal: Number.parseInt(ord, 10), token: s };
}

/** True when the whole string is a single well-formed token. */
export function isToken(s: string): boolean {
  return TOKEN_RE.test(s);
}

/** Extracts every token occurring inside `s`, in order of appearance. */
export function findTokens(s: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  const re = new RegExp(TOKEN_SCAN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const cls = m[1];
    const ord = m[2];
    if (cls === undefined || ord === undefined) continue;
    out.push({ cls, ordinal: Number.parseInt(ord, 10), token: m[0] });
  }
  return out;
}

/**
 * Neutralises the token brackets in text that came from the page.
 *
 * ## Why this exists
 *
 * A token is a *reference minted by the vault*. Nothing else may look like one. But
 * `⟦` and `⟧` are ordinary Unicode characters, so a hostile page can simply write
 * `⟦AADHAAR_1⟧` into its own text. That text is harvested, survives redaction (there
 * is no PII in it to detect), and lands in the SSG — where the planner cannot tell it
 * from a real reference minted by this session.
 *
 * The vault refuses to resolve a token it never issued, so nothing leaks. But the
 * planner can still be *steered* by fabricated references, which is a planning-
 * integrity attack in the same family as the S-05 injection. Folding the brackets to
 * their fullwidth lookalikes makes forgery impossible at the point of entry.
 *
 * The substitution is strictly one character for one character, so every offset a
 * caller has already computed over the string stays valid — which is what lets the
 * redactor apply this before detection without disturbing its offset map.
 */
const OPEN_LOOKALIKE = '［'; // ［ FULLWIDTH LEFT SQUARE BRACKET
const CLOSE_LOOKALIKE = '］'; // ］ FULLWIDTH RIGHT SQUARE BRACKET

export function neutralizeTokens(s: string): string {
  if (!s.includes(TOKEN_OPEN) && !s.includes(TOKEN_CLOSE)) return s;
  return s.split(TOKEN_OPEN).join(OPEN_LOOKALIKE).split(TOKEN_CLOSE).join(CLOSE_LOOKALIKE);
}

/**
 * True when `s` contains any bracket character. Used by the egress guard to catch
 * half-written tokens, which would mean the redactor produced malformed output.
 */
export function hasMalformedToken(s: string): boolean {
  const opens = (s.match(/\u27e6/g) ?? []).length;
  const closes = (s.match(/\u27e7/g) ?? []).length;
  if (opens !== closes) return true;
  const wellFormed = (s.match(new RegExp(TOKEN_SCAN_RE.source, 'g')) ?? []).length;
  return wellFormed !== opens;
}

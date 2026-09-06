/**
 * Verhoeff checksum — the validator that makes the Aadhaar detector precise.
 *
 * A bare 12-digit regex flags every invoice and order number on the page. Verhoeff
 * rejects ~90% of coincidental 12-digit matches, which is what lets L1 run
 * aggressively without drowning the SSG in false positives (SOLUTION-SPACE.md,
 * Branch 3, "the checksum insight").
 */

/** Dihedral group D5 multiplication table. */
const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Permutation table, applied as P[pos % 8]. */
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Multiplicative inverse in D5. */
const INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function digitsOf(s: string): number[] | null {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 48;
    if (code < 0 || code > 9) return null;
    out.push(code);
  }
  return out;
}

/** Validates a digit string whose final digit is its Verhoeff check digit. */
export function verhoeffValidate(input: string): boolean {
  const digits = digitsOf(input);
  if (digits === null || digits.length === 0) return false;

  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const d = reversed[i];
    const p = P[i % 8];
    if (d === undefined || p === undefined) return false;
    const permuted = p[d];
    const row = D[c];
    if (permuted === undefined || row === undefined) return false;
    const next = row[permuted];
    if (next === undefined) return false;
    c = next;
  }
  return c === 0;
}

/** Computes the Verhoeff check digit for a payload that does not yet carry one. */
export function verhoeffChecksum(payload: string): number {
  const digits = digitsOf(payload);
  if (digits === null) throw new Error('verhoeffChecksum: non-digit input');

  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const d = reversed[i];
    const p = P[(i + 1) % 8];
    if (d === undefined || p === undefined) throw new Error('verhoeffChecksum: table miss');
    const permuted = p[d];
    const row = D[c];
    if (permuted === undefined || row === undefined) throw new Error('verhoeffChecksum: table miss');
    const next = row[permuted];
    if (next === undefined) throw new Error('verhoeffChecksum: table miss');
    c = next;
  }
  const inv = INV[c];
  if (inv === undefined) throw new Error('verhoeffChecksum: inverse miss');
  return inv;
}

/**
 * Aadhaar-specific validation: exactly 12 digits, must not start with 0 or 1
 * (UIDAI never issues those), and the Verhoeff check digit must hold.
 */
export function isValidAadhaar(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  if (!/^[2-9][0-9]{11}$/.test(compact)) return false;
  return verhoeffValidate(compact);
}

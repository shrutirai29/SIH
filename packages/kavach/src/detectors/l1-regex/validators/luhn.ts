/**
 * Luhn (mod-10) checksum — used for payment card numbers and IMEI.
 * Same role as Verhoeff for Aadhaar: turns a noisy digit-run regex into a
 * near-deterministic detector.
 */

export function luhnValidate(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  if (!/^[0-9]{2,}$/.test(compact)) return false;

  let sum = 0;
  let double = false;
  for (let i = compact.length - 1; i >= 0; i--) {
    const ch = compact[i];
    if (ch === undefined) return false;
    let d = ch.charCodeAt(0) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Payment card: 13-19 digits and Luhn-valid. IIN range table is ticket D4. */
export function isValidCardNumber(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  if (!/^[0-9]{13,19}$/.test(compact)) return false;
  return luhnValidate(compact);
}

/** IMEI: exactly 15 digits, Luhn-valid. */
export function isValidImei(input: string): boolean {
  const compact = input.replace(/[\s-]/g, '');
  if (!/^[0-9]{15}$/.test(compact)) return false;
  return luhnValidate(compact);
}

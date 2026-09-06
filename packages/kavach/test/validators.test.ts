import { describe, expect, it } from 'vitest';
import {
  isValidAadhaar,
  isValidCardNumber,
  isValidGstin,
  isValidIfsc,
  isValidImei,
  isValidPan,
  isValidPassportIn,
  isValidPhoneIn,
  isValidUpiVpa,
  isValidVoterId,
  luhnValidate,
  verhoeffChecksum,
  verhoeffValidate,
} from '../src/detectors/l1-regex/validators/index.js';

describe('verhoeff', () => {
  it('accepts the documented check-digit vectors', () => {
    // Verhoeff's defining published examples.
    expect(verhoeffChecksum('236')).toBe(3);
    expect(verhoeffValidate('2363')).toBe(true);
    expect(verhoeffChecksum('12345')).toBe(1);
    expect(verhoeffValidate('123451')).toBe(true);
  });

  it('round-trips checksum then validate for arbitrary payloads', () => {
    for (let n = 0; n < 500; n++) {
      const payload = String(n * 7919).padStart(11, '0').slice(0, 11);
      const full = payload + String(verhoeffChecksum(payload));
      expect(verhoeffValidate(full)).toBe(true);
    }
  });

  it('catches every single-digit error (the property Verhoeff exists for)', () => {
    const payload = '23456789012';
    const valid = payload + String(verhoeffChecksum(payload));
    for (let pos = 0; pos < valid.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        const digit = String(d);
        if (valid[pos] === digit) continue;
        const corrupted = valid.slice(0, pos) + digit + valid.slice(pos + 1);
        expect(verhoeffValidate(corrupted), `pos ${pos} -> ${digit}`).toBe(false);
      }
    }
  });

  it('catches adjacent transpositions', () => {
    const payload = '23456789012';
    const valid = payload + String(verhoeffChecksum(payload));
    for (let i = 0; i < valid.length - 1; i++) {
      const a = valid[i];
      const b = valid[i + 1];
      if (a === b) continue;
      const swapped = valid.slice(0, i) + String(b) + String(a) + valid.slice(i + 2);
      expect(verhoeffValidate(swapped), `swap at ${i}`).toBe(false);
    }
  });

  it('rejects non-digit and empty input', () => {
    expect(verhoeffValidate('')).toBe(false);
    expect(verhoeffValidate('12a45')).toBe(false);
    expect(() => verhoeffChecksum('12a')).toThrow();
  });
});

describe('isValidAadhaar', () => {
  const valid = '234567890124';

  it('accepts a Verhoeff-valid 12-digit number', () => {
    const payload = '23456789012';
    const real = payload + String(verhoeffChecksum(payload));
    expect(isValidAadhaar(real)).toBe(true);
    expect(isValidAadhaar(real.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3'))).toBe(true);
    expect(isValidAadhaar(real.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3'))).toBe(true);
  });

  it('rejects numbers starting 0 or 1 (UIDAI never issues them)', () => {
    const payload = '03456789012';
    expect(isValidAadhaar(payload + String(verhoeffChecksum(payload)))).toBe(false);
  });

  it('rejects a 12-digit number that fails the checksum', () => {
    // This is the false-positive class a bare regex would flag: an order number.
    expect(isValidAadhaar('234567890123')).toBe(false);
    expect(valid.length).toBe(12);
  });

  it('rejects wrong lengths', () => {
    expect(isValidAadhaar('23456789')).toBe(false);
    expect(isValidAadhaar('2345678901234')).toBe(false);
  });
});

describe('luhn', () => {
  it('accepts published test numbers', () => {
    expect(luhnValidate('79927398713')).toBe(true);
    expect(isValidCardNumber('4111111111111111')).toBe(true);
    expect(isValidCardNumber('5500 0055 5555 5559')).toBe(true);
    expect(isValidCardNumber('4111-1111-1111-1111')).toBe(true);
  });

  it('rejects a near-miss', () => {
    expect(luhnValidate('79927398710')).toBe(false);
    expect(isValidCardNumber('4111111111111112')).toBe(false);
  });

  it('enforces card length bounds', () => {
    expect(isValidCardNumber('411111111111')).toBe(false);
    expect(isValidCardNumber('41111111111111111111')).toBe(false);
  });

  it('validates IMEI as exactly 15 Luhn digits', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(luhnValidate('abcd')).toBe(false);
    expect(luhnValidate('')).toBe(false);
  });
});

describe('india structural validators', () => {
  it('validates PAN including the entity-type character', () => {
    expect(isValidPan('ABCPE1234F')).toBe(true);
    expect(isValidPan('abcpe1234f')).toBe(true);
    // 4th char 'Z' is not a real entity code.
    expect(isValidPan('ABCZE1234F')).toBe(false);
    expect(isValidPan('ABC1E1234F')).toBe(false);
    expect(isValidPan('ABCPE1234')).toBe(false);
  });

  it('validates IFSC shape with the mandatory zero', () => {
    expect(isValidIfsc('HDFC0001234')).toBe(true);
    expect(isValidIfsc('SBIN0000456')).toBe(true);
    // 5th character must be 0.
    expect(isValidIfsc('HDFC1001234')).toBe(false);
    expect(isValidIfsc('HDF0001234')).toBe(false);
  });

  it('rejects an email-looking string as a UPI VPA', () => {
    expect(isValidUpiVpa('ravi@okhdfcbank')).toBe(true);
    expect(isValidUpiVpa('ravi@ybl')).toBe(true);
    // The precision fix: an ordinary email must not become a VPA.
    expect(isValidUpiVpa('ravi@gmail.com')).toBe(false);
    expect(isValidUpiVpa('ravi@com')).toBe(false);
  });

  it('validates voter id and passport shapes', () => {
    expect(isValidVoterId('ABC1234567')).toBe(true);
    expect(isValidVoterId('AB12345678')).toBe(false);
    expect(isValidPassportIn('A1234567')).toBe(true);
    // Q, X and Z are not issued as the leading letter.
    expect(isValidPassportIn('Q1234567')).toBe(false);
    expect(isValidPassportIn('Z1234567')).toBe(false);
  });

  it('validates Indian mobile numbers', () => {
    expect(isValidPhoneIn('9876543210')).toBe(true);
    expect(isValidPhoneIn('+91 98765 43210')).toBe(true);
    expect(isValidPhoneIn('919876543210')).toBe(true);
    // Indian mobile numbers never start below 6.
    expect(isValidPhoneIn('5876543210')).toBe(false);
    expect(isValidPhoneIn('98765432')).toBe(false);
  });

  it('validates GSTIN state code, embedded PAN and check character', () => {
    // Built from a valid PAN so only the check character is under test.
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    // Corrupting the check character must fail.
    expect(isValidGstin('27AAPFU0939F1ZA')).toBe(false);
    // State code 99 does not exist.
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1XV')).toBe(false);
  });
});

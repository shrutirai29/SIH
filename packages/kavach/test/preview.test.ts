import { describe, expect, it } from 'vitest';
import { maskForDisplay } from '../src/redact/preview.js';

describe('display masks keep shape and drop identity', () => {
  it('keeps the last four of an Aadhaar, with its grouping', () => {
    expect(maskForDisplay('2345 6789 0124', 'AADHAAR')).toBe('•••• •••• 0124');
    expect(maskForDisplay('234567890124', 'AADHAAR')).toBe('••••••••0124');
  });

  it('keeps the last four of a card number', () => {
    expect(maskForDisplay('4111 1111 1111 1111', 'CARD_NUMBER')).toBe('•••• •••• •••• 1111');
  });

  it('keeps the domain shape of an email but not the address', () => {
    const masked = maskForDisplay('asha.patil@example.com', 'EMAIL');
    expect(masked).toBe('a•••••••••@e••••••.com');
    expect(masked).not.toContain('asha');
    expect(masked).not.toContain('patil');
    expect(masked).not.toContain('example');
  });

  it('keeps initials of a name and nothing else', () => {
    const masked = maskForDisplay('Asha Ramesh Patil', 'PERSON_NAME');
    expect(masked).toBe('A••• R••••• P••••');
    expect(masked).not.toContain('sha');
  });

  it('keeps the bank code of an IFSC, which is not identity', () => {
    expect(maskForDisplay('HDFC0001234', 'IFSC')).toBe('HDFC•••••••');
  });

  it('keeps the handle of a UPI VPA but not the user part', () => {
    const masked = maskForDisplay('asha.patil@okhdfcbank', 'UPI_VPA');
    expect(masked).toBe('••••••••••@okhdfcbank');
    expect(masked).not.toContain('asha');
  });

  it('keeps the state code of a PAN', () => {
    expect(maskForDisplay('ABCPE1234F', 'PAN')).toBe('AB••••••••');
  });

  it('reveals nothing at all about a date of birth', () => {
    const masked = maskForDisplay('1992-04-17', 'DOB');
    expect(masked).not.toContain('1992');
    expect(masked).not.toContain('04');
  });
});

describe('credentials have no preview, because they have no stored value', () => {
  for (const cls of ['PASSWORD', 'OTP', 'CVV', 'API_KEY', 'JWT', 'PRIVATE_KEY']) {
    it('returns null for ' + cls, () => {
      expect(maskForDisplay('hunter2-very-secret', cls)).toBeNull();
    });
  }
});

describe('a mask never leaks more than it should', () => {
  const cases: [string, string][] = [
    ['2345 6789 0124', 'AADHAAR'],
    ['ABCPE1234F', 'PAN'],
    ['9876543210', 'PHONE_IN'],
    ['asha.patil@example.com', 'EMAIL'],
    ['Asha Ramesh Patil', 'PERSON_NAME'],
    ['Plot 14, Shivaji Nagar, Pune 411005', 'ADDRESS'],
    ['50100234567890', 'BANK_ACCOUNT'],
  ];

  for (const [value, cls] of cases) {
    it('never reproduces the whole ' + cls, () => {
      const masked = maskForDisplay(value, cls);
      expect(masked).not.toBe(value);
      expect(masked).not.toBeNull();
      // At most the last four characters may survive contiguously.
      const compact = value.replace(/\s/g, '');
      if (compact.length > 8) {
        expect(masked).not.toContain(compact.slice(0, 5));
      }
    });
  }

  it('handles empty and short values without throwing', () => {
    expect(maskForDisplay('', 'AADHAAR')).toBeNull();
    expect(maskForDisplay('ab', 'AADHAAR')).toBe('••');
    expect(maskForDisplay('a@b', 'EMAIL')).toBe('a@•');
  });

  it('masks an unknown class conservatively rather than passing it through', () => {
    const masked = maskForDisplay('something-identifying', 'SOME_NEW_CLASS');
    // Unknown classes group as credential, so they get no preview at all.
    expect(masked).toBeNull();
  });
});

/**
 * Detector recall against the demo portal.
 *
 * This is the first row of what becomes the accuracy harness (ticket H7). It runs the
 * L1 pack over the page the demo is built on and asserts every planted identifier is
 * found. If someone weakens a pattern, this fails before the demo does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanText, type L1Class } from '../src/detectors/l1-regex/index.js';
import { normalizeForDetection } from '../src/normalize/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  resolve(here, '../../eval/fixtures/demo-portal.html'),
  'utf8',
);

function classesIn(text: string): Set<L1Class> {
  return new Set(scanText(text).map((m) => m.cls));
}

describe('demo portal: every planted identifier is detected', () => {
  const found = classesIn(html);

  const expected: L1Class[] = [
    'AADHAAR',
    'PAN',
    'PHONE_IN',
    'EMAIL',
    'IFSC',
    'UPI_VPA',
  ];

  for (const cls of expected) {
    it('finds ' + cls, () => {
      expect(found.has(cls)).toBe(true);
    });
  }

  it('finds the Aadhaar in the declaration prose, not just the form field', () => {
    const prose =
      'I consent to verification of my Aadhaar 2345 6789 0124 against the UIDAI database';
    const hits = scanText(normalizeForDetection(prose).text);
    expect(hits.some((h) => h.cls === 'AADHAAR')).toBe(true);
  });

  it('does not classify the ordinary email as a UPI VPA', () => {
    const hits = scanText('asha.patil@example.com');
    expect(hits.some((h) => h.cls === 'EMAIL')).toBe(true);
    expect(hits.some((h) => h.cls === 'UPI_VPA')).toBe(false);
  });

  it('does classify the bank handle as a UPI VPA', () => {
    const hits = scanText('asha.patil@okhdfcbank');
    expect(hits.some((h) => h.cls === 'UPI_VPA')).toBe(true);
  });
});

describe('evasion: normalisation is what makes the detectors work on real pages', () => {
  it('catches an Aadhaar split by zero-width spaces', () => {
    const split = '2345​6789​0124';
    expect(classesIn(split).has('AADHAAR')).toBe(false);
    expect(classesIn(normalizeForDetection(split).text).has('AADHAAR')).toBe(true);
  });

  it('catches an Aadhaar written with hyphen separators', () => {
    const hyphenated = '2345-6789-0124';
    expect(classesIn(normalizeForDetection(hyphenated).text).has('AADHAAR')).toBe(true);
  });

  it('catches a PAN written with a Cyrillic lookalike letter', () => {
    // U+0410 CYRILLIC CAPITAL A in place of Latin A.
    const homoglyph = 'АBCPE1234F';
    expect(classesIn(homoglyph).has('PAN')).toBe(false);
    expect(classesIn(normalizeForDetection(homoglyph).text).has('PAN')).toBe(true);
  });

  it('catches fullwidth digits', () => {
    const fullwidth = '２３４５ 6789 0124';
    expect(classesIn(normalizeForDetection(fullwidth).text).has('AADHAAR')).toBe(true);
  });
});

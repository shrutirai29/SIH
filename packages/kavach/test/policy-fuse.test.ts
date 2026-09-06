import { describe, expect, it } from 'vitest';
import { groupOf, isCredential, mostSensitive, rankOf } from '../src/classes.js';
import { classifyField, sitePackFor } from '../src/detectors/l0-dom-rules.js';
import { coverageConfidence, fuse, noisyOr, type Detection } from '../src/fuse.js';
import { resolvePolicy } from '../src/policy/index.js';

describe('sensitivity lattice', () => {
  it('orders groups so credentials always win', () => {
    expect(rankOf('PASSWORD')).toBeLessThan(rankOf('AADHAAR'));
    expect(rankOf('AADHAAR')).toBeLessThan(rankOf('CARD_NUMBER'));
    expect(rankOf('CARD_NUMBER')).toBeLessThan(rankOf('EMAIL'));
    expect(rankOf('EMAIL')).toBeLessThan(rankOf('PERSON_NAME'));
  });

  it('resolves a conflict toward the more sensitive class', () => {
    expect(mostSensitive('EMAIL', 'AADHAAR')).toBe('AADHAAR');
    expect(mostSensitive('AADHAAR', 'PASSWORD')).toBe('PASSWORD');
    expect(mostSensitive('PERSON_NAME', 'CARD_NUMBER')).toBe('CARD_NUMBER');
  });

  it('treats an unknown class as maximally sensitive, not as "other"', () => {
    // Fail-closed applies to taxonomy gaps: a class nobody classified could be anything.
    expect(groupOf('SOME_NEW_THING')).toBe('credential');
    expect(isCredential('SOME_NEW_THING')).toBe(true);
  });
});

describe('L0 DOM rules', () => {
  it('recognises a password field with certainty', () => {
    const hit = classifyField({ type: 'password' });
    expect(hit?.cls).toBe('PASSWORD');
    expect(hit?.confidence).toBe(1);
  });

  it('reads autocomplete tokens including section prefixes', () => {
    expect(classifyField({ type: 'text', autocomplete: 'one-time-code' })?.cls).toBe('OTP');
    expect(classifyField({ type: 'text', autocomplete: 'cc-csc' })?.cls).toBe('CVV');
    expect(classifyField({ type: 'text', autocomplete: 'shipping street-address' })?.cls).toBe(
      'ADDRESS',
    );
    expect(classifyField({ type: 'text', autocomplete: 'section-a billing tel' })?.cls).toBe(
      'PHONE_IN',
    );
  });

  it('recognises Indian identifiers from labels', () => {
    expect(classifyField({ type: 'text', label: 'Aadhaar Number' })?.cls).toBe('AADHAAR');
    expect(classifyField({ type: 'text', name: 'gstin' })?.cls).toBe('GSTIN');
    expect(classifyField({ type: 'text', placeholder: 'Enter IFSC code' })?.cls).toBe('IFSC');
    expect(classifyField({ type: 'text', ariaLabel: 'UPI ID' })?.cls).toBe('UPI_VPA');
    expect(classifyField({ type: 'text', label: 'PAN' })?.cls).toBe('PAN');
    expect(classifyField({ type: 'text', label: 'ABHA / Health ID' })?.cls).toBe('ABHA');
  });

  it('does not fire on ordinary fields', () => {
    expect(classifyField({ type: 'text', name: 'search' })).toBeNull();
    expect(classifyField({ type: 'text', label: 'Quantity' })).toBeNull();
    expect(classifyField({ type: 'checkbox', name: 'agree' })).toBeNull();
    // A bare date field is not a birthday.
    expect(classifyField({ type: 'date', label: 'Delivery date' })).toBeNull();
  });

  it('distinguishes a birthday from a plain date by its label', () => {
    expect(classifyField({ type: 'date', label: 'Date of Birth' })?.cls).toBe('DOB');
  });

  it('classifies site sensitivity from the hostname', () => {
    expect(sitePackFor('pmkisan.gov.in')).toBe('gov');
    expect(sitePackFor('services.nic.in')).toBe('gov');
    expect(sitePackFor('netbanking.hdfc.com')).toBe('bank');
    expect(sitePackFor('www.example.com')).toBe('default');
  });
});

describe('fusion', () => {
  const at = (cls: string, start: number, end: number, confidence: number, source: Detection['source']): Detection =>
    ({ cls, start, end, confidence, source });

  it('combines independent confidences by noisy-OR', () => {
    expect(noisyOr([0.5, 0.5])).toBeCloseTo(0.75);
    expect(noisyOr([0.9, 0.9, 0.9])).toBeCloseTo(0.999);
    expect(noisyOr([])).toBe(0);
  });

  it('merges overlapping detections and keeps the more sensitive class', () => {
    const out = fuse([
      at('EMAIL', 10, 30, 0.9, 'l1-regex'),
      at('AADHAAR', 12, 28, 0.8, 'l2-ner'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.cls).toBe('AADHAAR');
    expect(out[0]?.corroborated).toBe(true);
  });

  it('takes the UNION of spans, never the intersection', () => {
    // A box two characters too small leaves a legible fragment of an identifier.
    const out = fuse([
      at('AADHAAR', 10, 20, 0.9, 'l1-regex'),
      at('AADHAAR', 14, 26, 0.7, 'l2-ner'),
    ]);
    expect(out[0]?.start).toBe(10);
    expect(out[0]?.end).toBe(26);
  });

  it('promotes corroborated deterministic agreement to certainty', () => {
    const out = fuse([
      at('AADHAAR', 0, 12, 0.99, 'l1-regex'),
      at('AADHAAR', 0, 12, 0.6, 'l2-ner'),
    ]);
    expect(out[0]?.confidence).toBe(1);
  });

  it('does not promote when no deterministic source agreed', () => {
    const out = fuse([
      at('PERSON_NAME', 0, 10, 0.6, 'l2-ner'),
      at('PERSON_NAME', 0, 10, 0.5, 'l4-vlm'),
    ]);
    expect(out[0]?.confidence).toBeLessThan(1);
    expect(out[0]?.confidence).toBeCloseTo(0.8);
  });

  it('keeps non-overlapping detections separate', () => {
    const out = fuse([
      at('EMAIL', 0, 10, 0.9, 'l1-regex'),
      at('PHONE_IN', 20, 30, 0.9, 'l1-regex'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('reports honest coverage when only L0/L1 are running', () => {
    // With no NER and no vision, contextual and visual PII are simply not covered.
    // Claiming high coverage here would be a lie the server would act on.
    const structuralOnly = coverageConfidence({
      detections: [],
      unexplainedPixelRatio: 0,
      timedOutDetectors: [],
      activeLayers: ['l0-dom', 'l1-regex'],
    });
    expect(structuralOnly).toBeLessThan(0.6);

    const full = coverageConfidence({
      detections: [],
      unexplainedPixelRatio: 0,
      timedOutDetectors: [],
      activeLayers: ['l0-dom', 'l1-regex', 'l2-ner', 'l3-vision'],
    });
    expect(full).toBeGreaterThan(0.9);
  });

  it('penalises coverage for timeouts and unexplained pixels', () => {
    const base = coverageConfidence({
      detections: [], unexplainedPixelRatio: 0, timedOutDetectors: [],
      activeLayers: ['l0-dom', 'l1-regex', 'l2-ner'],
    });
    const degraded = coverageConfidence({
      detections: [], unexplainedPixelRatio: 0.4, timedOutDetectors: ['gliner'],
      activeLayers: ['l0-dom', 'l1-regex', 'l2-ner'],
    });
    expect(degraded).toBeLessThan(base);
  });
});

describe('policy resolution', () => {
  const base = { sitePack: 'default' as const };

  it('never makes a credential reversible, whatever anyone asks', () => {
    const p = resolvePolicy('PASSWORD', {
      ...base,
      userClassOverrides: { PASSWORD: { reversible: true, confirmRequired: false } },
      elementOverride: { reversible: true, risk: 'safe' },
    });
    expect(p.reversible).toBe(false);
    expect(p.confirmRequired).toBe(true);
    expect(p.risk).toBe('high');
  });

  it('lets government IDs be reversible, with confirmation', () => {
    const p = resolvePolicy('AADHAAR', base);
    expect(p.reversible).toBe(true);
    expect(p.confirmRequired).toBe(true);
    expect(p.risk).toBe('high');
  });

  it('tightens on a government site', () => {
    const normal = resolvePolicy('EMAIL', base);
    const gov = resolvePolicy('EMAIL', { sitePack: 'gov' });
    expect(normal.confirmRequired).toBe(false);
    expect(gov.confirmRequired).toBe(true);
    expect(gov.risk).toBe('high');
  });

  it('allows an override to tighten but never to loosen', () => {
    const loosened = resolvePolicy('AADHAAR', {
      ...base,
      elementOverride: { reversible: true, risk: 'safe', confirmRequired: false },
    });
    expect(loosened.risk).toBe('high');
    expect(loosened.confirmRequired).toBe(true);

    const tightened = resolvePolicy('EMAIL', {
      ...base,
      elementOverride: { reversible: false, confirmRequired: true },
    });
    expect(tightened.reversible).toBe(false);
  });

  it('blacks out anything a detector could not verify (RULES.md P6)', () => {
    const p = resolvePolicy('EMAIL', { ...base, unverified: true });
    expect(p.action).toBe('BLACKOUT');
    expect(p.reversible).toBe(false);
    expect(p.risk).toBe('high');
  });

  it('strict mode makes nothing reversible', () => {
    const p = resolvePolicy('EMAIL', { ...base, privacyMode: 'strict' });
    expect(p.reversible).toBe(false);
    expect(p.confirmRequired).toBe(true);
  });
});

describe('fusion merges every group a detection bridges, not just the first', () => {
  it('collapses two groups joined by a span that overlaps both', () => {
    // A[0,10] and C[20,30] are disjoint, so they start as separate groups. B spans
    // both. Attaching B to whichever group it met first left two groups whose UNION
    // spans overlap — and the redactor plans one substitution per group, so it would
    // then write two tokens over the same characters. Right-to-left application turns
    // that into a half-written token: the exact MALFORMED_TOKEN case.
    const merged = fuse([
      { cls: 'EMAIL', start: 0, end: 10, confidence: 0.9, source: 'l1-regex' },
      { cls: 'PERSON_NAME', start: 20, end: 30, confidence: 0.8, source: 'l2-ner' },
      { cls: 'ADDRESS', start: 5, end: 25, confidence: 0.7, source: 'l2-ner' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.start).toBe(0);
    expect(merged[0]?.end).toBe(30);
    // Three independent detectors saw it, and one of them cannot be wrong about its
    // own classes, so the merged group is corroborated.
    expect(merged[0]?.corroborated).toBe(true);
    expect(merged[0]?.sources).toContain('l1-regex');
    expect(merged[0]?.sources).toContain('l2-ner');
  });

  it('produces spans that never overlap each other, whatever the input order', () => {
    const merged = fuse([
      { cls: 'ADDRESS', start: 5, end: 25, confidence: 0.7, source: 'l2-ner' },
      { cls: 'PERSON_NAME', start: 20, end: 30, confidence: 0.8, source: 'l2-ner' },
      { cls: 'EMAIL', start: 0, end: 10, confidence: 0.9, source: 'l1-regex' },
      { cls: 'PHONE_IN', start: 60, end: 70, confidence: 0.9, source: 'l1-regex' },
    ]).sort((a, b) => a.start - b.start);

    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1];
      const cur = merged[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      // The invariant the redactor depends on: disjoint spans, so substitutions
      // cannot collide.
      expect(cur!.start).toBeGreaterThanOrEqual(prev!.end);
    }
    expect(merged).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createStubDetector,
  mapLabel,
  spansToDetections,
  type NerSpan,
  L2_CLASSES,
} from '../src/detectors/l2-ner.js';

describe('L2 NER — label mapping', () => {
  it('maps standard GLiNER labels to PRAHARI classes', () => {
    expect(mapLabel('person')).toBe('PERSON_NAME');
    expect(mapLabel('name')).toBe('PERSON_NAME');
    expect(mapLabel('address')).toBe('ADDRESS');
    expect(mapLabel('location')).toBe('ADDRESS');
    expect(mapLabel('date_of_birth')).toBe('DOB');
    expect(mapLabel('age')).toBe('AGE');
    expect(mapLabel('gender')).toBe('GENDER');
    expect(mapLabel('health_condition')).toBe('HEALTH_CONDITION');
    expect(mapLabel('medication')).toBe('MEDICATION');
    expect(mapLabel('diagnosis')).toBe('DIAGNOSIS');
    expect(mapLabel('employer')).toBe('EMPLOYER');
    expect(mapLabel('organization')).toBe('EMPLOYER');
    expect(mapLabel('salary')).toBe('SALARY');
    expect(mapLabel('religion')).toBe('RELIGION');
    expect(mapLabel('caste')).toBe('CASTE');
  });

  it('is case-insensitive', () => {
    expect(mapLabel('PERSON')).toBe('PERSON_NAME');
    expect(mapLabel('Address')).toBe('ADDRESS');
    expect(mapLabel(' DOB ')).toBe('DOB');
  });

  it('returns undefined for unknown labels', () => {
    expect(mapLabel('UNKNOWN_ENTITY')).toBeUndefined();
    expect(mapLabel('')).toBeUndefined();
    expect(mapLabel('foobar')).toBeUndefined();
  });
});

describe('L2 NER — spansToDetections', () => {
  it('converts valid spans to Detection objects', () => {
    const spans: NerSpan[] = [
      { text: 'Ramesh Kumar', label: 'person', start: 0, end: 12, score: 0.95 },
      { text: '42 MG Road', label: 'address', start: 20, end: 30, score: 0.88 },
    ];

    const detections = spansToDetections(spans);
    expect(detections).toHaveLength(2);

    expect(detections[0]).toEqual({
      cls: 'PERSON_NAME',
      start: 0,
      end: 12,
      confidence: 0.95,
      source: 'l2-ner',
      evidence: 'Ramesh Kumar',
    });

    expect(detections[1]).toEqual({
      cls: 'ADDRESS',
      start: 20,
      end: 30,
      confidence: 0.88,
      source: 'l2-ner',
      evidence: '42 MG Road',
    });
  });

  it('drops spans with unmapped labels', () => {
    const spans: NerSpan[] = [
      { text: 'Some Entity', label: 'unknown_type', start: 0, end: 11, score: 0.9 },
    ];
    expect(spansToDetections(spans)).toHaveLength(0);
  });

  it('truncates evidence to 32 characters', () => {
    const longText = 'A'.repeat(64);
    const spans: NerSpan[] = [
      { text: longText, label: 'person', start: 0, end: 64, score: 0.8 },
    ];
    const detections = spansToDetections(spans);
    expect(detections[0]!.evidence!.length).toBe(32);
  });

  it('returns empty array for empty input', () => {
    expect(spansToDetections([])).toEqual([]);
  });
});

describe('L2 NER — stub detector', () => {
  it('returns degraded result with zero spans', async () => {
    const detector = createStubDetector('test reason');
    const result = await detector('Ramesh Kumar lives at 42 MG Road');

    expect(result.degraded).toBe(true);
    expect(result.spans).toHaveLength(0);
    expect(result.model).toBe('stub');
    expect(result.latencyMs).toBe(0);
  });

  it('reports itself as unavailable', () => {
    const detector = createStubDetector();
    expect(detector.available).toBe(false);
  });

  it('is safe to call concurrently', async () => {
    const detector = createStubDetector();
    const results = await Promise.all([
      detector('text one'),
      detector('text two'),
      detector('text three'),
    ]);
    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r.degraded).toBe(true);
      expect(r.spans).toHaveLength(0);
    });
  });
});

describe('L2 NER — L2_CLASSES constant', () => {
  it('contains all expected contextual PII classes', () => {
    expect(L2_CLASSES).toContain('PERSON_NAME');
    expect(L2_CLASSES).toContain('ADDRESS');
    expect(L2_CLASSES).toContain('DOB');
    expect(L2_CLASSES).toContain('AGE');
    expect(L2_CLASSES).toContain('HEALTH_CONDITION');
    expect(L2_CLASSES).toContain('EMPLOYER');
    expect(L2_CLASSES).toContain('SALARY');
    expect(L2_CLASSES).toContain('RELIGION');
    expect(L2_CLASSES).toContain('CASTE');
  });

  it('does not contain structured or credential classes', () => {
    expect(L2_CLASSES).not.toContain('AADHAAR');
    expect(L2_CLASSES).not.toContain('PAN');
    expect(L2_CLASSES).not.toContain('PASSWORD');
    expect(L2_CLASSES).not.toContain('API_KEY');
  });
});

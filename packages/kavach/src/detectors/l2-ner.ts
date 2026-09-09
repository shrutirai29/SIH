/**
 * KAVACH Layer 2 — Named Entity Recognition interface (ticket C10).
 *
 * L2 handles CONTEXTUAL PII: person names, addresses, dates of birth, employers —
 * things no regex can catch reliably because their structure is the structure of
 * natural language, not of checksums.
 *
 * ## Architecture
 *
 * The interface is a simple `(text) → Detection[]` contract. The REAL implementation
 * calls GLiNER-PII (or any zero-shot NER model) behind a local HTTP endpoint. This
 * file provides:
 *
 *  1. The TypeScript interface that `redact/text.ts` consumes.
 *  2. A fail-closed STUB that returns an empty array and logs that L2 was unavailable.
 *     The system degrades gracefully: L0 + L1 still catch structured PII, and the
 *     `coverageConfidence` function honestly reports reduced coverage.
 *  3. An HTTP-backed implementation that calls the NER endpoint.
 *
 * ## Fail-closed vs fail-open
 *
 * A fail-OPEN stub would silently pass contextual PII through to the server, which is
 * exactly the failure mode L2 exists to prevent. A fail-CLOSED stub refuses to process
 * text when NER is unavailable. We choose a DEGRADED middle: return zero detections
 * (so nothing new is redacted), but honestly report that coverage is reduced. The
 * egress guard and `coverageConfidence` both surface this honestly.
 */

import type { Detection, DetectionSource } from '../fuse.js';
import type { ContextualClass } from '../classes.js';

/** The classes L2 NER is expected to detect. */
export const L2_CLASSES: readonly ContextualClass[] = [
  'PERSON_NAME',
  'ADDRESS',
  'DOB',
  'AGE',
  'GENDER',
  'HEALTH_CONDITION',
  'MEDICATION',
  'DIAGNOSIS',
  'EMPLOYER',
  'SALARY',
  'RELIGION',
  'CASTE',
];

export interface NerSpan {
  readonly text: string;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly score: number;
}

export interface NerResult {
  readonly spans: readonly NerSpan[];
  readonly model: string;
  readonly latencyMs: number;
  /** True if the result came from the stub rather than a real model. */
  readonly degraded: boolean;
}

/**
 * The L2 NER detector contract.
 *
 * Implementations must be safe to call concurrently and must never throw.
 * A failure returns `{ spans: [], degraded: true }`.
 */
export interface L2NerDetector {
  (text: string): Promise<NerResult>;
  /** Returns true if the real model endpoint is available. */
  readonly available: boolean;
}

/**
 * Maps a GLiNER label to our PII taxonomy class.
 *
 * GLiNER-PII uses labels like "person", "location", "date_of_birth". This maps them
 * to our taxonomy. Unknown labels are dropped (fail-closed: an unknown entity is not
 * redacted, but it is also not leaked — it was never in the vault).
 */
const LABEL_MAP: Record<string, ContextualClass> = {
  person: 'PERSON_NAME',
  name: 'PERSON_NAME',
  per: 'PERSON_NAME',
  address: 'ADDRESS',
  location: 'ADDRESS',
  loc: 'ADDRESS',
  date_of_birth: 'DOB',
  dob: 'DOB',
  birthday: 'DOB',
  age: 'AGE',
  gender: 'GENDER',
  sex: 'GENDER',
  health_condition: 'HEALTH_CONDITION',
  disease: 'HEALTH_CONDITION',
  condition: 'HEALTH_CONDITION',
  medication: 'MEDICATION',
  drug: 'MEDICATION',
  diagnosis: 'DIAGNOSIS',
  employer: 'EMPLOYER',
  organization: 'EMPLOYER',
  org: 'EMPLOYER',
  company: 'EMPLOYER',
  salary: 'SALARY',
  income: 'SALARY',
  religion: 'RELIGION',
  caste: 'CASTE',
};

export function mapLabel(label: string): ContextualClass | undefined {
  return LABEL_MAP[label.toLowerCase().trim()];
}

/**
 * Converts NER spans into the Detection format the fuse expects.
 */
export function spansToDetections(spans: readonly NerSpan[]): Detection[] {
  const detections: Detection[] = [];

  for (const span of spans) {
    const cls = mapLabel(span.label);
    if (cls === undefined) continue;

    detections.push({
      cls,
      start: span.start,
      end: span.end,
      confidence: span.score,
      source: 'l2-ner' as DetectionSource,
      evidence: span.text.slice(0, 32),
    });
  }

  return detections;
}

// ---------------------------------------------------------------------------
// Stub implementation (fail-closed / degraded)
// ---------------------------------------------------------------------------

/**
 * Creates a stub L2 detector that returns zero detections.
 *
 * Used when the NER endpoint is unavailable. The system continues with L0 + L1
 * coverage only, and `coverageConfidence` reports the reduced capability honestly.
 */
export function createStubDetector(_reason = 'NER endpoint not configured'): L2NerDetector {
  const detector = async function stubDetector(_text: string): Promise<NerResult> {
    return {
      spans: [],
      model: 'stub',
      latencyMs: 0,
      degraded: true,
    };
  };

  Object.defineProperty(detector, 'available', { value: false, writable: false });
  return detector as unknown as L2NerDetector;
}

// ---------------------------------------------------------------------------
// HTTP-backed implementation
// ---------------------------------------------------------------------------

export type NerFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface NerEndpointConfig {
  /** Full URL to the NER inference endpoint (e.g. http://localhost:8001/predict). */
  readonly url: string;
  /** Request timeout in ms. Defaults to 5000. */
  readonly timeoutMs?: number;
  /** Minimum confidence threshold. Spans below this are dropped. Defaults to 0.5. */
  readonly minConfidence?: number;
  /** The entity labels to request from the model. Defaults to L2_CLASSES values. */
  readonly labels?: readonly string[];
  /** Injected network fetcher (e.g. from background net / message bus). RULES.md P1. */
  readonly fetcher?: NerFetcher;
}

/**
 * Creates an L2 detector backed by an HTTP NER endpoint.
 *
 * The endpoint is expected to accept POST with JSON body `{ text, labels }` and
 * return `{ spans: [{ text, label, start, end, score }], model }`.
 *
 * On any failure (network, timeout, malformed response), returns degraded result
 * with zero spans. Never throws.
 */
export function createHttpDetector(config: NerEndpointConfig): L2NerDetector {
  if (!config.fetcher) {
    return createStubDetector('No network fetcher provided (RULES.md P1)');
  }
  const fetcher = config.fetcher;

  const timeoutMs = config.timeoutMs ?? 5000;
  const minConfidence = config.minConfidence ?? 0.5;
  const labels = config.labels ?? [
    'person', 'address', 'date_of_birth', 'age', 'gender',
    'health_condition', 'medication', 'diagnosis',
    'employer', 'salary', 'religion', 'caste',
  ];

  let isAvailable = true;

  const detector = async function httpDetector(text: string): Promise<NerResult> {
    const started = performance.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetcher(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, labels }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        isAvailable = false;
        return degraded(started);
      }

      const body = await response.json() as {
        spans?: NerSpan[];
        model?: string;
      };

      isAvailable = true;
      const latencyMs = Math.round(performance.now() - started);

      const filteredSpans = (body.spans ?? []).filter((s) => s.score >= minConfidence);

      return {
        spans: filteredSpans,
        model: body.model ?? 'unknown',
        latencyMs,
        degraded: false,
      };
    } catch {
      isAvailable = false;
      return degraded(started);
    }
  };

  Object.defineProperty(detector, 'available', {
    get: () => isAvailable,
  });

  return detector as unknown as L2NerDetector;

  function degraded(started: number): NerResult {
    return {
      spans: [],
      model: 'unavailable',
      latencyMs: Math.round(performance.now() - started),
      degraded: true,
    };
  }
}

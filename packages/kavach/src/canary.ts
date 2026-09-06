/**
 * The canary suite.
 *
 * Plant unique, high-entropy strings across every surface a value can hide in, run the
 * real pipeline, and assert that not one of them appears in anything that left the
 * machine. It converts "we redact PII" from a claim into a test that can fail.
 *
 * The surfaces matter more than the count. Each one is a place a naive implementation
 * leaks: `textContent` is the obvious one, but `data-*` attributes, `alt`, `title`,
 * `aria-label`, `placeholder`, `<option>` text and CSS `content` are all perfectly
 * legible to anyone reading a serialised DOM, and all invisible to `el.textContent`
 * (PIPELINE.md §5.1, step 5).
 */

import { verhoeffChecksum } from './detectors/l1-regex/validators/verhoeff.js';

/** Where a canary is planted. Ordered roughly by how often implementations miss it. */
export const CANARY_SURFACES = [
  'dom_text',
  'input_value',
  'placeholder',
  'alt',
  'title',
  'aria_label',
  'data_attribute',
  'option_text',
  'css_content',
  'hidden_input',
  'same_origin_iframe',
  'canvas_pixels',
] as const;

export type CanarySurface = (typeof CANARY_SURFACES)[number];

export interface Canary {
  readonly id: string;
  readonly surface: CanarySurface;
  /** The string that must never leave. */
  readonly value: string;
}

/**
 * The marker is deliberately conspicuous. A canary that resembles real PII would be
 * caught by the detectors, which would prove nothing about the surfaces — the point is
 * to test whether the pipeline SEES a surface, not whether the regex pack works.
 */
const PREFIX = 'PRAHARICANARY';

function randomSuffix(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Generates `perSurface` canaries for every surface (default 5 x 12 = 60, matching the
 * suite size quoted in PRD.md §8).
 */
export function generateCanaries(perSurface = 5): Canary[] {
  const out: Canary[] = [];
  for (const surface of CANARY_SURFACES) {
    for (let i = 0; i < perSurface; i++) {
      const suffix = randomSuffix();
      out.push({
        id: surface + '_' + String(i),
        surface,
        value: PREFIX + suffix,
      });
    }
  }
  return out;
}

/**
 * The OTHER half of the suite: plants that are supposed to be redacted.
 *
 * The canaries above are deliberately conspicuous, which is what makes them good at
 * answering "did the harvester read this surface?" — a PII-shaped string would be
 * removed before you could tell. But it also means they answer nothing about the
 * redactor: `PRAHARICANARY3F0A…` is not personal data, no detector claims it, and a
 * Tier-1 payload legitimately carries page text, so it reaching the payload is CORRECT
 * behaviour rather than a leak.
 *
 * Scoring the audit on those alone therefore measured nothing about redaction. These
 * do: each one is a checksum-valid synthetic Aadhaar, unique per run, planted on the
 * same surfaces. Every one of them must come back tokenised, and any that does not is
 * a real failure of the component whose name is on the number.
 *
 * The values are generated, never real: a Verhoeff-valid 12-digit number that belongs
 * to nobody.
 */
export interface PiiCanary {
  readonly id: string;
  readonly surface: CanarySurface;
  /** The class a working detector must assign it. */
  readonly cls: 'AADHAAR';
  /** Checksum-valid and synthetic. Must never survive into a payload. */
  readonly value: string;
}

/** Builds a Verhoeff-valid Aadhaar-shaped number that belongs to no one. */
function syntheticAadhaar(): string {
  const digits = new Uint8Array(11);
  crypto.getRandomValues(digits);
  // Aadhaar's first digit is 2-9; the rest are free.
  const body =
    String(2 + (digits[0] ?? 0) % 8) +
    [...digits.slice(1)].map((b) => String(b % 10)).join('');
  return body + String(verhoeffChecksum(body));
}

export function generatePiiCanaries(perSurface = 1): PiiCanary[] {
  const out: PiiCanary[] = [];
  for (const surface of CANARY_SURFACES) {
    for (let i = 0; i < perSurface; i++) {
      out.push({
        id: 'pii_' + surface + '_' + String(i),
        surface,
        cls: 'AADHAAR',
        value: syntheticAadhaar(),
      });
    }
  }
  return out;
}

export interface LeakReport {
  readonly total: number;
  readonly leaked: readonly Canary[];
  readonly bySurface: Readonly<Record<string, { planted: number; leaked: number }>>;
  readonly clean: boolean;
}

/**
 * Checks a payload — the exact bytes that were about to be sent — for any canary.
 *
 * Takes the serialised string rather than the object on purpose: the question is
 * whether the BYTES contain the secret, not whether some field does. A canary hiding
 * in a key name, a concatenated string, or a base64 blob still counts as a leak.
 */
export function checkForLeaks(payload: string, canaries: readonly Canary[]): LeakReport {
  const leaked: Canary[] = [];
  const bySurface: Record<string, { planted: number; leaked: number }> = {};

  for (const c of canaries) {
    const bucket = (bySurface[c.surface] ??= { planted: 0, leaked: 0 });
    bucket.planted++;
    if (payload.includes(c.value)) {
      leaked.push(c);
      bucket.leaked++;
    }
  }

  return {
    total: canaries.length,
    leaked,
    bySurface,
    clean: leaked.length === 0,
  };
}

/** One-line summary for the side panel and the demo. `0 / 60 leaked` is the goal. */
export function formatReport(report: LeakReport): string {
  return String(report.leaked.length) + ' / ' + String(report.total) + ' leaked';
}

/**
 * The surfaces a text harvester must read for the suite to be meaningful.
 *
 * If extraction never reads `data-*`, planting a canary there proves nothing — the
 * value is not in the payload because nothing looked for it, not because redaction
 * worked. The harness asserts BOTH: the harvester finds every canary, and the guard
 * blocks every payload containing one. Only together do they mean anything.
 */
export const HARVEST_REQUIRED_SURFACES: readonly CanarySurface[] = [
  'dom_text',
  'input_value',
  'placeholder',
  'alt',
  'title',
  'aria_label',
  'data_attribute',
  'option_text',
  'hidden_input',
];

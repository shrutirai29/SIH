/**
 * Detection fusion.
 *
 * Several detectors look at the same span and may disagree. Fusion is recall-first by
 * design, because the cost matrix is wildly asymmetric: a missed Aadhaar is a breach,
 * an over-redacted order number is a measurable utility loss we can tune
 * (`over_redaction_utility_delta`).
 *
 * Two rules:
 *   - overlapping detections merge, and the MORE SENSITIVE class wins;
 *   - confidence combines by noisy-OR, with independent agreement promoted to
 *     certainty when at least one source is deterministic.
 */

import { mostSensitive, rankOf } from './classes.js';

export type DetectionSource = 'l0-dom' | 'l1-regex' | 'l2-ner' | 'l3-vision' | 'l4-vlm';

/** Sources whose positives are ground truth, not estimates. */
const DETERMINISTIC: ReadonlySet<DetectionSource> = new Set(['l0-dom', 'l1-regex']);

export interface Detection {
  readonly cls: string;
  /** Character range within the normalised text. Absent for pixel-only detections. */
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly source: DetectionSource;
  readonly evidence?: string;
}

export interface FusedDetection extends Detection {
  readonly sources: readonly DetectionSource[];
  /** True when at least two independent detectors agreed. */
  readonly corroborated: boolean;
}

/** Noisy-OR: 1 - prod(1 - c_i). Independent evidence accumulates. */
export function noisyOr(confidences: readonly number[]): number {
  let inverse = 1;
  for (const c of confidences) inverse *= 1 - Math.min(Math.max(c, 0), 1);
  return 1 - inverse;
}

function overlaps(a: Detection, b: Detection): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Merges overlapping detections.
 *
 * Note the span of a merged group is the UNION, not the intersection. A detector that
 * saw slightly less of the value must not shrink the redaction — a box two characters
 * too small leaves a legible fragment of an identifier.
 */
export function fuse(detections: readonly Detection[]): FusedDetection[] {
  if (detections.length === 0) return [];

  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Detection[][] = [];

  for (const d of sorted) {
    // Every group this detection touches, not just the first. A span that bridges two
    // existing groups MERGES them: attaching it to the first one alone would leave two
    // groups whose union spans overlap, and the redactor would then plan two
    // substitutions over the same characters. Right-to-left application makes that
    // corrupt the payload into exactly the half-written token MALFORMED_TOKEN exists
    // to catch. Rare with L0+L1 alone; routine once NER spans arrive beside them.
    const touching = groups.filter((g) => g.some((existing) => overlaps(existing, d)));

    if (touching.length === 0) {
      groups.push([d]);
      continue;
    }

    const merged = touching.flat();
    merged.push(d);
    for (const g of touching) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }

  return groups.map((group) => {
    let cls = group[0]!.cls;
    for (const d of group) cls = mostSensitive(cls, d.cls);

    const sources = [...new Set(group.map((d) => d.source))];
    const hasDeterministic = sources.some((s) => DETERMINISTIC.has(s));
    const corroborated = sources.length >= 2;

    // Agreement between independent detectors, at least one of which cannot be wrong
    // about its own classes, is as certain as this system gets.
    const confidence =
      corroborated && hasDeterministic ? 1 : noisyOr(group.map((d) => d.confidence));

    // The winning class's own best evidence string is the most useful one to surface
    // in "explain this redaction".
    const winner = group
      .filter((d) => d.cls === cls)
      .sort((a, b) => b.confidence - a.confidence)[0];

    const fused: FusedDetection = {
      cls,
      start: Math.min(...group.map((d) => d.start)),
      end: Math.max(...group.map((d) => d.end)),
      confidence,
      source: winner?.source ?? group[0]!.source,
      sources,
      corroborated,
      ...(winner?.evidence !== undefined ? { evidence: winner.evidence } : {}),
    };
    return fused;
  });
}

/**
 * Whole-screen coverage confidence, penalised by anything we could not account for.
 * The server receives this so it knows how much to trust the structural view — a
 * calibrated humility signal rather than a silent guess.
 */
export function coverageConfidence(opts: {
  readonly detections: readonly FusedDetection[];
  readonly unexplainedPixelRatio: number;
  readonly timedOutDetectors: readonly string[];
  /** Detector layers that actually ran this step. */
  readonly activeLayers: readonly DetectionSource[];
}): number {
  // Start from what the running layers can, in principle, cover. With only L0+L1 there
  // is no contextual-PII coverage at all, and claiming otherwise would be dishonest.
  const hasContextual = opts.activeLayers.includes('l2-ner');
  const hasVision = opts.activeLayers.includes('l3-vision');
  let score = 0.55;
  if (hasContextual) score += 0.25;
  if (hasVision) score += 0.2;

  score -= opts.unexplainedPixelRatio * 0.5;
  score -= opts.timedOutDetectors.length * 0.1;

  // A screen where detectors fired and agreed is better understood than a silent one,
  // but only slightly - absence of detections is weak evidence either way.
  if (opts.detections.some((d) => d.corroborated)) score += 0.03;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/** Sorts by sensitivity, most dangerous first. Used for UI and for capped reporting. */
export function bySensitivity(a: FusedDetection, b: FusedDetection): number {
  return rankOf(a.cls) - rankOf(b.cls) || b.confidence - a.confidence;
}

/**
 * NETRA - on-device perception.
 *
 * This package is INTERFACES ONLY at the walking-skeleton stage. The implementations
 * (BlazeFace, the UI-element detector, PP-OCR, GLiNER, the optional local VLM) arrive
 * in Phase 2/3 behind exactly these signatures, so the rest of the system can be built
 * and tested against the seam today.
 *
 * The APC below returns a fixed tier. That is deliberate and it is documented in the
 * side panel: an adaptive controller that has no signals to adapt on would be a lie
 * dressed as a feature.
 */

import type { Tier } from '@prahari/ssg';

/* --------------------------------------------------------------- device profile */

/**
 * A = discrete GPU, B = modern integrated GPU, C = WASM only.
 * Chosen once at install by a micro-benchmark (ticket C1) and used to pick model
 * variants and stage budgets.
 */
export type DeviceClass = 'A' | 'B' | 'C';

export type ExecutionProvider = 'webgpu' | 'wasm';

export interface DeviceProfile {
  readonly deviceClass: DeviceClass;
  readonly ep: ExecutionProvider;
  readonly cores: number;
  /** Milliseconds of local budget available for a Tier-2 step on this machine. */
  readonly tier2BudgetMs: number;
}

/**
 * Capability probe. Runs the matmul micro-benchmark and detects GPU/WASM capabilities
 * (ticket C1) to honestly categorize device performance and configure latency budgets.
 */
export async function probeDevice(): Promise<DeviceProfile> {
  return probeDeviceWithBenchmark();
}

/* ------------------------------------------------------------- inference host */

export type Box = readonly [number, number, number, number];

export interface Widget {
  readonly bbox: Box;
  readonly cls: string;
  readonly score: number;
}

export interface OcrLine {
  readonly bbox: Box;
  readonly text: string;
  readonly conf: number;
}

export interface NerSpan {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly score: number;
}

/**
 * The contract every detector implementation must satisfy. Owned by MLC; consumed by
 * KAVACH and the extension. Changing it needs a PR review from the consumer
 * (TEAM-ROLES.md sec 4).
 */
export interface InferenceHost {
  init(profile: DeviceProfile): Promise<void>;
  detectFaces(img: ImageData, roi: readonly Box[]): Promise<Box[]>;
  detectWidgets(img: ImageData): Promise<Widget[]>;
  ocr(img: ImageData, regions: readonly Box[]): Promise<OcrLine[]>;
  ner(spans: readonly string[], labels: readonly string[]): Promise<NerSpan[]>;
  stats(): { modelMs: Record<string, number>; ep: ExecutionProvider };
}

/* ---------------------------------------------- adaptive perception controller */

export interface ApcSignals {
  /** 0-1: how little the DOM changed since the last step. */
  readonly domStability: number;
  /** 0-1: perceptual-hash distance between consecutive frames. */
  readonly pHashDelta: number;
  /** 0-1: the local stack's confidence that it understands this screen. */
  readonly localConfidence: number;
  /** 0-1: viewport fraction that no DOM node explains. */
  readonly unexplainedPixelRatio: number;
  readonly consecutiveFailures: number;
  readonly pageType: string;
  readonly deviceClass: DeviceClass;
  /** User or policy ceiling; the controller may go below it, never above. */
  readonly tierCeiling: Tier;
}

export interface StageBudgets {
  readonly perceiveMs: number;
  readonly detectMs: number;
  readonly redactMs: number;
}

export interface TierDecision {
  readonly tier: Tier;
  readonly budgets: StageBudgets;
  /** Human-readable reasons, shown in the side panel's tier badge tooltip. */
  readonly why: readonly string[];
}

import { evaluateApcTier } from './apc.js';
import { probeDeviceWithBenchmark } from './vision/probe.js';

/**
 * Tier selection via the Adaptive Perception Controller (ticket C12).
 * Consumes DOM stability, visual delta, unexplained pixel ratio, and failure counts
 * to intelligently route execution to Tier 0, Tier 1, or Tier 2.
 */
export function chooseTier(s: ApcSignals): TierDecision {
  return evaluateApcTier(s);
}

export { probeDeviceWithBenchmark } from './vision/probe.js';
export {
  computeDHash,
  computePHashDelta,
  computeTileDiff,
  type TileDiffResult,
} from './vision/diff.js';
export {
  computeCoverageMask,
  type CoverageResult,
} from './vision/coverage.js';
export {
  WidgetDetector,
  reconcileWidgetsWithDom,
  computeBoxIou,
  type DomElementRef,
  type ReconciliationReport,
  type ReconciledWidgetMatch,
} from './vision/widgets.js';
export {
  OcrEngine,
  type OcrDetectionOptions,
} from './vision/ocr.js';
export { evaluateApcTier, type ApcEvaluationWeights } from './apc.js';
export { NetraInferenceHost } from './host/netra-host.js';
export { MediaPipeFaceDetector } from './mediapipe/face-detector.js';
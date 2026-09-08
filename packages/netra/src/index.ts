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
 * Capability probe. The real version runs a matmul micro-benchmark and one detector
 * pass (ticket C1); this one reports honestly on what the environment exposes.
 */
export async function probeDevice(): Promise<DeviceProfile> {
  const cores = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency;
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })
    ?.gpu;

  if (gpu === undefined) {
    return { deviceClass: 'C', ep: 'wasm', cores, tier2BudgetMs: 1200 };
  }

  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      return { deviceClass: 'C', ep: 'wasm', cores, tier2BudgetMs: 1200 };
    }
    // Without the micro-benchmark we cannot tell A from B, so we claim the more
    // conservative of the two. Over-claiming device class costs latency budget.
    return { deviceClass: 'B', ep: 'webgpu', cores, tier2BudgetMs: 450 };
  } catch {
    return { deviceClass: 'C', ep: 'wasm', cores, tier2BudgetMs: 1200 };
  }
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

/**
 * Tier selection.
 *
 * STATUS: fixed policy. The scored controller from ARCHITECTURE.md sec 8, with weights
 * fitted on the eval corpus, is ticket C12. Until the vision stack exists there is
 * nothing to escalate TO, so returning anything but Tier 1 would be theatre.
 */
export function chooseTier(s: ApcSignals): TierDecision {
  const why: string[] = [];

  if (s.tierCeiling === 0) {
    why.push('tier ceiling pinned to 0 by policy');
    return { tier: 0, budgets: { perceiveMs: 0, detectMs: 60, redactMs: 40 }, why };
  }

  why.push('fixed tier-1 policy (adaptive controller is ticket C12)');
  const slow = s.deviceClass === 'C';
  if (slow) why.push('device class C: budgets relaxed');

  return {
    tier: 1,
    budgets: {
      perceiveMs: 0,
      detectMs: slow ? 240 : 60,
      redactMs: slow ? 160 : 40,
    },
    why,
  };
}

export { NetraInferenceHost } from './host/netra-host.js';
export { MediaPipeFaceDetector } from './mediapipe/face-detector.js';
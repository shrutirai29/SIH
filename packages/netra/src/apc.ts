/**
 * NETRA Adaptive Perception Controller (APC) (ticket C12).
 *
 * Implements dynamic, multi-signal tier selection that routes agent steps:
 *  - Tier 0: Local execution (trivial dismissals, simple scroll, zero server round-trip)
 *  - Tier 1: DOM-only Sanitized Screen Graph (structured text, forms, low visual ambiguity)
 *  - Tier 2: Visual escalation with verified redacted screenshot (canvas apps, image-heavy, high ambiguity)
 *
 * Signals consumed:
 *  - domStability: DOM mutation rate
 *  - pHashDelta: perceptual image change rate
 *  - localConfidence: on-device model confidence
 *  - unexplainedPixelRatio: fraction of viewport pixels not explained by DOM
 *  - consecutiveFailures: failure recovery escalation
 *  - deviceClass: local latency budget bounds
 */

import type { Tier } from '@prahari/ssg';
import type { ApcSignals, TierDecision } from './index.js';

export interface ApcEvaluationWeights {
  readonly domWeight: number;
  readonly visualWeight: number;
  readonly failureWeight: number;
}

const DEFAULT_WEIGHTS: ApcEvaluationWeights = {
  domWeight: 0.35,
  visualWeight: 0.45,
  failureWeight: 0.2,
};

/**
 * Evaluates perceptual and architectural signals to decide the execution tier.
 */
export function evaluateApcTier(
  s: ApcSignals,
  weights: ApcEvaluationWeights = DEFAULT_WEIGHTS,
): TierDecision {
  const why: string[] = [];

  // Policy hard ceilings always override
  if (s.tierCeiling === 0) {
    why.push('tier ceiling pinned to 0 by security policy');
    return {
      tier: 0,
      budgets: { perceiveMs: 0, detectMs: 60, redactMs: 40 },
      why,
    };
  }

  // Tier 0 Fast-Path:
  // If DOM is highly stable, local confidence is near perfect, and consecutive failures == 0
  if (
    s.domStability > 0.95 &&
    s.localConfidence > 0.92 &&
    s.consecutiveFailures === 0 &&
    s.unexplainedPixelRatio < 0.02
  ) {
    why.push('high local confidence (>92%) & stable DOM: resolved locally via Tier 0');
    return {
      tier: 0,
      budgets: { perceiveMs: 20, detectMs: 30, redactMs: 20 },
      why,
    };
  }

  // Visual Escalation Triggers (Tier 2):
  // 1. High unexplained pixel ratio (canvas apps, charts, graphical documents)
  const highUnexplainedPixels = s.unexplainedPixelRatio > 0.08;
  if (highUnexplainedPixels) {
    why.push(
      `unexplained pixel ratio (${(s.unexplainedPixelRatio * 100).toFixed(1)}%) exceeds 8% threshold (canvas/image content)`,
    );
  }

  // 2. High perceptual delta with low DOM change (e.g. animated canvas, game, WebGL)
  const visualDivergence = s.pHashDelta > 0.25 && s.domStability > 0.8;
  if (visualDivergence) {
    why.push('screen pixels changed significantly without DOM mutations (visual divergence)');
  }

  // 3. Repeated DOM grounding failures -> escalate to vision for assistance
  const repeatedFailures = s.consecutiveFailures >= 2;
  if (repeatedFailures) {
    why.push(`${s.consecutiveFailures} consecutive action failures; escalating to visual verification`);
  }

  // Multi-signal composite escalation score
  const escalationScore =
    s.unexplainedPixelRatio * weights.visualWeight +
    (1.0 - s.localConfidence) * weights.domWeight +
    Math.min(1.0, s.consecutiveFailures * 0.4) * weights.failureWeight;

  const requiresVisual =
    highUnexplainedPixels || visualDivergence || repeatedFailures || escalationScore > 0.45;

  let selectedTier: Tier = 1;

  if (requiresVisual && s.tierCeiling >= 2) {
    selectedTier = 2;
    if (!highUnexplainedPixels && !visualDivergence && !repeatedFailures) {
      why.push(`composite escalation score (${escalationScore.toFixed(2)}) exceeded threshold`);
    }
  } else {
    selectedTier = 1;
    why.push('DOM sufficiently explains screen; Tier-1 tokenized graph selected');
  }

  // Budget calculations based on DeviceClass
  const slow = s.deviceClass === 'C';
  const fast = s.deviceClass === 'A';

  const perceiveMs = selectedTier === 2 ? (fast ? 100 : slow ? 500 : 250) : 0;
  const detectMs = fast ? 40 : slow ? 240 : 60;
  const redactMs = selectedTier === 2 ? (fast ? 30 : slow ? 180 : 50) : (slow ? 120 : 30);

  if (slow) {
    why.push('device class C (WASM): latency budgets relaxed');
  } else if (fast) {
    why.push('device class A (GPU): accelerated latency budgets');
  }

  return {
    tier: selectedTier,
    budgets: {
      perceiveMs,
      detectMs,
      redactMs,
    },
    why,
  };
}

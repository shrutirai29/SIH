import { describe, expect, it } from 'vitest';
import { chooseTier, type ApcSignals } from '../src/index.js';

describe('NETRA Adaptive Perception Controller (Ticket C12)', () => {
  const baseSignals: ApcSignals = {
    domStability: 0.9,
    pHashDelta: 0.05,
    localConfidence: 0.85,
    unexplainedPixelRatio: 0.02,
    consecutiveFailures: 0,
    pageType: 'form',
    deviceClass: 'B',
    tierCeiling: 2,
  };

  it('selects Tier 0 for high-confidence, stable screens (no server trip)', () => {
    const signals: ApcSignals = {
      ...baseSignals,
      domStability: 0.98,
      localConfidence: 0.96,
      unexplainedPixelRatio: 0.01,
      consecutiveFailures: 0,
    };

    const decision = chooseTier(signals);
    expect(decision.tier).toBe(0);
    expect(decision.why.some((w) => w.includes('Tier 0'))).toBe(true);
  });

  it('selects Tier 1 for standard DOM-explainable pages', () => {
    const decision = chooseTier(baseSignals);
    expect(decision.tier).toBe(1);
    expect(decision.why.some((w) => w.includes('Tier-1'))).toBe(true);
  });

  it('escalates to Tier 2 when unexplained pixel ratio exceeds threshold (canvas/charts)', () => {
    const signals: ApcSignals = {
      ...baseSignals,
      unexplainedPixelRatio: 0.15, // 15% of viewport is canvas/unexplained
    };

    const decision = chooseTier(signals);
    expect(decision.tier).toBe(2);
    expect(decision.why.some((w) => w.includes('exceeds 8% threshold'))).toBe(true);
  });

  it('escalates to Tier 2 on visual divergence (pixels changed without DOM mutation)', () => {
    const signals: ApcSignals = {
      ...baseSignals,
      domStability: 0.95,
      pHashDelta: 0.4, // Large visual change
    };

    const decision = chooseTier(signals);
    expect(decision.tier).toBe(2);
    expect(decision.why.some((w) => w.includes('visual divergence'))).toBe(true);
  });

  it('escalates to Tier 2 on repeated action failures', () => {
    const signals: ApcSignals = {
      ...baseSignals,
      consecutiveFailures: 2,
    };

    const decision = chooseTier(signals);
    expect(decision.tier).toBe(2);
    expect(decision.why.some((w) => w.includes('consecutive action failures'))).toBe(true);
  });

  it('honors security policy tier ceiling pinned to 0', () => {
    const signals: ApcSignals = {
      ...baseSignals,
      tierCeiling: 0,
      unexplainedPixelRatio: 0.5, // Even with high canvas
    };

    const decision = chooseTier(signals);
    expect(decision.tier).toBe(0);
    expect(decision.why.some((w) => w.includes('pinned to 0'))).toBe(true);
  });
});

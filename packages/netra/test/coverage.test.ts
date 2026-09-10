import { describe, expect, it } from 'vitest';
import { computeCoverageMask } from '../src/vision/coverage.js';
import type { Box } from '../src/index.js';

describe('NETRA Coverage Mask & Unexplained Pixel Ratio (Ticket C8)', () => {
  it('computes low unexplained ratio when DOM elements cover the viewport', () => {
    const viewport = { w: 800, h: 600 };
    // DOM elements that tile most of the viewport
    const domRects: Box[] = [
      [0, 0, 800, 100],
      [0, 100, 400, 500],
      [400, 100, 400, 500],
    ];

    const result = computeCoverageMask(viewport, domRects);

    expect(result.unexplainedPixelRatio).toBeLessThan(0.1);
    expect(result.domExplainedArea).toBeGreaterThan(400000);
    expect(result.totalViewportArea).toBe(480000);
  });

  it('detects high unexplained pixel ratio when canvas/visual elements are present', () => {
    const viewport = { w: 1000, h: 800 };
    const domRects: Box[] = [
      [0, 0, 1000, 80], // Small top navbar
    ];
    // Large canvas element occupying the center (e.g. 800x600)
    const visualRects: Box[] = [
      [100, 100, 800, 600],
    ];

    const result = computeCoverageMask(viewport, domRects, visualRects);

    expect(result.unexplainedPixelRatio).toBeGreaterThan(0.4);
    expect(result.nonDomRegions).toHaveLength(1);
    expect(result.nonDomRegions[0]).toEqual([100, 100, 800, 600]);
  });

  it('handles empty DOM or zero dimensions gracefully', () => {
    const result = computeCoverageMask({ w: 0, h: 0 }, []);
    expect(result.unexplainedPixelRatio).toBe(0);
    expect(result.domExplainedArea).toBe(0);
    expect(result.nonDomRegions).toEqual([]);
  });
});

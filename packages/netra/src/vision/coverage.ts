/**
 * NETRA Coverage Mask & Unexplained Pixel Ratio (ticket C8).
 *
 * Computes the spatial coverage of DOM text and structural elements relative to the
 * viewport. Pixels that no DOM element explains (e.g. <canvas>, <img>, PDF embeds,
 * cross-origin iframes) indicate visual content that DOM scraping cannot capture,
 * triggering visual OCR or Adaptive Perception Controller (APC) escalation to Tier 2.
 */

import type { Box } from '../index.js';

export interface CoverageResult {
  /** Fraction of viewport area not explained by DOM text/structural elements (0.0 to 1.0). */
  readonly unexplainedPixelRatio: number;
  /** Estimated area in CSS pixels explained by DOM nodes. */
  readonly domExplainedArea: number;
  /** Total viewport area in CSS pixels. */
  readonly totalViewportArea: number;
  /** Bounding boxes of significant non-DOM or visual-heavy regions. */
  readonly nonDomRegions: readonly Box[];
}

/**
 * Computes coverage and unexplained pixel ratio from DOM rects and viewport.
 *
 * @param viewport Viewport dimensions { w, h }
 * @param domRects Bounding boxes of DOM elements [x, y, w, h]
 * @param visualElementRects Bounding boxes of known visual-only elements (<canvas>, <img>, <video>, iframe)
 * @param dilationPx Margin around DOM rects to account for text descenders/anti-aliasing (default 3)
 */
export function computeCoverageMask(
  viewport: { readonly w: number; readonly h: number },
  domRects: readonly Box[],
  visualElementRects: readonly Box[] = [],
  dilationPx = 3,
): CoverageResult {
  const { w: vw, h: vh } = viewport;
  if (vw <= 0 || vh <= 0) {
    return {
      unexplainedPixelRatio: 0,
      domExplainedArea: 0,
      totalViewportArea: 0,
      nonDomRegions: [],
    };
  }

  const totalViewportArea = vw * vh;

  // Use a coarse grid for fast O(grid) union area computation without full pixel buffer
  const gridStep = 16;
  const gridW = Math.ceil(vw / gridStep);
  const gridH = Math.ceil(vh / gridStep);
  const grid = new Uint8Array(gridW * gridH);

  // Mark DOM covered cells (bit 1)
  for (const [bx, by, bw, bh] of domRects) {
    if (bw <= 0 || bh <= 0) continue;
    const x0 = Math.max(0, Math.floor((bx - dilationPx) / gridStep));
    const y0 = Math.max(0, Math.floor((by - dilationPx) / gridStep));
    const x1 = Math.min(gridW - 1, Math.floor((bx + bw + dilationPx) / gridStep));
    const y1 = Math.min(gridH - 1, Math.floor((by + bh + dilationPx) / gridStep));

    for (let gy = y0; gy <= y1; gy++) {
      const rowOffset = gy * gridW;
      for (let gx = x0; gx <= x1; gx++) {
        grid[rowOffset + gx] = grid[rowOffset + gx]! | 1;
      }
    }
  }

  // Mark explicit visual elements (canvas, video, img) (bit 2)
  for (const [bx, by, bw, bh] of visualElementRects) {
    if (bw <= 0 || bh <= 0) continue;
    const x0 = Math.max(0, Math.floor(bx / gridStep));
    const y0 = Math.max(0, Math.floor(by / gridStep));
    const x1 = Math.min(gridW - 1, Math.floor((bx + bw) / gridStep));
    const y1 = Math.min(gridH - 1, Math.floor((by + bh) / gridStep));

    for (let gy = y0; gy <= y1; gy++) {
      const rowOffset = gy * gridW;
      for (let gx = x0; gx <= x1; gx++) {
        grid[rowOffset + gx] = grid[rowOffset + gx]! | 2;
      }
    }
  }

  let domCoveredCells = 0;
  let visualUnexplainedCells = 0;
  const totalCells = gridW * gridH;

  for (let i = 0; i < totalCells; i++) {
    const val = grid[i]!;
    if (val & 1) {
      domCoveredCells++;
    }
    // Cells marked as visual elements that are NOT explained by DOM text
    if ((val & 2) && !(val & 1)) {
      visualUnexplainedCells++;
    }
  }

  const domExplainedArea = Math.min(
    totalViewportArea,
    domCoveredCells * (gridStep * gridStep),
  );

  // If explicit visual element rects provided, unexplained ratio is visualUnexplained / total
  // Otherwise, unexplained ratio is (total - domExplained) / total
  let unexplainedRatio: number;
  if (visualElementRects.length > 0) {
    unexplainedRatio = Math.min(1.0, visualUnexplainedCells / Math.max(1, totalCells));
  } else {
    unexplainedRatio = Math.max(0, 1.0 - domCoveredCells / Math.max(1, totalCells));
  }

  // Generate candidate non-DOM regions from visualElementRects or unexplained clusters
  const nonDomRegions: Box[] = [];
  for (const [bx, by, bw, bh] of visualElementRects) {
    // Keep those with visible area in viewport
    const cx0 = Math.max(0, bx);
    const cy0 = Math.max(0, by);
    const cx1 = Math.min(vw, bx + bw);
    const cy1 = Math.min(vh, by + bh);
    if (cx1 > cx0 && cy1 > cy0) {
      nonDomRegions.push([cx0, cy0, cx1 - cx0, cy1 - cy0]);
    }
  }

  return {
    unexplainedPixelRatio: Number(unexplainedRatio.toFixed(4)),
    domExplainedArea: Math.round(domExplainedArea),
    totalViewportArea,
    nonDomRegions,
  };
}

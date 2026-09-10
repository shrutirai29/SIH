/**
 * NETRA UI-Element Detection & DOM-Widget Reconciliation (tickets C6 & C7).
 *
 * Implements client-side UI widget detection and reconciliation against DOM rects.
 * Widgets that the DOM cannot explain (e.g., clickable buttons drawn on a <canvas>
 * or interactive chart elements) are identified as "vision-only elements" and emitted
 * as interactive point targets in the Sanitized Screen Graph.
 */

import type { Box, Widget } from '../index.js';

export interface DomElementRef {
  readonly id: string;
  readonly bbox?: readonly [number, number, number, number] | undefined;
  readonly role?: string | undefined;
  readonly tag?: string | undefined;
}

export interface ReconciledWidgetMatch {
  readonly widget: Widget;
  readonly domElementId: string | null;
  readonly iou: number;
  readonly isVisionOnly: boolean;
}

export interface ReconciliationReport {
  readonly matches: readonly ReconciledWidgetMatch[];
  /** Elements identified only via vision (canvas buttons, interactive graphics). */
  readonly visionOnlyWidgets: readonly Widget[];
  /** Fraction of detected widgets that agree with DOM rects (0.0 to 1.0). */
  readonly agreementRate: number;
  /** Count of DOM elements with no corresponding visual widget detected. */
  readonly ungroundedDomCount: number;
}

/**
 * Calculates Intersection-over-Union (IoU) between two bounding boxes.
 */
export function computeBoxIou(boxA: Box, boxB: Box): number {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;

  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);

  const interW = Math.max(0, x1 - x0);
  const interH = Math.max(0, y1 - y0);
  const interArea = interW * interH;

  if (interArea <= 0) return 0;

  const areaA = aw * ah;
  const areaB = bw * bh;
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Detects UI widgets from rendered image data using edge and luminance gradients.
 * Fast on-device visual segmentation suited for Chrome/Firefox extension contexts.
 */
export class WidgetDetector {
  /**
   * Detects interactive widget bounding boxes on an ImageData canvas.
   */
  detect(img: ImageData, minScore = 0.5): Widget[] {
    const { width, height, data } = img;
    if (width < 32 || height < 32 || data.length === 0) {
      return [];
    }

    const widgets: Widget[] = [];
    const step = 8;
    const cols = Math.floor(width / step);
    const rows = Math.floor(height / step);

    // Compute coarse gradient magnitude map
    const grad = new Float32Array(cols * rows);

    for (let r = 1; r < rows - 1; r++) {
      const y = r * step;
      const rowOffset = y * width * 4;
      const nextRowOffset = (y + step) * width * 4;

      for (let c = 1; c < cols - 1; c++) {
        const x = c * step;
        const idx = rowOffset + x * 4;
        const nextXIdx = rowOffset + (x + step) * 4;
        const nextYIdx = nextRowOffset + x * 4;

        const luma = 0.299 * data[idx]! + 0.587 * data[idx + 1]! + 0.114 * data[idx + 2]!;
        const lumaX = 0.299 * data[nextXIdx]! + 0.587 * data[nextXIdx + 1]! + 0.114 * data[nextXIdx + 2]!;
        const lumaY = 0.299 * data[nextYIdx]! + 0.587 * data[nextYIdx + 1]! + 0.114 * data[nextYIdx + 2]!;

        const dx = lumaX - luma;
        const dy = lumaY - luma;
        grad[r * cols + c] = Math.sqrt(dx * dx + dy * dy);
      }
    }

    // Threshold and extract bounding contours of rectangular regions
    const edgeThresh = 24.0;
    const visited = new Uint8Array(cols * rows);

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const idx = r * cols + c;
        if (visited[idx] || grad[idx]! < edgeThresh) continue;

        // Flood fill connected edge components
        let minC = c;
        let maxC = c;
        let minR = r;
        let maxR = r;
        let edgePoints = 0;

        const queue: number[] = [idx];
        visited[idx] = 1;

        while (queue.length > 0 && queue.length < 500) {
          const curr = queue.pop()!;
          const curR = Math.floor(curr / cols);
          const curC = curr % cols;

          edgePoints++;
          if (curC < minC) minC = curC;
          if (curC > maxC) maxC = curC;
          if (curR < minR) minR = curR;
          if (curR > maxR) maxR = curR;

          // 4 neighbors
          const neighbors = [curr - 1, curr + 1, curr - cols, curr + cols];
          for (const n of neighbors) {
            if (n >= 0 && n < visited.length && !visited[n] && grad[n]! >= edgeThresh) {
              visited[n] = 1;
              queue.push(n);
            }
          }
        }

        const boxW = (maxC - minC + 1) * step;
        const boxH = (maxR - minR + 1) * step;
        const boxX = minC * step;
        const boxY = minR * step;

        // Filter for realistic interactive UI widget dimensions
        // (min 16x16, max 90% of screen)
        if (
          boxW >= 16 &&
          boxH >= 16 &&
          boxW <= width * 0.9 &&
          boxH <= height * 0.9 &&
          edgePoints >= 4
        ) {
          const aspect = boxW / boxH;
          let cls = 'container';
          let score = 0.65;

          if (aspect >= 1.2 && aspect <= 6.0 && boxH <= 60) {
            cls = 'button';
            score = 0.85;
          } else if (aspect >= 4.0 && boxH <= 50) {
            cls = 'textfield';
            score = 0.8;
          } else if (aspect >= 0.8 && aspect <= 1.2 && boxW <= 48 && boxH <= 48) {
            cls = 'icon';
            score = 0.75;
          }

          if (score >= minScore) {
            widgets.push({
              bbox: [boxX, boxY, boxW, boxH],
              cls,
              score: Number(score.toFixed(2)),
            });
          }
        }
      }
    }

    return widgets;
  }
}

/**
 * Reconciles detected visual widgets with DOM element rects.
 *
 * Algorithm (PIPELINE.md sec 4.2):
 * - If IoU > 0.6: Agreement between vision & DOM -> keeps DOM identity.
 * - If IoU < 0.3: Vision-only element (canvas/graphic widget) -> added to SSG.
 */
export function reconcileWidgetsWithDom(
  widgets: readonly Widget[],
  domElements: readonly DomElementRef[],
): ReconciliationReport {
  const matches: ReconciledWidgetMatch[] = [];
  const visionOnlyWidgets: Widget[] = [];
  const matchedDomIds = new Set<string>();

  for (const widget of widgets) {
    let bestIou = 0;
    let bestDomId: string | null = null;

    for (const domEl of domElements) {
      if (!domEl.bbox) continue;
      const iou = computeBoxIou(widget.bbox, domEl.bbox);
      if (iou > bestIou) {
        bestIou = iou;
        bestDomId = domEl.id;
      }
    }

    if (bestIou >= 0.6 && bestDomId !== null) {
      matchedDomIds.add(bestDomId);
      matches.push({
        widget,
        domElementId: bestDomId,
        iou: Number(bestIou.toFixed(3)),
        isVisionOnly: false,
      });
    } else if (bestIou < 0.3) {
      visionOnlyWidgets.push(widget);
      matches.push({
        widget,
        domElementId: null,
        iou: Number(bestIou.toFixed(3)),
        isVisionOnly: true,
      });
    } else {
      matches.push({
        widget,
        domElementId: bestDomId,
        iou: Number(bestIou.toFixed(3)),
        isVisionOnly: false,
      });
    }
  }

  const groundedCount = widgets.filter((w) => !visionOnlyWidgets.includes(w)).length;
  const agreementRate = widgets.length > 0 ? groundedCount / widgets.length : 1.0;
  const ungroundedDomCount = Math.max(0, domElements.length - matchedDomIds.size);

  return {
    matches,
    visionOnlyWidgets,
    agreementRate: Number(agreementRate.toFixed(3)),
    ungroundedDomCount,
  };
}

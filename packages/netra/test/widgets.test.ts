import { describe, expect, it } from 'vitest';
import {
  computeBoxIou,
  WidgetDetector,
  reconcileWidgetsWithDom,
  type DomElementRef,
} from '../src/vision/widgets.js';
import type { Box, Widget } from '../src/index.js';

describe('NETRA UI-Element Detection & Reconciliation (Tickets C6 & C7)', () => {
  it('computes IoU correctly between overlapping and disjoint boxes', () => {
    const boxA: Box = [0, 0, 100, 100];
    const boxB: Box = [0, 0, 100, 100];
    expect(computeBoxIou(boxA, boxB)).toBe(1.0);

    const boxC: Box = [50, 0, 100, 100];
    // Intersection: 50x100 = 5000. AreaA=10000, AreaC=10000, Union=15000. IoU = 5000/15000 = 0.333
    expect(computeBoxIou(boxA, boxC)).toBeCloseTo(0.333, 2);

    const boxDisjoint: Box = [200, 200, 50, 50];
    expect(computeBoxIou(boxA, boxDisjoint)).toBe(0);
  });

  it('detects high-contrast button-like UI elements from image pixels', () => {
    const width = 200;
    const height = 150;
    const data = new Uint8ClampedArray(width * height * 4);

    // Light background
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 240;
      data[i + 1] = 240;
      data[i + 2] = 240;
      data[i + 3] = 255;
    }

    // Draw a prominent dark rectangular button in the middle: x=40, y=50, w=100, h=40
    for (let y = 50; y < 90; y++) {
      for (let x = 40; x < 140; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 20;
        data[idx + 1] = 20;
        data[idx + 2] = 20;
      }
    }

    const img = { width, height, data } as unknown as ImageData;
    const detector = new WidgetDetector();
    const widgets = detector.detect(img, 0.5);

    expect(widgets.length).toBeGreaterThanOrEqual(1);
    const btn = widgets.find((w) => w.cls === 'button' || w.cls === 'container');
    expect(btn).toBeDefined();
    expect(btn!.score).toBeGreaterThan(0.5);
  });

  it('reconciles detected widgets against DOM rects and identifies vision-only elements', () => {
    const widgets: Widget[] = [
      { bbox: [10, 10, 80, 30], cls: 'button', score: 0.9 }, // Matches DOM
      { bbox: [300, 400, 120, 40], cls: 'button', score: 0.85 }, // Vision-only (on canvas)
    ];

    const domElements: DomElementRef[] = [
      { id: 'dom_submit_btn', bbox: [12, 10, 78, 30], role: 'button' },
    ];

    const report = reconcileWidgetsWithDom(widgets, domElements);

    expect(report.matches).toHaveLength(2);
    expect(report.visionOnlyWidgets).toHaveLength(1);
    expect(report.visionOnlyWidgets[0]?.bbox).toEqual([300, 400, 120, 40]);

    const domMatch = report.matches.find((m) => m.domElementId === 'dom_submit_btn');
    expect(domMatch).toBeDefined();
    expect(domMatch!.isVisionOnly).toBe(false);
    expect(domMatch!.iou).toBeGreaterThan(0.8);
  });
});

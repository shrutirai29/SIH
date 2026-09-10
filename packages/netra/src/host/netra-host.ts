import type {
  Box,
  DeviceProfile,
  InferenceHost,
  NerSpan,
  OcrLine,
  Widget,
} from '../index.js';

import { MediaPipeFaceDetector } from '../mediapipe/face-detector.js';
import { WidgetDetector } from '../vision/widgets.js';
import { OcrEngine } from '../vision/ocr.js';

/**
 * Concrete implementation of NETRA's perception & inference host.
 *
 * Implements:
 * - BlazeFace short-range detection with coordinate dilation
 * - UI-element widget detection for vision-only controls
 * - Visual OCR on non-DOM regions to intercept embedded PII
 * - Contextual NER entity alignment
 * - Execution timings and provider telemetry
 */
export class NetraInferenceHost implements InferenceHost {
  #profile: DeviceProfile | null = null;

  readonly #faceDetector = new MediaPipeFaceDetector();
  readonly #widgetDetector = new WidgetDetector();
  readonly #ocrEngine = new OcrEngine();

  #modelMs: Record<string, number> = {};

  async init(profile: DeviceProfile): Promise<void> {
    this.#profile = profile;

    const start = performance.now();

    try {
      await this.#faceDetector.init(profile);
    } catch (err) {
      console.warn('NETRA: FaceDetector initialization warning:', err);
    }

    this.#modelMs['faceDetectorInit'] = performance.now() - start;
  }

  /**
   * Detects human faces in an image and dilates the bounding box by 8%
   * to ensure full perimeter coverage during pixel redaction (PIPELINE.md sec 4.1).
   */
  async detectFaces(img: ImageData, roi: readonly Box[] = []): Promise<Box[]> {
    if (this.#profile === null) {
      throw new Error('NETRA inference host has not been initialized.');
    }

    const start = performance.now();
    let rawFaces: Box[] = [];

    try {
      rawFaces = this.#faceDetector.detect(img);
    } catch {
      // Degrade gracefully if detector throws in non-DOM/test contexts
      rawFaces = [];
    }

    // Dilate face boxes by 8% to ensure hairline and jawline are fully obscured
    const dilatedFaces: Box[] = rawFaces.map(([x, y, w, h]) => {
      const dw = w * 0.08;
      const dh = h * 0.08;
      const nx = Math.max(0, x - dw);
      const ny = Math.max(0, y - dh);
      const nw = Math.min(img.width - nx, w + dw * 2);
      const nh = Math.min(img.height - ny, h + dh * 2);
      return [
        Math.round(nx),
        Math.round(ny),
        Math.round(nw),
        Math.round(nh),
      ] as const;
    });

    // If ROIs were specified, also filter/intersect
    const finalFaces = roi.length > 0
      ? dilatedFaces.filter(([fx, fy, fw, fh]) =>
          roi.some(([rx, ry, rw, rh]) =>
            fx + fw > rx && fx < rx + rw && fy + fh > ry && fy < ry + rh,
          ),
        )
      : dilatedFaces;

    this.#modelMs['detectFaces'] = performance.now() - start;
    return finalFaces;
  }

  /**
   * Detects interactive visual widgets (buttons, textfields, canvas controls).
   */
  async detectWidgets(img: ImageData): Promise<Widget[]> {
    if (this.#profile === null) {
      throw new Error('NETRA inference host has not been initialized.');
    }

    const start = performance.now();
    const widgets = this.#widgetDetector.detect(img);
    this.#modelMs['detectWidgets'] = performance.now() - start;

    return widgets;
  }

  /**
   * Runs visual OCR on non-DOM regions to extract text lines.
   */
  async ocr(img: ImageData, regions: readonly Box[] = []): Promise<OcrLine[]> {
    if (this.#profile === null) {
      throw new Error('NETRA inference host has not been initialized.');
    }

    const start = performance.now();
    const lines = await this.#ocrEngine.recognize(img, regions);
    this.#modelMs['ocr'] = performance.now() - start;

    return lines;
  }

  /**
   * Contextual NER entity matching over text spans.
   */
  async ner(spans: readonly string[], labels: readonly string[]): Promise<NerSpan[]> {
    if (this.#profile === null) {
      throw new Error('NETRA inference host has not been initialized.');
    }

    const start = performance.now();
    const results: NerSpan[] = [];
    const labelSet = new Set(labels.map((l) => l.toUpperCase()));

    for (const span of spans) {
      // Basic contextual entity matching heuristics
      if (labelSet.has('DOB') && /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(span)) {
        results.push({
          start: 0,
          end: span.length,
          label: 'DOB',
          score: 0.9,
        });
      }
      if (labelSet.has('SALARY') && /(?:₹|Rs\.?|INR|\$)\s*\d+/.test(span)) {
        results.push({
          start: 0,
          end: span.length,
          label: 'SALARY',
          score: 0.88,
        });
      }
      if (labelSet.has('AGE') && /\b\d{1,3}\s*(?:years?|yrs?|yr)\b/i.test(span)) {
        results.push({
          start: 0,
          end: span.length,
          label: 'AGE',
          score: 0.85,
        });
      }
    }

    this.#modelMs['ner'] = performance.now() - start;
    return results;
  }

  stats(): {
    modelMs: Record<string, number>;
    ep: DeviceProfile['ep'];
  } {
    if (this.#profile === null) {
      return {
        modelMs: {},
        ep: 'wasm',
      };
    }

    return {
      modelMs: { ...this.#modelMs },
      ep: this.#profile.ep,
    };
  }

  close(): void {
    this.#faceDetector.close();
    this.#profile = null;
    this.#modelMs = {};
  }
}
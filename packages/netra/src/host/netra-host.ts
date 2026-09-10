import type {
  Box,
  DeviceProfile,
  InferenceHost,
  NerSpan,
  OcrLine,
  Widget,
} from '../index.js';

import { MediaPipeFaceDetector } from '../mediapipe/face-detector.js';

/**
 * Initial concrete implementation of NETRA's inference interface.
 *
 * Phase 1:
 * - Face detection is implemented using MediaPipe BlazeFace.
 *
 * Future phases:
 * - Widget detection
 * - OCR
 * - Named Entity Recognition
 */
export class NetraInferenceHost implements InferenceHost {
  #profile: DeviceProfile | null = null;

  readonly #faceDetector = new MediaPipeFaceDetector();

  #modelMs: Record<string, number> = {};

  async init(profile: DeviceProfile): Promise<void> {
    this.#profile = profile;

    const start = performance.now();

    await this.#faceDetector.init(profile);

    this.#modelMs['faceDetectorInit'] =
      performance.now() - start;
  }

  async detectFaces(
    img: ImageData,
    _roi: readonly Box[],
  ): Promise<Box[]> {
    if (this.#profile === null) {
      throw new Error(
        'NETRA inference host has not been initialized.',
      );
    }

    const start = performance.now();

    const faces = this.#faceDetector.detect(img);

    this.#modelMs['detectFaces'] =
      performance.now() - start;

    return faces;
  }

  async detectWidgets(
    _img: ImageData,
  ): Promise<Widget[]> {
    return [];
  }

  async ocr(
    _img: ImageData,
    _regions: readonly Box[],
  ): Promise<OcrLine[]> {
    return [];
  }

  async ner(
    _spans: readonly string[],
    _labels: readonly string[],
  ): Promise<NerSpan[]> {
    return [];
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
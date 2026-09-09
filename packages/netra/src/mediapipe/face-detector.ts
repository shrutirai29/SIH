import {
  FaceDetector,
  FilesetResolver,
} from '@mediapipe/tasks-vision';

import type { Box, DeviceProfile } from '../index.js';

const MODEL_URL =
  'assets/models/blaze_face_short_range.tflite';

const WASM_ROOT =
  'assets/wasm';

/**
 * MediaPipe implementation of NETRA's face perception stage.
 *
 * This is adapted from the original face-detect-test prototype,
 * but accepts ImageData instead of webcam video frames.
 */
export class MediaPipeFaceDetector {
  #detector: FaceDetector | null = null;

  async init(profile: DeviceProfile): Promise<void> {
    if (this.#detector !== null) {
      return;
    }

    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

    const delegate = profile.ep === 'webgpu' ? 'GPU' : 'CPU';

    try {
      this.#detector = await FaceDetector.createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate,
          },
          runningMode: 'IMAGE',
        },
      );
    } catch (error) {
      if (delegate !== 'GPU') {
        throw error;
      }

      console.warn(
        'NETRA: GPU initialization failed, falling back to CPU.',
        error,
      );

      this.#detector = await FaceDetector.createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
        },
      );
    }
  }

  detect(img: ImageData): Box[] {
    if (this.#detector === null) {
      throw new Error(
        'NETRA face detector has not been initialized.',
      );
    }

    const result = this.#detector.detect(img);

    return result.detections.flatMap((detection) => {
      const box = detection.boundingBox;

      if (box === undefined) {
        return [];
      }

      return [[
        box.originX,
        box.originY,
        box.width,
        box.height,
      ] as const];
    });
  }

  close(): void {
    this.#detector?.close();
    this.#detector = null;
  }
}
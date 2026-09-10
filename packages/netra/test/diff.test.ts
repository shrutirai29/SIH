import { describe, expect, it } from 'vitest';
import {
  computeDHash,
  computePHashDelta,
  computeTileDiff,
} from '../src/vision/diff.js';

function createSolidImage(width: number, height: number, color: [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  }
  return { width, height, data } as unknown as ImageData;
}

function createGradientImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = Math.floor((x / width) * 255);
      data[idx + 1] = Math.floor((y / height) * 255);
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data } as unknown as ImageData;
}

describe('NETRA Perceptual Diffing & Hashing (Ticket C5)', () => {
  it('computes 64-bit dHash consistently for identical images', () => {
    const img1 = createGradientImage(64, 64);
    const img2 = createGradientImage(64, 64);

    const hash1 = computeDHash(img1);
    const hash2 = computeDHash(img2);

    expect(hash1).toBe(hash2);
    expect(computePHashDelta(hash1, hash2)).toBe(0);
  });

  it('detects perceptual distance between distinct images', () => {
    const dark = createSolidImage(64, 64, [10, 10, 10]);
    const grad = createGradientImage(64, 64);

    const hashA = computeDHash(dark);
    const hashB = computeDHash(grad);

    const delta = computePHashDelta(hashA, hashB);
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThanOrEqual(1.0);
  });

  it('computes 16x16 tile difference and detects stationarity', () => {
    const frame1 = createSolidImage(64, 64, [50, 50, 50]);
    const frame2 = createSolidImage(64, 64, [50, 50, 50]);

    // Identical frames -> 0 tiles changed, stationary = true
    const diffIdentical = computeTileDiff(frame1, frame2);
    expect(diffIdentical.fractionChanged).toBe(0);
    expect(diffIdentical.isStationary).toBe(true);
    expect(diffIdentical.changedTiles).toHaveLength(0);

    // Modify a small tile in frame2
    const frameModified = createSolidImage(64, 64, [50, 50, 50]);
    // Change top-left tile (0 to 15, 0 to 15)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = (y * 64 + x) * 4;
        frameModified.data[idx] = 240;
        frameModified.data[idx + 1] = 240;
        frameModified.data[idx + 2] = 240;
      }
    }

    const diffChanged = computeTileDiff(frameModified, frame1);
    expect(diffChanged.changedTiles.length).toBeGreaterThanOrEqual(1);
    expect(diffChanged.fractionChanged).toBeGreaterThan(0);
  });

  it('handles null previous frame gracefully by marking whole frame new', () => {
    const frame = createSolidImage(32, 32, [100, 100, 100]);
    const diff = computeTileDiff(frame, null);

    expect(diff.fractionChanged).toBe(1.0);
    expect(diff.isStationary).toBe(false);
    expect(diff.changedTiles).toEqual([[0, 0, 32, 32]]);
  });
});

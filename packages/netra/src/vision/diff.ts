/**
 * NETRA Perceptual Diffing & Hashing (ticket C5).
 *
 * Implements 64-bit difference hashing (dHash) and 16x16 tile diffing.
 * Stationarity detection allows NETRA to skip unchanged visual regions,
 * slashing client-side perception latency and compute cost.
 */

import type { Box } from '../index.js';

export interface TileDiffResult {
  /** Changed 16x16 tile bounding boxes in pixel coordinates. */
  readonly changedTiles: readonly Box[];
  /** Fraction of tiles that changed (0.0 to 1.0). */
  readonly fractionChanged: number;
  /** True if visual change is below noise threshold (<= 1% tiles changed). */
  readonly isStationary: boolean;
  /** Total tiles evaluated. */
  readonly totalTiles: number;
}

/**
 * Computes a 64-bit difference hash (dHash) from ImageData.
 *
 * Steps:
 * 1. Downscales image to a 9x8 grid of luminance values.
 * 2. Compares adjacent pixels horizontally: row[x] > row[x+1] -> 1, else 0.
 * 3. 8 rows x 8 comparisons = 64 bits.
 */
export function computeDHash(img: ImageData): bigint {
  const { width, height, data } = img;
  if (width <= 0 || height <= 0 || data.length === 0) {
    return 0n;
  }

  // 9 horizontal samples, 8 vertical samples
  const targetW = 9;
  const targetH = 8;
  const gray = new Float32Array(targetW * targetH);

  const blockW = width / targetW;
  const blockH = height / targetH;

  for (let r = 0; r < targetH; r++) {
    const startY = Math.floor(r * blockH);
    const endY = Math.min(height, Math.floor((r + 1) * blockH));
    const hCount = Math.max(1, endY - startY);

    for (let c = 0; c < targetW; c++) {
      const startX = Math.floor(c * blockW);
      const endX = Math.min(width, Math.floor((c + 1) * blockW));
      const wCount = Math.max(1, endX - startX);

      let sumLuma = 0;
      for (let y = startY; y < endY; y++) {
        const rowOffset = y * width * 4;
        for (let x = startX; x < endX; x++) {
          const idx = rowOffset + x * 4;
          const rVal = data[idx]!;
          const gVal = data[idx + 1]!;
          const bVal = data[idx + 2]!;
          // Rec. 601 luma
          sumLuma += 0.299 * rVal + 0.587 * gVal + 0.114 * bVal;
        }
      }

      gray[r * targetW + c] = sumLuma / (hCount * wCount);
    }
  }

  let hash = 0n;
  for (let r = 0; r < targetH; r++) {
    const rowOffset = r * targetW;
    for (let c = 0; c < 8; c++) {
      const left = gray[rowOffset + c]!;
      const right = gray[rowOffset + c + 1]!;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }

  return hash;
}

/**
 * Computes Hamming distance between two 64-bit dHashes, normalized to [0, 1].
 */
export function computePHashDelta(hashA: bigint, hashB: bigint): number {
  let diff = hashA ^ hashB;
  let count = 0;
  while (diff > 0n) {
    if (diff & 1n) count++;
    diff >>= 1n;
  }
  return count / 64.0;
}

/**
 * Compares two consecutive frames on a 16x16 tile grid.
 *
 * @param current Current frame ImageData
 * @param previous Previous frame ImageData
 * @param tileSize Tile edge size in pixels (default 16)
 * @param pixelThreshold Minimum mean absolute difference per pixel to flag a tile as changed (default 12)
 */
export function computeTileDiff(
  current: ImageData,
  previous: ImageData | null,
  tileSize = 16,
  pixelThreshold = 12,
): TileDiffResult {
  const { width, height } = current;
  if (!previous || previous.width !== width || previous.height !== height) {
    // Entire screen is new
    const tilesX = Math.ceil(width / tileSize);
    const tilesY = Math.ceil(height / tileSize);
    const total = tilesX * tilesY;
    return {
      changedTiles: [[0, 0, width, height]],
      fractionChanged: 1.0,
      isStationary: false,
      totalTiles: total,
    };
  }

  const curData = current.data;
  const prevData = previous.data;

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const totalTiles = cols * rows;

  const changed: Box[] = [];

  for (let r = 0; r < rows; r++) {
    const y = r * tileSize;
    const h = Math.min(tileSize, height - y);

    for (let c = 0; c < cols; c++) {
      const x = c * tileSize;
      const w = Math.min(tileSize, width - x);

      let totalDiff = 0;
      const pixelCount = w * h;

      for (let dy = 0; dy < h; dy++) {
        const rowOffset = (y + dy) * width * 4;
        for (let dx = 0; dx < w; dx++) {
          const idx = rowOffset + (x + dx) * 4;
          const dr = Math.abs(curData[idx]! - prevData[idx]!);
          const dg = Math.abs(curData[idx + 1]! - prevData[idx + 1]!);
          const db = Math.abs(curData[idx + 2]! - prevData[idx + 2]!);
          totalDiff += (dr + dg + db) / 3;
        }
      }

      const meanDiff = totalDiff / pixelCount;
      if (meanDiff >= pixelThreshold) {
        changed.push([x, y, w, h]);
      }
    }
  }

  const fractionChanged = totalTiles > 0 ? changed.length / totalTiles : 0;
  const isStationary = fractionChanged <= 0.01;

  return {
    changedTiles: changed,
    fractionChanged,
    isStationary,
    totalTiles,
  };
}

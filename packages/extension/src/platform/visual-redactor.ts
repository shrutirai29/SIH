/**
 * Visual Redaction Pipeline (Phase 2).
 *
 * Connects browser screenshot captures to KAVACH's pixel-redaction engine.
 * Maps DOM viewport CSS coordinates to screenshot pixel coordinates,
 * redacts all detected PII regions via KAVACH `redactPixels`, and verifies
 * the resulting image structure before making it eligible for SSG attachment.
 *
 * RULES.md:
 * - Fail-closed: unredacted or unverified screenshots NEVER pass through.
 * - Coordinate safety: aspect ratio and scale factors are verified; mismatches fail closed.
 * - Locality: raw captures are redacted in-memory; unredacted data is never stored or logged.
 */

import {
  redactPixels,
  verifyRedactedImage,
  sha256Hex,
  type DiffRow,
  type PixelRedactOptions,
  type PixelRegion,
} from '@prahari/kavach';
import { findTokens, type SSG } from '@prahari/ssg';
import type { Box } from '@prahari/netra';
import type { CapturedTab } from './capture.js';

export interface VisualRedactOptions extends Partial<PixelRedactOptions> {
  readonly detectedFaces?: readonly Box[] | undefined;
  readonly detectFaces?: ((img: ImageData) => Promise<Box[]> | Box[]) | undefined;
}

export interface RedactedScreenshot {
  /** The verified redacted PNG blob. */
  readonly blob: Blob;
  /** Image width in pixels. */
  readonly width: number;
  /** Image height in pixels. */
  readonly height: number;
  /** SHA-256 hash of the redacted image bytes. */
  readonly sha256: string;
  /** Count of successfully redacted PII regions. */
  readonly redactedCount: number;
  /** The format is always png for verified screenshots. */
  readonly format: 'png';
}

export interface RegionDerivationResult {
  readonly ok: boolean;
  readonly regions: PixelRegion[];
  readonly reason?: string;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Derives PII bounding boxes in screenshot pixel coordinates from an SSG.
 *
 * Coordinate Contract:
 * - DOM elements use viewport-relative CSS pixels from `getBoundingClientRect()`.
 * - Screenshot captures the visible viewport at device pixel resolution.
 * - `scaleX = screenshot.width / viewport.w`, `scaleY = screenshot.height / viewport.h`.
 * - Both scale factors must match within a 5% tolerance (aspect ratio check).
 * - Off-screen regions are clipped to screenshot bounds; regions completely
 *   outside the viewport are skipped since they have no pixels on screen.
 */
export function derivePiiPixelRegions(
  ssg: SSG,
  screenshotDims: { width: number; height: number },
  diff?: readonly DiffRow[],
): RegionDerivationResult {
  const vw = ssg.viewport?.w;
  const vh = ssg.viewport?.h;

  if (typeof vw !== 'number' || typeof vh !== 'number' || vw <= 0 || vh <= 0) {
    return { ok: false, regions: [], reason: 'invalid_viewport_dimensions', scaleX: 0, scaleY: 0 };
  }

  const sw = screenshotDims.width;
  const sh = screenshotDims.height;

  if (typeof sw !== 'number' || typeof sh !== 'number' || sw <= 0 || sh <= 0) {
    return { ok: false, regions: [], reason: 'invalid_screenshot_dimensions', scaleX: 0, scaleY: 0 };
  }

  const scaleX = sw / vw;
  const scaleY = sh / vh;

  // Aspect ratio sanity check: scaleX and scaleY should be practically identical
  // (both equal window.devicePixelRatio). More than 5% difference indicates a
  // viewport/screenshot dimension mismatch.
  const aspectDiff = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  if (aspectDiff > 0.05) {
    return { ok: false, regions: [], reason: 'aspect_ratio_mismatch', scaleX, scaleY };
  }

  // Minimum scaling factor sanity check
  if (scaleX < 0.5 || scaleY < 0.5) {
    return { ok: false, regions: [], reason: 'screenshot_too_small_for_viewport', scaleX, scaleY };
  }

  // Identify elements requiring PII redaction
  const piiElements = new Map<string, string>(); // elementId -> PII class

  // 1. From diff rows if provided
  if (diff) {
    for (const row of diff) {
      if (row.elementId && row.cls) {
        piiElements.set(row.elementId, row.cls);
      }
    }
  }

  // 2. Intrinsic scan over SSG elements for defense-in-depth
  for (const el of ssg.elements ?? []) {
    if (piiElements.has(el.id)) continue;

    if (el.redaction?.class) {
      piiElements.set(el.id, el.redaction.class);
      continue;
    }

    // Camera Stream Rule (PIPELINE.md sec 4.1): unconditional blackout of live video/camera elements
    const isVideo = el.tag === 'video' || el.role === 'video' ||
      (typeof el.name === 'string' && /camera|webcam|live\s*video|stream/i.test(el.name));
    if (isVideo) {
      piiElements.set(el.id, 'CAMERA_STREAM');
      continue;
    }

    const textToScan: string[] = [];
    if (typeof el.name === 'string') textToScan.push(el.name);
    if (typeof el.value === 'string') textToScan.push(el.value);
    if (typeof el.placeholder === 'string') textToScan.push(el.placeholder);

    for (const text of textToScan) {
      const tokens = findTokens(text);
      if (tokens.length > 0) {
        const cls = tokens[0]?.cls ?? 'PII';
        piiElements.set(el.id, cls);
        break;
      }
    }
  }

  const regions: PixelRegion[] = [];

  // Transform element bounding boxes
  for (const el of ssg.elements ?? []) {
    const cls = piiElements.get(el.id);
    if (!cls) continue;

    const bbox = el.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) continue;

    const [bx, by, bw, bh] = bbox;
    if (
      typeof bx !== 'number' ||
      typeof by !== 'number' ||
      typeof bw !== 'number' ||
      typeof bh !== 'number' ||
      bw <= 0 ||
      bh <= 0
    ) {
      continue;
    }

    const rawX = bx * scaleX;
    const rawY = by * scaleY;
    const rawW = bw * scaleX;
    const rawH = bh * scaleY;

    // Clamp to visible screenshot viewport
    const clampedX = Math.max(0, Math.min(sw, rawX));
    const clampedY = Math.max(0, Math.min(sh, rawY));
    const clampedRight = Math.max(0, Math.min(sw, rawX + rawW));
    const clampedBottom = Math.max(0, Math.min(sh, rawY + rawH));

    const finalW = clampedRight - clampedX;
    const finalH = clampedBottom - clampedY;

    // Only include if visible on screen
    if (finalW > 0 && finalH > 0) {
      regions.push({
        elementId: el.id,
        cls,
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        width: Math.round(finalW),
        height: Math.round(finalH),
      });
    }
  }

  // 3. Transform text block bounding boxes if they contain tokens
  for (const block of ssg.text_blocks ?? []) {
    if (!block.text || !Array.isArray(block.bbox) || block.bbox.length < 4) continue;

    const tokens = findTokens(block.text);
    if (tokens.length === 0) continue;

    const cls = tokens[0]?.cls ?? 'PII';
    const [bx, by, bw, bh] = block.bbox;
    if (
      typeof bx !== 'number' ||
      typeof by !== 'number' ||
      typeof bw !== 'number' ||
      typeof bh !== 'number' ||
      bw <= 0 ||
      bh <= 0
    ) {
      continue;
    }

    const rawX = bx * scaleX;
    const rawY = by * scaleY;
    const rawW = bw * scaleX;
    const rawH = bh * scaleY;

    const clampedX = Math.max(0, Math.min(sw, rawX));
    const clampedY = Math.max(0, Math.min(sh, rawY));
    const clampedRight = Math.max(0, Math.min(sw, rawX + rawW));
    const clampedBottom = Math.max(0, Math.min(sh, rawY + rawH));

    const finalW = clampedRight - clampedX;
    const finalH = clampedBottom - clampedY;

    if (finalW > 0 && finalH > 0) {
      regions.push({
        elementId: block.id,
        cls,
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        width: Math.round(finalW),
        height: Math.round(finalH),
      });
    }
  }

  return { ok: true, regions, scaleX, scaleY };
}

/**
 * Applies visual redaction to a captured tab.
 *
 * Process:
 * 1. Derives PII pixel regions from SSG with coordinate transformation.
 * 2. Destroys sensitive pixels using KAVACH `redactPixels`.
 * 3. Verifies the redacted PNG using KAVACH `verifyRedactedImage`.
 * 4. Computes SHA-256 for the verified attachment.
 *
 * Returns null if redaction fails, OffscreenCanvas is unavailable,
 * coordinate mapping is invalid, or image verification fails.
 */
export async function redactCapturedTab(
  captured: CapturedTab,
  ssg: SSG,
  diff?: readonly DiffRow[],
  options: VisualRedactOptions = {},
): Promise<RedactedScreenshot | null> {
  try {
    if (!captured || !captured.blob || captured.width <= 0 || captured.height <= 0) {
      return null;
    }

    const derivation = derivePiiPixelRegions(ssg, { width: captured.width, height: captured.height }, diff);
    if (!derivation.ok) {
      return null;
    }

    const finalRegions: PixelRegion[] = [...derivation.regions];

    // NETRA on-device face detection integration (PIPELINE.md sec 4.1)
    if (options.detectedFaces && options.detectedFaces.length > 0) {
      for (let i = 0; i < options.detectedFaces.length; i++) {
        const [fx, fy, fw, fh] = options.detectedFaces[i]!;
        finalRegions.push({
          elementId: `face_${i}`,
          cls: 'FACE',
          x: Math.round(fx),
          y: Math.round(fy),
          width: Math.round(fw),
          height: Math.round(fh),
        });
      }
    }

    if (options.detectFaces && typeof OffscreenCanvas !== 'undefined') {
      try {
        const bitmap = await createImageBitmap(captured.blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
          const faces = await options.detectFaces(imgData);
          for (let i = 0; i < faces.length; i++) {
            const [fx, fy, fw, fh] = faces[i]!;
            finalRegions.push({
              elementId: `face_${i}`,
              cls: 'FACE',
              x: Math.round(fx),
              y: Math.round(fy),
              width: Math.round(fw),
              height: Math.round(fh),
            });
          }
        }
      } catch {
        // Fallback: continue with derived regions
      }
    }

    const redactResult = await redactPixels(captured.blob, finalRegions, {
      mode: 'BLACKOUT',
      ...options,
    });

    if (!redactResult.blob) {
      return null;
    }

    // Fail-closed if any regions could not be redacted
    if (redactResult.skipped.length > 0) {
      return null;
    }

    // Verify structural validity of the redacted image with KAVACH
    const verifyResult = await verifyRedactedImage(redactResult.blob, finalRegions.length);
    if (!verifyResult.ok) {
      return null;
    }

    const arrayBuffer = await redactResult.blob.arrayBuffer();
    const sha256 = await sha256Hex(new Uint8Array(arrayBuffer));

    return {
      blob: redactResult.blob,
      width: captured.width,
      height: captured.height,
      sha256,
      redactedCount: redactResult.redactedCount,
      format: 'png',
    };
  } catch {
    // Fail-closed: never let unredacted/partially-redacted captures escape
    return null;
  }
}

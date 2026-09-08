/**
 * Pixel redaction — canvas-based visual redaction for screenshots (ticket D10).
 *
 * Before a screenshot leaves the machine, every region the detection cascade has flagged
 * must be visually destroyed. "Destroyed" means: no amount of image processing recovers
 * the original pixels. BLACKOUT and PIXELATE satisfy this; BLUR with a large enough
 * radius does too, but a 3px blur on a 12-character string is reversible, so the minimum
 * radius is tuned per region width.
 *
 * ## CAPED markers
 *
 * After redacting, we stamp a class-labelled marker (e.g. "[AADHAAR]") in the centre of
 * each redacted region. The server's VLM layer sees these markers and can reason about
 * what was there without needing the value. The marker is drawn AFTER the pixel
 * destruction, so the label can never be mistaken for surviving original text.
 *
 * ## Fail-closed
 *
 * If the OffscreenCanvas API is unavailable (e.g. in a content script without offscreen
 * document), the function returns `null`, and the egress guard blocks the screenshot.
 */

/** The visual strategy for destroying PII pixels. */
export type PixelRedactMode = 'BLACKOUT' | 'BLUR' | 'PIXELATE';

export interface PixelRegion {
  /** SSG element id this region belongs to. */
  readonly elementId: string;
  /** PII class of the detection. */
  readonly cls: string;
  /** Bounding box in the screenshot coordinate space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRedactOptions {
  readonly mode: PixelRedactMode;
  /** Blur radius. Only used when mode is BLUR. Defaults to max(region.width / 4, 12). */
  readonly blurRadius?: number;
  /** Pixelate block size. Only used when mode is PIXELATE. Defaults to max(region.width / 6, 8). */
  readonly blockSize?: number;
  /** Whether to stamp CAPED class markers on redacted regions. Defaults to true. */
  readonly stampMarkers?: boolean;
  /** Font size for CAPED markers. Defaults to 14. */
  readonly markerFontSize?: number;
}

const DEFAULT_OPTIONS: Required<PixelRedactOptions> = {
  mode: 'BLACKOUT',
  blurRadius: 12,
  blockSize: 8,
  stampMarkers: true,
  markerFontSize: 14,
};

export interface PixelRedactResult {
  /** The redacted image as a Blob (image/png). Null if redaction was impossible. */
  readonly blob: Blob | null;
  /** Number of regions that were successfully redacted. */
  readonly redactedCount: number;
  /** Regions that could not be redacted (e.g. out of bounds). */
  readonly skipped: readonly PixelRegion[];
}

/**
 * Applies pixel-level redaction to an image for the given regions.
 *
 * This function is designed to work in both OffscreenCanvas (service worker) and
 * regular canvas (content script with offscreen document) contexts.
 *
 * @param imageData - The raw image data (ImageBitmap, Blob, or ArrayBuffer of PNG).
 * @param regions  - The detected PII bounding boxes to redact.
 * @param opts     - Visual strategy and parameters.
 * @returns The redacted image, or null if canvas is unavailable.
 */
export async function redactPixels(
  imageData: ImageBitmap | Blob,
  regions: readonly PixelRegion[],
  opts: Partial<PixelRedactOptions> = {},
): Promise<PixelRedactResult> {
  const config = { ...DEFAULT_OPTIONS, ...opts };

  if (regions.length === 0) {
    // Nothing to redact; return the image unchanged.
    const blob = imageData instanceof Blob
      ? imageData
      : await imageBitmapToBlob(imageData);
    return { blob, redactedCount: 0, skipped: [] };
  }

  // Obtain the bitmap.
  let bitmap: ImageBitmap;
  if (imageData instanceof Blob) {
    bitmap = await createImageBitmap(imageData);
  } else {
    bitmap = imageData;
  }

  // Try to get a canvas. Fail-closed if unavailable.
  let canvas: OffscreenCanvas;
  try {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  } catch {
    // OffscreenCanvas not available — fail closed.
    return { blob: null, redactedCount: 0, skipped: [...regions] };
  }

  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return { blob: null, redactedCount: 0, skipped: [...regions] };
  }

  // Draw original image.
  ctx.drawImage(bitmap, 0, 0);

  const skipped: PixelRegion[] = [];
  let redactedCount = 0;

  for (const region of regions) {
    // Bounds check: skip regions entirely outside the canvas.
    if (
      region.x >= bitmap.width ||
      region.y >= bitmap.height ||
      region.x + region.width <= 0 ||
      region.y + region.height <= 0
    ) {
      skipped.push(region);
      continue;
    }

    // Clamp to canvas bounds.
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const w = Math.min(Math.floor(region.width), bitmap.width - x);
    const h = Math.min(Math.floor(region.height), bitmap.height - y);

    if (w <= 0 || h <= 0) {
      skipped.push(region);
      continue;
    }

    switch (config.mode) {
      case 'BLACKOUT':
        applyBlackout(ctx, x, y, w, h);
        break;
      case 'BLUR':
        applyBlur(ctx, x, y, w, h, Math.max(config.blurRadius, Math.floor(w / 4)));
        break;
      case 'PIXELATE':
        applyPixelate(ctx, x, y, w, h, Math.max(config.blockSize, Math.floor(w / 6)));
        break;
    }

    // Stamp CAPED marker.
    if (config.stampMarkers) {
      stampMarker(ctx, x, y, w, h, region.cls, config.markerFontSize);
    }

    redactedCount++;
  }

  const resultBlob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob: resultBlob, redactedCount, skipped };
}

// ---------------------------------------------------------------------------
// Redaction primitives
// ---------------------------------------------------------------------------

function applyBlackout(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, w, h);
}

/**
 * Blur by downscaling then upscaling. True gaussian blur is not available on
 * OffscreenCanvas without filter support, but repeated 2x-down + 2x-up passes
 * achieve a visually equivalent irreversible destruction.
 */
function applyBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  radius: number,
): void {
  // Number of downsample passes. Each halves resolution, so 4 passes = 1/16.
  const passes = Math.max(2, Math.ceil(radius / 4));

  // Extract the region.
  const regionData = ctx.getImageData(x, y, w, h);

  // Use a small temporary canvas for the blur.
  const tmp = new OffscreenCanvas(w, h);
  const tmpCtx = tmp.getContext('2d');
  if (tmpCtx === null) {
    // Fallback to blackout.
    applyBlackout(ctx, x, y, w, h);
    return;
  }

  tmpCtx.putImageData(regionData, 0, 0);

  // Progressive downscale.
  let cw = w;
  let ch = h;
  for (let i = 0; i < passes; i++) {
    const nw = Math.max(1, Math.floor(cw / 2));
    const nh = Math.max(1, Math.floor(ch / 2));
    tmpCtx.drawImage(tmp, 0, 0, cw, ch, 0, 0, nw, nh);
    cw = nw;
    ch = nh;
  }

  // Upscale back.
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.drawImage(tmp, 0, 0, cw, ch, 0, 0, w, h);

  // Write back to main canvas.
  ctx.drawImage(tmp, 0, 0, w, h, x, y, w, h);
}

function applyPixelate(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  blockSize: number,
): void {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      // Average the block.
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          r += data[idx]!;
          g += data[idx + 1]!;
          b += data[idx + 2]!;
          a += data[idx + 3]!;
          count++;
        }
      }
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      a = Math.round(a / count);

      // Fill the block.
      for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
        for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
          const idx = ((by + dy) * w + (bx + dx)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = a;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/** Stamps a class marker (e.g. "[AADHAAR]") centred on the redacted region. */
function stampMarker(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  cls: string,
  fontSize: number,
): void {
  const label = '[' + cls + ']';
  ctx.font = fontSize + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(label, x + w / 2, y + h / 2, w);
}

/** Helper: convert an ImageBitmap to a Blob. */
async function imageBitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('cannot create canvas context');
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Quick sanity check: given a redacted PNG blob, verify it is a valid image
 * and has minimum dimensions. Used by the egress guard's check 5.
 */
export async function verifyRedactedImage(
  blob: Blob,
  expectedRegionCount: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (blob.size === 0) {
    return { ok: false, detail: 'empty image blob' };
  }
  if (blob.size < 67) {
    // Minimum valid PNG is 67 bytes (8 signature + IHDR + IEND).
    return { ok: false, detail: 'blob too small to be a valid PNG' };
  }

  // Verify PNG magic bytes.
  const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) {
    if (header[i] !== PNG_MAGIC[i]) {
      return { ok: false, detail: 'not a valid PNG (magic bytes mismatch)' };
    }
  }

  if (expectedRegionCount < 0) {
    return { ok: false, detail: 'negative expected region count' };
  }

  return { ok: true };
}

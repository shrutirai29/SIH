/**
 * Browser tab screenshot capture abstraction (Phase 1).
 *
 * Wraps browser.tabs.captureVisibleTab with deterministic parsing,
 * dimension verification, and fail-closed error handling.
 *
 * RULES.md:
 * - Local-only: raw captures never leave the extension without redaction + guard.
 * - Fail-closed: errors, invalid images, or missing APIs return null.
 * - Privacy: screenshot bytes/dataUrls are never logged or stored.
 */

import type browser from 'webextension-polyfill';

export interface CaptureOptions {
  /** Desired format: 'png' (default) or 'jpeg'. */
  readonly format?: 'png' | 'jpeg';
  /** Quality factor (1-100), applied only when format is 'jpeg'. */
  readonly quality?: number;
  /** Optional window ID; defaults to current window if omitted. */
  readonly windowId?: number;
}

export interface CapturedTab {
  /** Full data URL (data:image/...;base64,...). */
  readonly dataUrl: string;
  /** Binary blob representation. */
  readonly blob: Blob;
  /** Image width in pixels. */
  readonly width: number;
  /** Image height in pixels. */
  readonly height: number;
}

/**
 * Extracts width and height from a PNG byte stream via the IHDR chunk.
 * Returns null if the byte stream is not a valid PNG or has non-positive dimensions.
 */
export function extractPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // Minimum PNG with IHDR chunk is 24 bytes:
  // 8 (signature) + 4 (length) + 4 (chunk type "IHDR") + 4 (width) + 4 (height)
  if (bytes.length < 24) return null;

  const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return null;
  }

  // Verify IHDR chunk type: bytes[12..15] === 'IHDR'
  if (
    bytes[12] !== 0x49 || // I
    bytes[13] !== 0x48 || // H
    bytes[14] !== 0x44 || // D
    bytes[15] !== 0x52    // R
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);

  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Extracts width and height from a JPEG byte stream by scanning for SOF markers.
 * Returns null if the byte stream is not a valid JPEG or has non-positive dimensions.
 */
export function extractJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // JPEG starts with SOI: 0xFF, 0xD8
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

  let offset = 2;
  const len = bytes.length;

  while (offset < len) {
    if (bytes[offset] !== 0xFF) return null;
    while (offset < len && bytes[offset] === 0xFF) offset++;
    if (offset >= len) return null;

    const marker = bytes[offset++];
    if (marker === undefined) break;

    // End of Image marker
    if (marker === 0xD9) break;
    // Standalone markers with no payload (TEM, RST0..RST7)
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;

    if (offset + 2 > len) return null;
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    if (b0 === undefined || b1 === undefined) return null;
    const segmentLength = (b0 << 8) | b1;

    // SOF markers that encode frame dimensions:
    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2), SOF3 (0xC3),
    // SOF5..SOF7 (0xC5..0xC7), SOF9..SOF11 (0xC9..0xCB), SOF13..SOF15 (0xCD..0xCF)
    const isSof =
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF);

    if (isSof) {
      if (offset + 7 > len) return null;
      // segment payload starts after 2-byte length
      // [length: 2][sample precision: 1][height: 2][width: 2]
      const h0 = bytes[offset + 3];
      const h1 = bytes[offset + 4];
      const w0 = bytes[offset + 5];
      const w1 = bytes[offset + 6];
      if (h0 === undefined || h1 === undefined || w0 === undefined || w1 === undefined) {
        return null;
      }
      const height = (h0 << 8) | h1;
      const width = (w0 << 8) | w1;
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

/**
 * Parses a data URL string into mime type and raw bytes.
 * Handles both browser and node environments safely.
 */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return null;

  const header = dataUrl.slice(0, commaIdx);
  const base64 = dataUrl.slice(commaIdx + 1).trim();
  if (!base64 || !header.includes(';base64')) return null;

  const mimeMatch = header.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64$/);
  const mime = mimeMatch?.[1];
  if (!mime) return null;

  // Validate strict base64 character set and padding
  if (!BASE64_RE.test(base64)) {
    return null;
  }

  try {
    if (typeof atob === 'function') {
      const bin = atob(base64);
      if (bin.length === 0) return null;
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return { mime, bytes };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Converts a byte array to a standard base64 string.
 * Safe across browser, Web Worker, Service Worker, and Node.js environments.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } } };
  if (typeof g.Buffer !== 'undefined') {
    return g.Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Captures the currently visible tab area of the active window.
 *
 * Returns CapturedTab containing dataUrl, Blob, width, and height.
 * In case of any error, missing permission, unsupported format,
 * or corrupted image data, returns null without throwing.
 */
export async function captureActiveTab(
  options: CaptureOptions = {},
  browserInstance?: typeof browser,
): Promise<CapturedTab | null> {
  try {
    const activeBrowser =
      browserInstance ??
      (typeof (globalThis as unknown as { browser?: typeof browser }).browser !== 'undefined'
        ? (globalThis as unknown as { browser: typeof browser }).browser
        : undefined);

    const tabs = activeBrowser?.tabs;
    if (!tabs || typeof tabs.captureVisibleTab !== 'function') {
      return null;
    }

    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const details: { format: 'png' | 'jpeg'; quality?: number } = { format };

    if (format === 'jpeg' && typeof options.quality === 'number') {
      details.quality = Math.max(1, Math.min(100, Math.round(options.quality)));
    }

    let rawDataUrl: unknown;
    try {
      if (typeof options.windowId === 'number') {
        rawDataUrl = await tabs.captureVisibleTab(options.windowId, details);
      } else {
        rawDataUrl = await (tabs.captureVisibleTab as (opts: unknown) => Promise<string>)(details);
      }
    } catch {
      const gChrome = (globalThis as unknown as { chrome?: { tabs?: { captureVisibleTab?: (...args: unknown[]) => unknown } } }).chrome;
      if (typeof gChrome?.tabs?.captureVisibleTab === 'function') {
        rawDataUrl = await new Promise((resolve) => {
          try {
            if (typeof options.windowId === 'number') {
              gChrome!.tabs!.captureVisibleTab!(options.windowId, details, (res: string) => {
                resolve(res || null);
              });
            } else {
              gChrome!.tabs!.captureVisibleTab!(null, details, (res: string) => {
                resolve(res || null);
              });
            }
          } catch (chromeErr) {
            console.warn('[PRAHARI Capture] Native chrome capture failed:', chromeErr);
            resolve(null);
          }
        });
      }
    }

    if (!rawDataUrl || typeof rawDataUrl !== 'string') {
      return null;
    }

    const parsed = parseDataUrl(rawDataUrl);
    if (!parsed) {
      return null;
    }

    const { mime, bytes } = parsed;
    let dims: { width: number; height: number } | null = null;

    if (mime === 'image/png') {
      dims = extractPngDimensions(bytes);
    } else if (mime === 'image/jpeg') {
      dims = extractJpegDimensions(bytes);
    }

    if (!dims || dims.width <= 0 || dims.height <= 0) {
      return null;
    }

    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });

    return {
      dataUrl: rawDataUrl,
      blob,
      width: dims.width,
      height: dims.height,
    };
  } catch {
    // Fail-closed: Never crash, never leak or log screenshot contents.
    return null;
  }
}

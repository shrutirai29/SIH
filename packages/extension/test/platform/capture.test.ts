import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof (globalThis as unknown as { chrome?: unknown }).chrome === 'undefined') {
    (globalThis as unknown as { chrome: unknown }).chrome = { extension: {} };
  }
});

import {
  captureActiveTab,
  extractJpegDimensions,
  extractPngDimensions,
  parseDataUrl,
  bytesToBase64,
  type CaptureOptions,
} from '../../src/platform/capture.js';
import type browser from 'webextension-polyfill';

/**
 * Creates a valid minimal PNG array buffer with specified width and height.
 */
function makeValidPngBytes(width = 120, height = 80): Uint8Array {
  const buf = new ArrayBuffer(67);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // PNG signature
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) bytes[i] = sig[i]!;

  // IHDR length: 13
  view.setUint32(8, 13, false);
  // IHDR chunk type
  bytes[12] = 0x49; // I
  bytes[13] = 0x48; // H
  bytes[14] = 0x44; // D
  bytes[15] = 0x52; // R

  // Dimensions
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // color type: RGBA
  bytes[26] = 0; // compression
  bytes[27] = 0; // filter
  bytes[28] = 0; // interlace
  view.setUint32(29, 0, false); // CRC

  // IEND chunk
  view.setUint32(33, 0, false); // length = 0
  bytes[37] = 0x49; // I
  bytes[38] = 0x45; // E
  bytes[39] = 0x4E; // N
  bytes[40] = 0x44; // D
  view.setUint32(41, 0, false); // CRC

  return bytes;
}

/**
 * Creates a valid minimal JPEG array buffer with specified width and height.
 */
function makeValidJpegBytes(width = 200, height = 150): Uint8Array {
  // Minimal JPEG:
  // SOI (2 bytes): 0xFF 0xD8
  // SOF0 (10 bytes): 0xFF 0xC0, length (2 bytes: 8+3=11 or 8+3*components), precision (1), height (2), width (2), components (1), component details (3)
  // EOI (2 bytes): 0xFF 0xD9
  const bytes = new Uint8Array([
    0xFF, 0xD8,                         // SOI
    0xFF, 0xC0,                         // SOF0
    0x00, 0x0B,                         // segment length = 11
    0x08,                               // 8-bit precision
    (height >> 8) & 0xFF, height & 0xFF, // height
    (width >> 8) & 0xFF, width & 0xFF,   // width
    0x01,                               // 1 component (grayscale)
    0x01, 0x11, 0x00,                   // component ID, sampling, quant table
    0xFF, 0xD9,                         // EOI
  ]);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${base64}`;
}

describe('Browser Screenshot Capture Abstraction (Phase 1)', () => {
  describe('extractPngDimensions', () => {
    it('correctly parses width and height from valid PNG bytes', () => {
      const bytes = makeValidPngBytes(800, 600);
      const dims = extractPngDimensions(bytes);
      expect(dims).toEqual({ width: 800, height: 600 });
    });

    it('rejects short or truncated PNG header', () => {
      expect(extractPngDimensions(new Uint8Array(10))).toBeNull();
    });

    it('rejects invalid magic bytes', () => {
      const bytes = makeValidPngBytes(100, 100);
      bytes[0] = 0x00;
      expect(extractPngDimensions(bytes)).toBeNull();
    });

    it('rejects non-IHDR chunk type', () => {
      const bytes = makeValidPngBytes(100, 100);
      bytes[12] = 0x58; // replace 'I' with 'X'
      expect(extractPngDimensions(bytes)).toBeNull();
    });

    it('rejects non-positive dimensions', () => {
      const zeroWidth = makeValidPngBytes(0, 100);
      expect(extractPngDimensions(zeroWidth)).toBeNull();

      const zeroHeight = makeValidPngBytes(100, 0);
      expect(extractPngDimensions(zeroHeight)).toBeNull();
    });
  });

  describe('extractJpegDimensions', () => {
    it('correctly parses width and height from valid JPEG bytes', () => {
      const bytes = makeValidJpegBytes(1024, 768);
      const dims = extractJpegDimensions(bytes);
      expect(dims).toEqual({ width: 1024, height: 768 });
    });

    it('rejects non-JPEG magic bytes', () => {
      expect(extractJpegDimensions(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    });

    it('rejects zero or missing dimensions in SOF', () => {
      const zeroWidth = makeValidJpegBytes(0, 100);
      expect(extractJpegDimensions(zeroWidth)).toBeNull();
    });
  });

  describe('parseDataUrl', () => {
    it('extracts mime and decoded bytes from valid data URL', () => {
      const pngBytes = makeValidPngBytes(10, 10);
      const dataUrl = bytesToDataUrl(pngBytes, 'image/png');
      const parsed = parseDataUrl(dataUrl);
      expect(parsed).not.toBeNull();
      expect(parsed?.mime).toBe('image/png');
      expect(parsed?.bytes.length).toBe(pngBytes.length);
    });

    it('rejects non-image data URLs or malformed URLs', () => {
      expect(parseDataUrl('not-a-data-url')).toBeNull();
      expect(parseDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull();
      expect(parseDataUrl('data:image/png;utf8,plain')).toBeNull();
      expect(parseDataUrl('data:image/png;base64,')).toBeNull();
    });

    it('rejects corrupted base64 data', () => {
      expect(parseDataUrl('data:image/png;base64,!!!invalid_base64!!!')).toBeNull();
    });
  });

  describe('captureActiveTab', () => {
    it('1. Successful capture conversion for PNG', async () => {
      const pngBytes = makeValidPngBytes(640, 480);
      const dataUrl = bytesToDataUrl(pngBytes, 'image/png');

      const mockTabs = {
        captureVisibleTab: vi.fn().mockResolvedValue(dataUrl),
      };
      const mockBrowser = { tabs: mockTabs } as unknown as typeof browser;

      const result = await captureActiveTab({}, mockBrowser);

      expect(result).not.toBeNull();
      expect(result?.width).toBe(640);
      expect(result?.height).toBe(480);
      expect(result?.dataUrl).toBe(dataUrl);
      expect(result?.blob).toBeInstanceOf(Blob);
      expect(result?.blob.type).toBe('image/png');
      expect(result?.blob.size).toBe(pngBytes.length);

      // Verify arguments passed to captureVisibleTab
      expect(mockTabs.captureVisibleTab).toHaveBeenCalledWith({ format: 'png' });
    });

    it('1b. Successful capture conversion for JPEG with options and windowId', async () => {
      const jpegBytes = makeValidJpegBytes(320, 240);
      const dataUrl = bytesToDataUrl(jpegBytes, 'image/jpeg');

      const mockTabs = {
        captureVisibleTab: vi.fn().mockResolvedValue(dataUrl),
      };
      const mockBrowser = { tabs: mockTabs } as unknown as typeof browser;

      const options: CaptureOptions = {
        format: 'jpeg',
        quality: 85,
        windowId: 42,
      };

      const result = await captureActiveTab(options, mockBrowser);

      expect(result).not.toBeNull();
      expect(result?.width).toBe(320);
      expect(result?.height).toBe(240);
      expect(result?.blob.type).toBe('image/jpeg');

      expect(mockTabs.captureVisibleTab).toHaveBeenCalledWith(42, {
        format: 'jpeg',
        quality: 85,
      });
    });

    it('2. Capture API failure -> controlled null behavior', async () => {
      // Missing tabs API
      expect(await captureActiveTab({}, {} as unknown as typeof browser)).toBeNull();

      // captureVisibleTab rejects
      const throwingBrowser = {
        tabs: {
          captureVisibleTab: vi.fn().mockRejectedValue(new Error('Cannot capture tab in current state')),
        },
      } as unknown as typeof browser;
      expect(await captureActiveTab({}, throwingBrowser)).toBeNull();

      // captureVisibleTab returns undefined
      const undefinedBrowser = {
        tabs: {
          captureVisibleTab: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as typeof browser;
      expect(await captureActiveTab({}, undefinedBrowser)).toBeNull();
    });

    it('3. Invalid/unsupported capture result -> controlled failure', async () => {
      // Non-string return
      const nonStringBrowser = {
        tabs: {
          captureVisibleTab: vi.fn().mockResolvedValue(12345),
        },
      } as unknown as typeof browser;
      expect(await captureActiveTab({}, nonStringBrowser)).toBeNull();

      // Corrupted image data (not PNG magic bytes)
      const badMagic = bytesToDataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'image/png');
      const badMagicBrowser = {
        tabs: {
          captureVisibleTab: vi.fn().mockResolvedValue(badMagic),
        },
      } as unknown as typeof browser;
      expect(await captureActiveTab({}, badMagicBrowser)).toBeNull();

      // Zero dimensions
      const zeroDims = bytesToDataUrl(makeValidPngBytes(0, 0), 'image/png');
      const zeroDimsBrowser = {
        tabs: {
          captureVisibleTab: vi.fn().mockResolvedValue(zeroDims),
        },
      } as unknown as typeof browser;
      expect(await captureActiveTab({}, zeroDimsBrowser)).toBeNull();
    });

    it('4. No network request occurs during capture', async () => {
      const pngBytes = makeValidPngBytes(100, 100);
      const dataUrl = bytesToDataUrl(pngBytes, 'image/png');

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const mockTabs = {
        captureVisibleTab: vi.fn().mockResolvedValue(dataUrl),
      };
      const mockBrowser = { tabs: mockTabs } as unknown as typeof browser;

      const result = await captureActiveTab({}, mockBrowser);

      expect(result).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('5. No screenshot data is logged to console', async () => {
      const pngBytes = makeValidPngBytes(100, 100);
      const dataUrl = bytesToDataUrl(pngBytes, 'image/png');

      const logSpy = vi.spyOn(console, 'log');
      const infoSpy = vi.spyOn(console, 'info');
      const warnSpy = vi.spyOn(console, 'warn');
      const errorSpy = vi.spyOn(console, 'error');

      const mockTabs = {
        captureVisibleTab: vi.fn().mockResolvedValue(dataUrl),
      };
      const mockBrowser = { tabs: mockTabs } as unknown as typeof browser;

      const result = await captureActiveTab({}, mockBrowser);
      expect(result).not.toBeNull();

      const allCalls = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].flat().map(String);

      // Verify that no call logged any portion of the dataUrl or base64
      for (const msg of allCalls) {
        expect(msg).not.toContain('data:image');
        expect(msg).not.toContain(dataUrl);
      }

      logSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('bytesToBase64', () => {
    it('correctly encodes binary data to base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      expect(bytesToBase64(bytes)).toBe('SGVsbG8=');
    });

    it('correctly encodes larger byte chunks without stack overflow', () => {
      const large = new Uint8Array(100_000);
      for (let i = 0; i < large.length; i++) large[i] = i % 256;
      const b64 = bytesToBase64(large);
      expect(b64.length).toBeGreaterThan(0);
      expect(b64.length % 4).toBe(0);
    });
  });
});

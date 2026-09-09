import { describe, expect, it, vi } from 'vitest';
import {
  derivePiiPixelRegions,
  redactCapturedTab,
  type RedactedScreenshot,
} from '../../src/platform/visual-redactor.js';
import type { CapturedTab } from '../../src/platform/capture.js';
import type { SSG } from '@prahari/ssg';
import type { DiffRow } from '@prahari/kavach';

/**
 * Creates a minimal valid PNG blob for testing.
 */
function makeTestPng(width = 100, height = 100): Blob {
  const buf = new ArrayBuffer(67);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) bytes[i] = sig[i]!;

  view.setUint32(8, 13, false);
  bytes[12] = 0x49; bytes[13] = 0x48; bytes[14] = 0x44; bytes[15] = 0x52; // IHDR
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8; bytes[25] = 6; bytes[26] = 0; bytes[27] = 0; bytes[28] = 0;
  view.setUint32(29, 0, false); // CRC

  view.setUint32(33, 0, false); // IEND
  bytes[37] = 0x49; bytes[38] = 0x45; bytes[39] = 0x4E; bytes[40] = 0x44;
  view.setUint32(41, 0, false);

  return new Blob([buf], { type: 'image/png' });
}

function makeMockSsg(overrides: Partial<SSG> = {}): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_010203040506',
    trace_id: 't_0',
    step: 0,
    tier: 1,
    purpose: 'assist-user-task',
    goal: 'Test goal',
    viewport: {
      w: 1000,
      h: 800,
      dpr: 2,
      scroll_y: 0,
      doc_h: 800,
    },
    page: {
      origin_class: 'example.com',
      path_shape: '/form',
      title: 'Test Form',
      lang: 'en',
      page_type: 'form',
      sensitivity: 'semi_private',
    },
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        tag: 'input',
        bbox: [100, 150, 200, 50],
        visible: true,
        actionable: ['type'],
        value: '⟦AADHAAR_0⟧',
      },
      {
        id: 'e2',
        role: 'button',
        tag: 'button',
        bbox: [100, 250, 100, 40],
        visible: true,
        actionable: ['click'],
        name: 'Submit',
      },
    ],
    redaction_manifest: {
      policy_id: 'in-default-v1',
      counts: { AADHAAR: 1 },
      methods: { placeholder: 1 },
      detectors: ['regex-in@0.2'],
      coverage_confidence: 1.0,
    },
    ...overrides,
  };
}

describe('Visual Redaction Contract & Coordinate Pipeline (Phase 2)', () => {
  describe('derivePiiPixelRegions', () => {
    it('3. Coordinate transformation is correct with device-pixel-ratio scaling', () => {
      const ssg = makeMockSsg();
      // Viewport is 1000x800, Screenshot is 2000x1600 (scaleX = 2, scaleY = 2)
      const res = derivePiiPixelRegions(ssg, { width: 2000, height: 1600 });

      expect(res.ok).toBe(true);
      expect(res.scaleX).toBe(2);
      expect(res.scaleY).toBe(2);
      expect(res.regions).toHaveLength(1);

      const r = res.regions[0]!;
      expect(r.elementId).toBe('e1');
      expect(r.cls).toBe('AADHAAR');
      // DOM bbox was [100, 150, 200, 50] -> scaled by 2:
      expect(r.x).toBe(200);
      expect(r.y).toBe(300);
      expect(r.width).toBe(400);
      expect(r.height).toBe(100);
    });

    it('4. Device-pixel-ratio scaling is handled correctly (1.25x scaling)', () => {
      const ssg = makeMockSsg({
        viewport: { w: 800, h: 600, dpr: 1.25, scroll_y: 0, doc_h: 600 },
      });
      // Screenshot is 1000x750 (scale = 1.25)
      const res = derivePiiPixelRegions(ssg, { width: 1000, height: 750 });

      expect(res.ok).toBe(true);
      expect(res.scaleX).toBe(1.25);
      expect(res.scaleY).toBe(1.25);
      expect(res.regions).toHaveLength(1);

      const r = res.regions[0]!;
      // DOM bbox: [100, 150, 200, 50] -> * 1.25 = [125, 187.5 -> 188, 250, 62.5 -> 63]
      expect(r.x).toBe(125);
      expect(r.y).toBe(188);
      expect(r.width).toBe(250);
      expect(r.height).toBe(63);
    });

    it('5. Screenshot dimensions mismatch -> fail closed', () => {
      const ssg = makeMockSsg();
      // Viewport 1000x800 (aspect ratio 1.25), Screenshot 1200x500 (aspect ratio 2.4)
      const res = derivePiiPixelRegions(ssg, { width: 1200, height: 500 });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe('aspect_ratio_mismatch');
      expect(res.regions).toHaveLength(0);
    });

    it('5b. Invalid viewport dimensions -> fail closed', () => {
      const zeroViewport = makeMockSsg({
        viewport: { w: 0, h: 0, dpr: 1, scroll_y: 0, doc_h: 0 },
      });
      expect(derivePiiPixelRegions(zeroViewport, { width: 1000, height: 800 }).ok).toBe(false);

      const negativeViewport = makeMockSsg({
        viewport: { w: -100, h: 800, dpr: 1, scroll_y: 0, doc_h: 800 },
      });
      expect(derivePiiPixelRegions(negativeViewport, { width: 1000, height: 800 }).ok).toBe(false);
    });

    it('6. Partially off-screen PII region is clamped to viewport bounds', () => {
      const ssg = makeMockSsg({
        elements: [
          {
            id: 'e_partial',
            role: 'textbox',
            tag: 'input',
            // partially scrolled off the top-left: x=-20, y=-10, w=100, h=50
            bbox: [-20, -10, 100, 50],
            visible: true,
            actionable: ['type'],
            value: '⟦PAN_0⟧',
          },
        ],
      });
      const res = derivePiiPixelRegions(ssg, { width: 1000, height: 800 });

      expect(res.ok).toBe(true);
      expect(res.regions).toHaveLength(1);
      const r = res.regions[0]!;
      // Clamped to [0, 0, 80, 40]
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
      expect(r.width).toBe(80);
      expect(r.height).toBe(40);
    });

    it('6b. Completely off-screen PII region is safely omitted from visual redaction', () => {
      const ssg = makeMockSsg({
        elements: [
          {
            id: 'e_offscreen',
            role: 'textbox',
            tag: 'input',
            // completely scrolled above viewport: y=-200, h=50
            bbox: [100, -200, 200, 50],
            visible: false,
            actionable: ['type'],
            value: '⟦AADHAAR_0⟧',
          },
        ],
      });
      const res = derivePiiPixelRegions(ssg, { width: 1000, height: 800 });

      expect(res.ok).toBe(true);
      // Not on screen -> no pixels exist to redact
      expect(res.regions).toHaveLength(0);
    });

    it('6c. Missing or invalid bounding box -> safely skipped', () => {
      const ssg = makeMockSsg({
        elements: [
          {
            id: 'e_invalid_bbox',
            role: 'textbox',
            tag: 'input',
            // @ts-expect-error test malformed bbox
            bbox: [100, 100, 0, -10],
            visible: true,
            actionable: ['type'],
            value: '⟦AADHAAR_0⟧',
          },
        ],
      });
      const res = derivePiiPixelRegions(ssg, { width: 1000, height: 800 });
      expect(res.ok).toBe(true);
      expect(res.regions).toHaveLength(0);
    });

    it('Respects diff rows when provided', () => {
      const ssg = makeMockSsg({
        elements: [
          {
            id: 'e99',
            role: 'textbox',
            tag: 'input',
            bbox: [50, 50, 100, 30],
            visible: true,
            actionable: ['type'],
            // name does not have tokens, but diff identifies it
            name: 'masked_field',
          },
        ],
      });
      const diff: DiffRow[] = [
        {
          elementId: 'e99',
          label: 'Secret',
          cls: 'PHONE',
          preview: '98****3210',
          token: '⟦PHONE_0⟧',
          sources: ['dom'],
          confidence: 1.0,
          reversible: true,
        },
      ];

      const res = derivePiiPixelRegions(ssg, { width: 1000, height: 800 }, diff);
      expect(res.ok).toBe(true);
      expect(res.regions).toHaveLength(1);
      expect(res.regions[0]?.cls).toBe('PHONE');
      expect(res.regions[0]?.elementId).toBe('e99');
    });
  });

  describe('Pixel-level verification & security invariants', () => {
    it('1 & 2. Proves that pixels in the sensitive region actually changed and non-PII pixels remain unchanged', async () => {
      // Create a deterministic in-memory pixel buffer for testing (100x100 RGBA).
      // Initial state: filled completely with white pixels (255, 255, 255, 255).
      const W = 100;
      const H = 100;
      const pixelBuffer = new Uint8ClampedArray(W * H * 4);
      pixelBuffer.fill(255); // All white

      // Mock OffscreenCanvas that operates directly on pixelBuffer
      class MockOffscreenCanvas {
        readonly width: number;
        readonly height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext(type: string) {
          if (type !== '2d') return null;
          return {
            fillStyle: '#000000',
            font: '14px monospace',
            textAlign: 'center',
            textBaseline: 'middle',
            drawImage: vi.fn(),
            fillText: vi.fn(),
            fillRect: (x: number, y: number, w: number, h: number) => {
              // Modify pixelBuffer: blackout region [x..x+w, y..y+h] to 0
              for (let py = Math.max(0, y); py < Math.min(H, y + h); py++) {
                for (let px = Math.max(0, x); px < Math.min(W, x + w); px++) {
                  const idx = (py * W + px) * 4;
                  pixelBuffer[idx] = 0;     // R
                  pixelBuffer[idx + 1] = 0; // G
                  pixelBuffer[idx + 2] = 0; // B
                  pixelBuffer[idx + 3] = 255; // A
                }
              }
            },
            getImageData: (x: number, y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                  const srcIdx = ((y + py) * W + (x + px)) * 4;
                  const dstIdx = (py * w + px) * 4;
                  data[dstIdx] = pixelBuffer[srcIdx] ?? 0;
                  data[dstIdx + 1] = pixelBuffer[srcIdx + 1] ?? 0;
                  data[dstIdx + 2] = pixelBuffer[srcIdx + 2] ?? 0;
                  data[dstIdx + 3] = pixelBuffer[srcIdx + 3] ?? 255;
                }
              }
              return { data, width: w, height: h };
            },
            putImageData: vi.fn(),
          };
        }
        async convertToBlob() {
          return makeTestPng(W, H);
        }
      }

      // Stub OffscreenCanvas and createImageBitmap globally for this test
      vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
      vi.stubGlobal('createImageBitmap', async () => ({
        width: W,
        height: H,
        close: vi.fn(),
      }));

      const ssg = makeMockSsg({
        viewport: { w: 100, h: 100, dpr: 1, scroll_y: 0, doc_h: 100 },
        elements: [
          {
            id: 'e_secret',
            role: 'textbox',
            tag: 'input',
            // Sensitive PII box located at x=20..60, y=20..40
            bbox: [20, 20, 40, 20],
            visible: true,
            actionable: ['type'],
            value: '⟦SECRET_0⟧',
          },
        ],
      });

      const captured: CapturedTab = {
        dataUrl: 'data:image/png;base64,dummy',
        blob: makeTestPng(W, H),
        width: W,
        height: H,
      };

      const result: RedactedScreenshot | null = await redactCapturedTab(captured, ssg);

      expect(result).not.toBeNull();
      expect(result?.redactedCount).toBe(1);
      expect(result?.sha256).toMatch(/^[0-9a-f]{64}$/);

      // Verify that pixel (30, 25) INSIDE the PII box is now black [0, 0, 0, 255]
      const insideIdx = (25 * W + 30) * 4;
      expect(pixelBuffer[insideIdx]).toBe(0);     // Redacted R
      expect(pixelBuffer[insideIdx + 1]).toBe(0); // Redacted G
      expect(pixelBuffer[insideIdx + 2]).toBe(0); // Redacted B

      // Verify that pixel (5, 5) OUTSIDE the PII box remains white [255, 255, 255, 255]
      const outsideIdx = (5 * W + 5) * 4;
      expect(pixelBuffer[outsideIdx]).toBe(255);     // Untouched R
      expect(pixelBuffer[outsideIdx + 1]).toBe(255); // Untouched G
      expect(pixelBuffer[outsideIdx + 2]).toBe(255); // Untouched B

      vi.unstubAllGlobals();
    });

    it('7. verifyRedactedImage failure -> screenshot is NOT eligible for transmission', async () => {
      // Mock canvas that produces an invalid (empty) blob
      class BrokenCanvas {
        readonly width = 100;
        readonly height = 100;
        getContext() {
          return {
            fillStyle: '#000000',
            fillRect: vi.fn(),
            fillText: vi.fn(),
            drawImage: vi.fn(),
          };
        }
        async convertToBlob() {
          return new Blob([]); // Empty blob -> fails verifyRedactedImage
        }
      }

      vi.stubGlobal('OffscreenCanvas', BrokenCanvas);
      vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close: vi.fn() }));

      const ssg = makeMockSsg({
        viewport: { w: 100, h: 100, dpr: 1, scroll_y: 0, doc_h: 100 },
        elements: [
          {
            id: 'e_test',
            role: 'textbox',
            tag: 'input',
            bbox: [10, 10, 20, 20],
            visible: true,
            actionable: ['type'],
            value: '⟦AADHAAR_0⟧',
          },
        ],
      });
      const captured: CapturedTab = {
        dataUrl: 'data:image/png;base64,dummy',
        blob: makeTestPng(100, 100),
        width: 100,
        height: 100,
      };

      const result = await redactCapturedTab(captured, ssg);
      // Must return null (ineligible for transmission)
      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('8. Raw screenshot is never sent to network', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const ssg = makeMockSsg();
      const captured: CapturedTab = {
        dataUrl: 'data:image/png;base64,sensitive_raw_screenshot_data',
        blob: makeTestPng(1000, 800),
        width: 1000,
        height: 800,
      };

      await redactCapturedTab(captured, ssg);

      // Verify no network activity occurred
      expect(fetchSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('9. No screenshot data is logged to console', async () => {
      const logSpy = vi.spyOn(console, 'log');
      const infoSpy = vi.spyOn(console, 'info');
      const warnSpy = vi.spyOn(console, 'warn');
      const errorSpy = vi.spyOn(console, 'error');

      const ssg = makeMockSsg();
      const captured: CapturedTab = {
        dataUrl: 'data:image/png;base64,secret_base64_payload_string',
        blob: makeTestPng(1000, 800),
        width: 1000,
        height: 800,
      };

      await redactCapturedTab(captured, ssg);

      const allMessages = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].flat().map(String);

      for (const msg of allMessages) {
        expect(msg).not.toContain('secret_base64_payload_string');
        expect(msg).not.toContain('data:image');
      }

      logSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});

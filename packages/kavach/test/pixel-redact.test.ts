import { describe, expect, it } from 'vitest';
import { verifyRedactedImage } from '../src/redact/pixel.js';

/**
 * Creates a minimal valid PNG blob for testing.
 *
 * A real PNG has: 8 bytes signature + IHDR chunk (4 len + 4 type + 13 data + 4 CRC)
 * + IEND chunk (4 len + 4 type + 4 CRC). We pad to at least 67 bytes.
 */
function makeMinimalPng(width = 100, height = 100): Blob {
  // 8 (sig) + 25 (IHDR: 4+4+13+4) + 12 (IEND: 4+4+4) + padding = 45 minimum
  // We'll build 67+ bytes to pass the minimum size check.
  const buf = new ArrayBuffer(67);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // PNG signature.
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) bytes[i] = sig[i]!;

  // IHDR chunk length (13).
  view.setUint32(8, 13, false);

  // IHDR chunk type.
  bytes[12] = 0x49; // I
  bytes[13] = 0x48; // H
  bytes[14] = 0x44; // D
  bytes[15] = 0x52; // R

  // IHDR data: width (4) + height (4) + bit_depth (1) + color_type (1) + ...
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;  // bit depth
  bytes[25] = 6;  // color type (RGBA)
  bytes[26] = 0;  // compression method
  bytes[27] = 0;  // filter method
  bytes[28] = 0;  // interlace method

  // CRC (simplified — verifyRedactedImage does not check CRC).
  view.setUint32(29, 0, false);

  // IEND chunk (empty, 12 bytes: 4 len + 4 type + 4 CRC).
  view.setUint32(33, 0, false); // length = 0
  bytes[37] = 0x49; // I
  bytes[38] = 0x45; // E
  bytes[39] = 0x4E; // N
  bytes[40] = 0x44; // D
  view.setUint32(41, 0, false); // CRC
  // Remaining bytes are zero padding (up to 67).

  return new Blob([buf], { type: 'image/png' });
}

describe('verifyRedactedImage', () => {
  it('accepts a valid PNG blob', async () => {
    const png = makeMinimalPng();
    const result = await verifyRedactedImage(png, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects an empty blob', async () => {
    const empty = new Blob([]);
    const result = await verifyRedactedImage(empty, 0);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('detail');
    if (!result.ok) expect(result.detail).toContain('empty');
  });

  it('rejects a blob that is too small to be PNG', async () => {
    const tiny = new Blob([new Uint8Array(10)]);
    const result = await verifyRedactedImage(tiny, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('too small');
  });

  it('rejects a blob with wrong magic bytes (not PNG)', async () => {
    // JPEG magic: FF D8 FF
    const jpegLike = new Uint8Array(100);
    jpegLike[0] = 0xFF;
    jpegLike[1] = 0xD8;
    jpegLike[2] = 0xFF;
    const result = await verifyRedactedImage(new Blob([jpegLike]), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('magic bytes');
  });

  it('rejects negative expected region count', async () => {
    const png = makeMinimalPng();
    const result = await verifyRedactedImage(png, -1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('negative');
  });

  it('accepts valid PNG with positive region count', async () => {
    const png = makeMinimalPng(1920, 1080);
    const result = await verifyRedactedImage(png, 5);
    expect(result.ok).toBe(true);
  });
});

describe('pixel redaction types', () => {
  it('PixelRedactMode accepts valid modes', async () => {
    // Type-level test: if this compiles, the types are correct.
    const { type } = await import('../src/redact/pixel.js');
    const modes: import('../src/redact/pixel.js').PixelRedactMode[] = [
      'BLACKOUT', 'BLUR', 'PIXELATE',
    ];
    expect(modes).toHaveLength(3);
  });

  it('PixelRegion has required fields', () => {
    const region: import('../src/redact/pixel.js').PixelRegion = {
      elementId: 'e17',
      cls: 'AADHAAR',
      x: 100,
      y: 200,
      width: 300,
      height: 50,
    };
    expect(region.cls).toBe('AADHAAR');
    expect(region.x).toBe(100);
  });
});

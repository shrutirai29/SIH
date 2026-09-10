import { describe, expect, it } from 'vitest';
import { OcrEngine } from '../src/vision/ocr.js';

describe('NETRA Visual OCR on Non-DOM Regions (Ticket C9)', () => {
  it('segments text line candidates from image regions with high horizontal contrast', async () => {
    const width = 200;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);

    // Fill white
    data.fill(255);

    // Simulate text lines: alternating dark text pixels between y=20..35 and y=50..65
    for (let y = 20; y < 35; y++) {
      for (let x = 20; x < 180; x += 3) {
        const idx = (y * width + x) * 4;
        data[idx] = 10;
        data[idx + 1] = 10;
        data[idx + 2] = 10;
      }
    }

    const img = { width, height, data } as unknown as ImageData;
    const ocr = new OcrEngine();
    const lines = await ocr.recognize(img);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]?.conf).toBeGreaterThan(0.6);
    expect(lines[0]?.bbox[3]).toBeGreaterThan(0); // Height > 0
  });

  it('handles empty image cleanly without error', async () => {
    const ocr = new OcrEngine();
    const lines = await ocr.recognize({ width: 0, height: 0, data: new Uint8ClampedArray() } as unknown as ImageData);
    expect(lines).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { NetraInferenceHost } from '../src/index.js';

describe('NETRA Inference Host Lifecycle & Operations', () => {
  it('initializes, executes detectors, reports stats, and closes cleanly', async () => {
    const host = new NetraInferenceHost();

    await host.init({
      deviceClass: 'B',
      ep: 'wasm',
      cores: 4,
      tier2BudgetMs: 450,
    });

    const dummyImg = {
      width: 100,
      height: 100,
      data: new Uint8ClampedArray(100 * 100 * 4),
    } as unknown as ImageData;

    // Detect widgets
    const widgets = await host.detectWidgets(dummyImg);
    expect(Array.isArray(widgets)).toBe(true);

    // OCR
    const ocrLines = await host.ocr(dummyImg);
    expect(Array.isArray(ocrLines)).toBe(true);

    // NER
    const nerSpans = await host.ner(['Born 15/08/1995 in Mumbai'], ['DOB', 'SALARY']);
    expect(nerSpans.length).toBeGreaterThanOrEqual(1);
    expect(nerSpans[0]?.label).toBe('DOB');

    // Stats
    const stats = host.stats();
    expect(stats.ep).toBe('wasm');
    expect(typeof stats.modelMs).toBe('object');

    host.close();
  });
});

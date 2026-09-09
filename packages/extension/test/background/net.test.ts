import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionPlan, RedactedText, SSG } from '@prahari/ssg';
import { createEgressGuard } from '@prahari/kavach';
import { Ledger, MemoryLedgerStore, sha256Hex } from '@prahari/kavach';
import { postStep } from '../../src/background/net.js';

const r = (s: string): RedactedText => s as RedactedText;

function makeTestPng(width = 100, height = 100): Blob {
  const buf = new ArrayBuffer(67);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) bytes[i] = sig[i]!;

  view.setUint32(8, 13, false);
  bytes[12] = 0x49; bytes[13] = 0x48; bytes[14] = 0x44; bytes[15] = 0x42; // IHDR
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8; bytes[25] = 6; bytes[26] = 0; bytes[27] = 0; bytes[28] = 0;
  view.setUint32(29, 0, false);

  view.setUint32(33, 0, false); // IEND
  bytes[37] = 0x49; bytes[38] = 0x45; bytes[39] = 0x4E; bytes[40] = 0x44;
  view.setUint32(41, 0, false);

  return new Blob([buf], { type: 'image/png' });
}

function cleanSsg(overrides: Partial<SSG> = {}): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_0123456789ab',
    trace_id: 't_0',
    step: 0,
    tier: 1,
    purpose: 'assist-user-task',
    goal: r('Test task goal'),
    viewport: { w: 1000, h: 800, dpr: 1, scroll_y: 0, doc_h: 800 },
    page: { origin_class: 'test.example', page_type: 'form', sensitivity: 'private' },
    elements: [
      { id: 'e1', role: 'button', bbox: [10, 10, 50, 20], actionable: ['click'] },
    ],
    redaction_manifest: {
      policy_id: 'in-default-v1',
      counts: {},
      methods: {},
      detectors: [],
      coverage_confidence: 1,
    },
    ...overrides,
  };
}

describe('net.ts — postStep and visual egress boundary', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes normal Tier-1 request without image to guard and sends on approval', async () => {
    const ssg = cleanSsg();
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({
      serverOrigin: 'https://api.prahari.test',
      ledger,
      allowInsecureLocalhost: true,
    });

    const mockPlan: ActionPlan = {
      plan_id: 'p_0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: false,
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockPlan,
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await postStep(guard, ssg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan).toEqual(mockPlan);
      expect(result.bytesSent).toBeGreaterThan(0);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes verified image Blob to guard when attachment is present', async () => {
    const pngBlob = makeTestPng(100, 100);
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    const sha = await sha256Hex(pngBytes);

    const ssg = cleanSsg({
      tier: 2,
      attachment: {
        screenshot: {
          format: 'png',
          w: 100,
          h: 100,
          sha256: sha,
          redacted: true,
          data: 'some_base64_data',
        },
      },
    });

    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({
      serverOrigin: 'https://api.prahari.test',
      ledger,
      allowInsecureLocalhost: true,
    });

    const mockPlan: ActionPlan = {
      plan_id: 'p_1',
      trace_id: 't_0',
      actions: [{ op: 'done' }],
      done: true,
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockPlan,
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await postStep(guard, ssg, pngBlob);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.done).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('SECURITY INVARIANT: blocks when attachment exists but verified image Blob is absent', async () => {
    const ssg = cleanSsg({
      tier: 2,
      attachment: {
        screenshot: {
          format: 'png',
          w: 100,
          h: 100,
          sha256: 'a'.repeat(64),
          redacted: true,
          data: 'some_base64_data',
        },
      },
    });

    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({
      serverOrigin: 'https://api.prahari.test',
      ledger,
      allowInsecureLocalhost: true,
    });

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Call postStep with attachment but without image Blob
    const result = await postStep(guard, ssg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('blocked');
      expect(result.reason).toBe('IMAGE_UNVERIFIED');
    }
    // Fetch must NEVER be called
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

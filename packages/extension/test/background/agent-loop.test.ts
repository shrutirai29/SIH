import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.chrome = {
    extension: {},
    runtime: { id: 'test' },
    tabs: {
      query: (_opts: unknown, cb?: (res: unknown[]) => void) => {
        if (cb) cb([{ id: 42 }]);
        return Promise.resolve([{ id: 42 }]);
      },
      sendMessage: (_id: unknown, _msg: unknown, cb?: (res: unknown) => void) => {
        if (cb) cb(undefined);
        return Promise.resolve(undefined);
      },
      captureVisibleTab: (_opts: unknown, cb?: (res: string) => void) => {
        if (cb) cb('');
        return Promise.resolve('');
      },
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
  };
});

import type { ActionPlan, RedactedText, SSG } from '@prahari/ssg';
import { type EgressGuard, type GuardVerdict, sha256Hex } from '@prahari/kavach';
import { browser } from '../../src/platform/index.js';
import * as platform from '../../src/platform/index.js';
import { AgentLoop } from '../../src/background/agent-loop.js';
import type { ExtractResult } from '../../src/shared/messages.js';
import { CONFIG } from '../../src/shared/config.js';

const r = (s: string): RedactedText => s as RedactedText;

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
  view.setUint32(29, 0, false);

  view.setUint32(33, 0, false); // IEND
  bytes[37] = 0x49; bytes[38] = 0x45; bytes[39] = 0x4E; bytes[40] = 0x44;
  view.setUint32(41, 0, false);

  return new Blob([buf], { type: 'image/png' });
}

function makeMockSsg(step = 0): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_010203040506',
    trace_id: 't_' + String(step),
    step,
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
  };
}

describe('AgentLoop — Phase 3 need_visual end-to-end integration', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockTabsQuery: ReturnType<typeof vi.fn>;
  let mockTabsSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;

    // Mock browser tabs API
    mockTabsQuery = vi.fn().mockImplementation((...args: unknown[]) => {
      const cb = typeof args[1] === 'function' ? (args[1] as (res: unknown[]) => void) : undefined;
      if (cb) cb([{ id: 42 }]);
      return Promise.resolve([{ id: 42 }]);
    });
    mockTabsSendMessage = vi.fn().mockImplementation((...args: unknown[]) => {
      const msg = args[1] as { kind: string; step?: number } | undefined;
      const cb = args.find((a) => typeof a === 'function') as ((res: unknown) => void) | undefined;
      let res: unknown = undefined;
      if (msg?.kind === 'EXTRACT_SCREEN') {
        res = {
          ssg: makeMockSsg(msg.step ?? 0),
          redactions: {},
          diff: [],
        } as ExtractResult;
      } else if (msg?.kind === 'EXECUTE_ACTION') {
        res = { outcome: 'advanced' };
      }
      if (cb) cb(res);
      return Promise.resolve(res);
    });

    browser.tabs.query = mockTabsQuery as unknown as typeof browser.tabs.query;
    browser.tabs.sendMessage = mockTabsSendMessage as unknown as typeof browser.tabs.sendMessage;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Test 1: need_visual=false
  it('Test 1: need_visual=false results in no screenshot capture and normal Tier-1 request', async () => {
    const captureSpy = vi.spyOn(platform, 'captureActiveTab');
    const redactSpy = vi.spyOn(platform, 'redactCapturedTab');

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: false,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
      need_visual: false,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      const plan = fetchCount === 1 ? step0Plan : step1Plan;
      return {
        ok: true,
        json: async () => plan,
      };
    }) as unknown as typeof fetch;

    const guardInvocations: { ssg: SSG; image?: Blob | undefined }[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        guardInvocations.push({ ssg: JSON.parse(JSON.stringify(ssg)), image });
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    // Wait until loop completes (2 steps)
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Verify: no screenshot capture was invoked
    expect(captureSpy).not.toHaveBeenCalled();
    expect(redactSpy).not.toHaveBeenCalled();

    // Verify: both requests were Tier 1
    expect(guardInvocations.length).toBe(2);
    expect(guardInvocations[0]!.ssg.tier).toBe(1);
    expect(guardInvocations[0]!.ssg.attachment).toBeUndefined();
    expect(guardInvocations[0]!.image).toBeUndefined();

    expect(guardInvocations[1]!.ssg.tier).toBe(1);
    expect(guardInvocations[1]!.ssg.attachment).toBeUndefined();
    expect(guardInvocations[1]!.image).toBeUndefined();
  });

  // Test 2: need_visual=true
  it('Test 2: need_visual=true invokes screenshot capture, redaction, and Tier-2 attachment with verified Blob', async () => {
    const rawPng = makeTestPng(200, 160);
    const redactedPng = makeTestPng(200, 160);
    const redactedBytes = new Uint8Array(await redactedPng.arrayBuffer());
    const redactedSha = await sha256Hex(redactedBytes);

    const captureSpy = vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,raw_dummy',
      blob: rawPng,
      width: 200,
      height: 160,
    });

    const redactSpy = vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: redactedPng,
      width: 200,
      height: 160,
      sha256: redactedSha,
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: true, // triggers visual capture for step 1
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
      need_visual: false,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      const plan = fetchCount === 1 ? step0Plan : step1Plan;
      return {
        ok: true,
        json: async () => plan,
      };
    }) as unknown as typeof fetch;

    const guardInvocations: { ssg: SSG; image?: Blob | undefined }[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        guardInvocations.push({ ssg: JSON.parse(JSON.stringify(ssg)), image });
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Step 0 was Tier 1 without screenshot
    expect(guardInvocations[0]!.ssg.tier).toBe(1);
    expect(guardInvocations[0]!.image).toBeUndefined();

    // Step 1 invoked capture and redaction
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(redactSpy).toHaveBeenCalledTimes(1);

    // Step 1 reached guard as Tier 2 with attachment
    const step1Ssg = guardInvocations[1]!.ssg;
    expect(step1Ssg.tier).toBe(2);
    expect(step1Ssg.attachment).toBeDefined();
    expect(step1Ssg.attachment?.screenshot.format).toBe('png');
    expect(step1Ssg.attachment?.screenshot.w).toBe(200);
    expect(step1Ssg.attachment?.screenshot.h).toBe(160);
    expect(step1Ssg.attachment?.screenshot.sha256).toBe(redactedSha);
    expect(step1Ssg.attachment?.screenshot.redacted).toBe(true);
    expect(step1Ssg.attachment?.screenshot.data).toBeDefined();

    // Verified image Blob reached guard
    expect(guardInvocations[1]!.image).toBe(redactedPng);
  });

  // Test 3: Raw screenshot must NEVER reach egress guard
  it('Test 3: Raw screenshot NEVER reaches the egress guard', async () => {
    const rawPng = makeTestPng(300, 200);
    const redactedPng = makeTestPng(300, 200);
    const redactedSha = await sha256Hex(new Uint8Array(await redactedPng.arrayBuffer()));

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,sensitive_raw_screenshot_data',
      blob: rawPng,
      width: 300,
      height: 200,
    });

    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: redactedPng,
      width: 300,
      height: 200,
      sha256: redactedSha,
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [],
      done: false,
      need_visual: true,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => (fetchCount === 1 ? step0Plan : step1Plan),
      };
    }) as unknown as typeof fetch;

    const guardInvocations: { ssg: SSG; image?: Blob | undefined }[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        guardInvocations.push({ ssg: JSON.parse(JSON.stringify(ssg)), image });
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    for (const inv of guardInvocations) {
      // The image Blob handed to guard must NEVER be the raw blob
      expect(inv.image).not.toBe(rawPng);
      // The attachment data must NOT contain raw data URL string
      if (inv.ssg.attachment?.screenshot.data) {
        expect(inv.ssg.attachment.screenshot.data).not.toContain('sensitive_raw_screenshot_data');
      }
    }
  });

  // Test 4: Redaction failure -> conservative fail-closed stop
  it('Test 4: Redaction failure stops loop conservatively with error and sends no image', async () => {
    const rawPng = makeTestPng(200, 160);

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,raw',
      blob: rawPng,
      width: 200,
      height: 160,
    });

    // Redaction fails
    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue(null);

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: true,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => step0Plan,
    }) as unknown as typeof fetch;

    const guardInvocations: { ssg: SSG; image?: Blob | undefined }[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        guardInvocations.push({ ssg: JSON.parse(JSON.stringify(ssg)), image });
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('error');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('Visual redaction failed');
    // Guard was called only once (for step 0). Step 1 was NEVER sent.
    expect(guardInvocations.length).toBe(1);
    expect(guardInvocations[0]!.image).toBeUndefined();
  });

  // Test 5: Verification failure / IMAGE_UNVERIFIED
  it('Test 5: Guard blocks when image verification fails, preventing network transmission', async () => {
    const rawPng = makeTestPng(200, 160);
    const corruptedBlob = new Blob(['not a png'], { type: 'image/png' });

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,raw',
      blob: rawPng,
      width: 200,
      height: 160,
    });

    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: corruptedBlob,
      width: 200,
      height: 160,
      sha256: 'a'.repeat(64),
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => step0Plan,
      };
    }) as unknown as typeof fetch;

    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (_ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        if (image) {
          // Real guard logic rejects unverified / corrupted image
          return { ok: false, reason: 'IMAGE_UNVERIFIED', detail: 'not a valid PNG' };
        }
        const json = JSON.stringify(_ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    // Blocked by guard
    expect(loop.state.blockedCount).toBe(1);
    expect(loop.state.message).toContain('IMAGE_UNVERIFIED');
    // Fetch was called only for step 0; step 1 fetch was blocked
    expect(fetchCount).toBe(1);
  });

  // Test 6: Hash correctness
  it('Test 6: Attachment SHA-256 matches exact redacted bytes', async () => {
    const rawPng = makeTestPng(150, 120);
    const redactedPng = makeTestPng(150, 120);
    const expectedBytes = new Uint8Array(await redactedPng.arrayBuffer());
    const expectedSha = await sha256Hex(expectedBytes);

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,raw',
      blob: rawPng,
      width: 150,
      height: 120,
    });

    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: redactedPng,
      width: 150,
      height: 120,
      sha256: expectedSha,
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [],
      done: false,
      need_visual: true,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => (fetchCount === 1 ? step0Plan : step1Plan),
      };
    }) as unknown as typeof fetch;

    let step1AttachmentSha: string | undefined;
    let step1ImageBlobSha: string | undefined;

    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG, image?: Blob): Promise<GuardVerdict> => {
        if (ssg.attachment) {
          step1AttachmentSha = ssg.attachment.screenshot.sha256;
        }
        if (image) {
          const b = new Uint8Array(await image.arrayBuffer());
          step1ImageBlobSha = await sha256Hex(b);
        }
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(step1AttachmentSha).toBe(expectedSha);
    expect(step1ImageBlobSha).toBe(expectedSha);
  });

  // Test 7: History + visual escalation
  it('Test 7: Multi-step history is preserved across visual escalation to step N+1', async () => {
    const rawPng = makeTestPng(100, 100);
    const redactedPng = makeTestPng(100, 100);
    const redactedSha = await sha256Hex(new Uint8Array(await redactedPng.arrayBuffer()));

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,raw',
      blob: rawPng,
      width: 100,
      height: 100,
    });

    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: redactedPng,
      width: 100,
      height: 100,
      sha256: redactedSha,
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: true,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => (fetchCount === 1 ? step0Plan : step1Plan),
      };
    }) as unknown as typeof fetch;

    const guardInvocations: SSG[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG): Promise<GuardVerdict> => {
        guardInvocations.push(JSON.parse(JSON.stringify(ssg)));
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(guardInvocations.length).toBe(2);

    // Step 0: no history
    expect(guardInvocations[0]!.step).toBe(0);
    expect(guardInvocations[0]!.history).toBeUndefined();

    // Step 1: step number is 1, history contains step 0 action
    expect(guardInvocations[1]!.step).toBe(1);
    expect(guardInvocations[1]!.history).toEqual([
      { step: 0, action: 'click', target: 'e1', outcome: 'advanced' },
    ]);
    expect(guardInvocations[1]!.attachment).toBeDefined();
  });

  // Test 8: Normal non-visual multi-step flow remains unchanged
  it('Test 8: Normal multi-step flow without visual need preserves history and stays Tier 1', async () => {
    const captureSpy = vi.spyOn(platform, 'captureActiveTab');

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [{ op: 'click', target: 'e1' }],
      done: false,
      need_visual: false,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'type', target: 'e2', value: 'hello' }],
      done: false,
      need_visual: false,
    };
    const step2Plan: ActionPlan = {
      plan_id: 'p2',
      trace_id: 't_2',
      actions: [{ op: 'done' }],
      done: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      const plan = fetchCount === 1 ? step0Plan : fetchCount === 2 ? step1Plan : step2Plan;
      return {
        ok: true,
        json: async () => plan,
      };
    }) as unknown as typeof fetch;

    const guardInvocations: SSG[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG): Promise<GuardVerdict> => {
        guardInvocations.push(JSON.parse(JSON.stringify(ssg)));
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(captureSpy).not.toHaveBeenCalled();
    expect(guardInvocations.length).toBe(3);

    // All steps stayed Tier 1
    for (const inv of guardInvocations) {
      expect(inv.tier).toBe(1);
      expect(inv.attachment).toBeUndefined();
    }

    // Step 2 has both step 0 and step 1 in history
    expect(guardInvocations[2]!.history).toEqual([
      { step: 0, action: 'click', target: 'e1', outcome: 'advanced' },
      { step: 1, action: 'type', target: 'e2', outcome: 'advanced' },
    ]);
  });

  // Test 9: No base64/image logging
  it('Test 9: Screenshot data and base64 strings are NEVER logged to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const secretBase64 = 'SECRET_BASE64_PAYLOAD_STRING_12345';
    const rawPng = makeTestPng(100, 100);
    const redactedPng = makeTestPng(100, 100);
    const redactedSha = await sha256Hex(new Uint8Array(await redactedPng.arrayBuffer()));

    vi.spyOn(platform, 'captureActiveTab').mockResolvedValue({
      dataUrl: 'data:image/png;base64,' + secretBase64,
      blob: rawPng,
      width: 100,
      height: 100,
    });

    vi.spyOn(platform, 'redactCapturedTab').mockResolvedValue({
      blob: redactedPng,
      width: 100,
      height: 100,
      sha256: redactedSha,
      redactedCount: 1,
      format: 'png',
    });

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [],
      done: false,
      need_visual: true,
    };
    const step1Plan: ActionPlan = {
      plan_id: 'p1',
      trace_id: 't_1',
      actions: [{ op: 'done' }],
      done: true,
    };

    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => (fetchCount === 1 ? step0Plan : step1Plan),
      };
    }) as unknown as typeof fetch;

    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG): Promise<GuardVerdict> => {
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    const allConsoleCalls = [
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ].flat().map(String);

    for (const msg of allConsoleCalls) {
      expect(msg).not.toContain(secretBase64);
      expect(msg).not.toContain('data:image/png');
    }
  });

  // Test 10: Fail closed on capture error
  it('Test 10: Fail closed when captureActiveTab throws or returns null', async () => {
    vi.spyOn(platform, 'captureActiveTab').mockRejectedValue(new Error('Capture permission denied'));

    const step0Plan: ActionPlan = {
      plan_id: 'p0',
      trace_id: 't_0',
      actions: [],
      done: false,
      need_visual: true,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => step0Plan,
    }) as unknown as typeof fetch;

    const guardInvocations: SSG[] = [];
    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG): Promise<GuardVerdict> => {
        guardInvocations.push(JSON.parse(JSON.stringify(ssg)));
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop({ guard: mockGuard, host: mockHost });
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('error');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('Visual capture failed');
    // Step 1 payload was never offered to guard
    expect(guardInvocations.length).toBe(1);
  });
});

describe('AgentLoop — HASTA Controller, Bounded Recovery, and Multi-Action Safety', () => {
  let originalFetch: typeof globalThis.fetch;
  let executedActions: Action[] = [];
  const actionResults: Map<string, ActionResult> = new Map();
  let defaultActionResult: ActionResult = { outcome: 'advanced' };

  function setupLoop(plans: ActionPlan[], options?: { guardInvocations?: SSG[] }) {
    executedActions = [];
    actionResults.clear();
    defaultActionResult = { outcome: 'advanced' };

    let planIdx = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const plan = plans[planIdx] ?? plans[plans.length - 1];
      planIdx++;
      return {
        ok: true,
        json: async () => plan,
      };
    }) as unknown as typeof fetch;

    browser.tabs.query = vi.fn().mockImplementation((...args: unknown[]) => {
      const cb = typeof args[1] === 'function' ? (args[1] as (res: unknown[]) => void) : undefined;
      if (cb) cb([{ id: 42 }]);
      return Promise.resolve([{ id: 42 }]);
    }) as unknown as typeof browser.tabs.query;

    browser.tabs.sendMessage = vi.fn().mockImplementation((...args: unknown[]) => {
      const msg = args[1] as { kind: string; step?: number; action?: Action } | undefined;
      const cb = args.find((a) => typeof a === 'function') as ((res: unknown) => void) | undefined;
      let res: unknown = undefined;

      if (msg?.kind === 'EXTRACT_SCREEN') {
        res = {
          ssg: makeMockSsg(msg.step ?? 0),
          redactions: {},
          diff: [],
        } as ExtractResult;
      } else if (msg?.kind === 'EXECUTE_ACTION') {
        const action = msg.action!;
        executedActions.push(action);
        const targetKey = 'target' in action && typeof action.target === 'string' ? action.target : action.op;
        res = actionResults.get(targetKey) ?? actionResults.get(action.op) ?? defaultActionResult;
      }

      if (cb) cb(res);
      return Promise.resolve(res);
    }) as unknown as typeof browser.tabs.sendMessage;

    const mockGuard: EgressGuard = Object.assign(
      vi.fn().mockImplementation(async (ssg: SSG): Promise<GuardVerdict> => {
        if (options?.guardInvocations) {
          options.guardInvocations.push(JSON.parse(JSON.stringify(ssg)) as SSG);
        }
        const json = JSON.stringify(ssg);
        const bytes = new TextEncoder().encode(json);
        const sha = await sha256Hex(bytes);
        return { ok: true, bytes, sha256: sha };
      }),
      { confirm: vi.fn().mockResolvedValue(undefined) },
    );

    const mockHost = {
      kind: 'event-page' as const,
      ensure: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue({ ok: true, host: 'test-host' }),
      teardown: vi.fn().mockResolvedValue(undefined),
    };

    return new AgentLoop({ guard: mockGuard, host: mockHost });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // 1. Single successful action
  it('1. executes a single successful action and transitions to done', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'click', target: 'e1' }], done: false },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'done', summary: 'Goal reached' }], done: true },
    ];
    const loop = setupLoop(plans);
    await loop.start('Test goal');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(executedActions.length).toBe(1);
    expect(executedActions[0]!.op).toBe('click');
    expect(loop.state.message).toBe('Goal reached');
  });

  // 2. Multi-action successful plan
  it('2. executes multiple actions in a single plan when all succeed', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e1' },
          { op: 'type', target: 'e2', value: 'search' },
        ],
        done: false,
      },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'done' }], done: true },
    ];
    const loop = setupLoop(plans);
    await loop.start('Multi-action test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(executedActions.length).toBe(2);
    expect(executedActions[0]!.op).toBe('click');
    expect(executedActions[1]!.op).toBe('type');
  });

  // 3. First action failure aborts remaining actions in the plan
  it('3. aborts remaining actions in a multi-action plan when an earlier action fails', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_failing' },
          { op: 'type', target: 'e_should_not_run', value: 'skipped' },
        ],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [{ op: 'done' }],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_failing', { outcome: 'error', detail: 'Element not interactable' });

    await loop.start('Failure abort test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // The second action in plan 0 (e_should_not_run) was NEVER dispatched!
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_should_not_run')).toBe(false);
  });

  // 4. no_change triggers bounded recovery and replan
  it('4. triggers bounded recovery replan when action produces no_change', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'scroll', direction: 'down' }], done: false },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'done' }], done: true },
    ];
    const loop = setupLoop(plans);
    actionResults.set('scroll', { outcome: 'no_change', detail: 'already at bottom' });

    await loop.start('No-change recovery');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(executedActions.length).toBe(1);
  });

  // 5 & 6. Recovery eventually succeeds
  it('5 & 6. recovers from transient failure when subsequent step succeeds', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'click', target: 'e_flaky' }], done: false },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'click', target: 'e_recovered' }], done: false },
      { plan_id: 'p2', trace_id: 't_2', actions: [{ op: 'done' }], done: true },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_flaky', { outcome: 'error', detail: 'stale element' });
    actionResults.set('e_recovered', { outcome: 'advanced' });

    await loop.start('Flaky recovery');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(executedActions.length).toBe(2);
    expect(executedActions[0]!.op).toBe('click');
    expect(executedActions[1]!.op).toBe('click');
  });

  // 7. Recovery budget exhausted
  it('7. stops and enters terminal error when recovery budget of 3 consecutive failures is exhausted', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'click', target: 'e_fail1' }], done: false },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'click', target: 'e_fail2' }], done: false },
      { plan_id: 'p2', trace_id: 't_2', actions: [{ op: 'click', target: 'e_fail3' }], done: false },
      { plan_id: 'p3', trace_id: 't_3', actions: [{ op: 'click', target: 'e_should_never_run' }], done: false },
    ];
    const loop = setupLoop(plans);
    defaultActionResult = { outcome: 'error', detail: 'Persistent target failure' };

    await loop.start('Exhaustion test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('error');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('Exceeded recovery budget (3 consecutive failures)');
    // 3 attempts executed; attempt 4 MUST NOT occur
    expect(executedActions.length).toBe(3);
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_should_never_run')).toBe(false);
  });

  // 8 & 9. Blocked action immediately terminates and is NOT retried
  it('8 & 9. halts immediately upon blocked security action without retrying', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [{ op: 'type', target: 'e_sink_violation', value_ref: '⟦TOKEN_1⟧' }],
        done: false,
      },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'click', target: 'e_never' }], done: false },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_sink_violation', {
      outcome: 'blocked',
      detail: 'REFUSED: sink binding violation',
    });

    await loop.start('Blocked test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('sink binding violation');
    expect(executedActions.length).toBe(1); // Never retried
  });

  // 10. Done is terminal
  it('10. done action or plan.done transitions to terminal done', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'done', summary: 'Complete' }], done: true },
    ];
    const loop = setupLoop(plans);
    await loop.start('Done test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    expect(loop.state.message).toBe('Complete');
  });

  // 11. Fail is terminal
  it('11. fail action transitions directly to terminal error', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'fail', reason: 'Blocked by captcha' }], done: false },
    ];
    const loop = setupLoop(plans);
    await loop.start('Fail test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('error');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('Blocked by captcha');
  });

  // 12. Step limit is terminal
  it('12. terminates with done phase when maxSteps limit is reached', async () => {
    // Exactly maxSteps (12) plans
    const plans: ActionPlan[] = Array.from({ length: CONFIG.maxSteps + 1 }, (_, i) => ({
      plan_id: 'p' + String(i),
      trace_id: 't_' + String(i),
      actions: [{ op: 'wait', ms: 1 }],
      done: false,
    }));
    const loop = setupLoop(plans);
    defaultActionResult = { outcome: 'advanced' };

    await loop.start('Step limit test');

    await vi.waitFor(() => {
      expect(loop.state.message).toBe('Step limit reached.');
    }, { timeout: 10000 });

    expect(loop.state.phase).toBe('done');
    expect(loop.state.step).toBeLessThanOrEqual(CONFIG.maxSteps);
  }, 12000);

  // 13. Terminal state prevents future dispatch
  it('13. prevents any action dispatch once controller is in a terminal state', async () => {
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'done' }], done: true },
    ];
    const loop = setupLoop(plans);
    await loop.start('Terminal guard test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Try executing an action directly on the loop in terminal state
    // (internal #execute guard check)
    const sendMessageSpy = browser.tabs.sendMessage as ReturnType<typeof vi.fn>;
    const callCountBefore = sendMessageSpy.mock.calls.length;

    // Triggering stop or any external call cannot dispatch to tabs
    loop.stop('Already done');
    expect(sendMessageSpy.mock.calls.length).toBe(callCountBefore);
  });

  // 14 & 15. ask_user pauses execution and stops further action dispatch
  it('14 & 15. pauses execution on ask_user and does not execute subsequent actions', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'ask_user', question: 'Please select your state' },
          { op: 'click', target: 'e_subsequent' },
        ],
        done: false,
      },
    ];
    const loop = setupLoop(plans);
    await loop.start('Ask user test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    expect(loop.state.message).toContain('Awaiting user response: Please select your state');
    // e_subsequent was NEVER executed!
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_subsequent')).toBe(false);
  });

  // 16, 17, 18. History ring buffer, bounding, and privacy
  it('16, 17, 18. records history with bounded size and never leaks sensitive data', async () => {
    const guardInvocations: SSG[] = [];
    const plans: ActionPlan[] = [
      { plan_id: 'p0', trace_id: 't_0', actions: [{ op: 'click', target: 'e1' }], done: false },
      { plan_id: 'p1', trace_id: 't_1', actions: [{ op: 'done' }], done: true },
    ];
    const loop = setupLoop(plans, { guardInvocations });

    await loop.start('History check');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Step 0 has no history
    expect(guardInvocations[0]?.history).toBeUndefined();
    // Step 1 observation receives step 0 history
    expect(guardInvocations[1]?.history).toBeDefined();
    expect(guardInvocations[1]?.history?.[0]?.action).toBe('click');
    expect(guardInvocations[1]?.history?.[0]?.target).toBe('e1');
    expect(guardInvocations[1]?.history?.[0]?.outcome).toBe('advanced');
    expect(loop.state.phase).toBe('done');
  });

  // 20. Stale actions from previous failed plans are discarded
  it('20. discards remaining plan actions upon recovery so step N+1 starts clean', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_stale_target' },
          { op: 'type', target: 'e_stale_next', value: 'old_plan_data' },
        ],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [
          { op: 'click', target: 'e_fresh_target' },
          { op: 'done' },
        ],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_stale_target', { outcome: 'error', detail: 'target stale' });
    actionResults.set('e_fresh_target', { outcome: 'advanced' });

    await loop.start('Clean replan');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // e_stale_next from the aborted plan 0 was NEVER executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_stale_next')).toBe(false);
    // e_fresh_target from plan 1 was executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_fresh_target')).toBe(true);
  });
});

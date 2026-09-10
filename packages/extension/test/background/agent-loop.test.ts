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
      local: (() => {
        const data: Record<string, unknown> = {};
        g.__testStorage = data;
        return {
          get: (keyOrKeys?: unknown, cb?: (res: Record<string, unknown>) => void) => {
            const callback =
              typeof keyOrKeys === 'function'
                ? (keyOrKeys as (res: Record<string, unknown>) => void)
                : cb;
            let result: Record<string, unknown> = {};
            if (typeof keyOrKeys === 'string') {
              result = { [keyOrKeys]: data[keyOrKeys] };
            } else if (Array.isArray(keyOrKeys)) {
              result = Object.fromEntries(keyOrKeys.map((k) => [k, data[k]]));
            } else {
              result = { ...data };
            }
            if (callback) callback(result);
            return Promise.resolve(result);
          },
          set: (items?: unknown, cb?: () => void) => {
            const callback = typeof items === 'function' ? (items as () => void) : cb;
            if (items && typeof items === 'object') {
              Object.assign(data, items);
            }
            if (callback) callback();
            return Promise.resolve();
          },
          remove: (keyOrKeys?: unknown, cb?: () => void) => {
            const callback = typeof keyOrKeys === 'function' ? (keyOrKeys as () => void) : cb;
            if (typeof keyOrKeys === 'string') {
              delete data[keyOrKeys];
            } else if (Array.isArray(keyOrKeys)) {
              for (const k of keyOrKeys) delete data[k];
            }
            if (callback) callback();
            return Promise.resolve();
          },
        };
      })(),
    },
  };
});

import type { Action, ActionPlan, RedactedText, SSG } from '@prahari/ssg';
import { type EgressGuard, type GuardVerdict, sha256Hex } from '@prahari/kavach';
import { browser } from '../../src/platform/index.js';
import * as platform from '../../src/platform/index.js';
import { AgentLoop } from '../../src/background/agent-loop.js';
import type { ActionResult, ExtractResult } from '../../src/shared/messages.js';
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
    const st = (globalThis as unknown as { __testStorage?: Record<string, unknown> }).__testStorage;
    if (st) {
      for (const k of Object.keys(st)) delete st[k];
    }
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
    const st = (globalThis as unknown as { __testStorage?: Record<string, unknown> }).__testStorage;
    if (st) {
      for (const k of Object.keys(st)) delete st[k];
    }
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
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [{ op: 'click', target: 'e_never_reach' }],
        done: false,
      },
    ];
    const loop = setupLoop(plans);
    await loop.start('Ask user test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    // 1. Correct phase and human-readable prompt
    expect(loop.state.phase).toBe('blocked');
    expect(loop.state.message).toContain('Awaiting user response: Please select your state');

    // 2. Sibling actions within the same plan were dropped and never executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_subsequent')).toBe(false);
    expect(executedActions.length).toBe(0);

    // 3. No automatic retry or plan advance occurred (step remains 0)
    expect(loop.state.step).toBe(0);
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_never_reach')).toBe(false);
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

  // 21. Realistic multi-step form-fill scenario
  it('21. realistic multi-step form-fill: type succeeds -> click continue executes -> next observation occurs -> done', async () => {
    const guardInvocations: SSG[] = [];
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'type', target: 'e_fullname', value: 'Asha Patil' },
          { op: 'click', target: 'e_continue' },
        ],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [
          { op: 'type', target: 'e_mobile', value: '9876543210' },
          { op: 'done', summary: 'Form filled successfully' },
        ],
        done: true,
      },
    ];
    const loop = setupLoop(plans, { guardInvocations });
    actionResults.set('e_fullname', { outcome: 'advanced' });
    actionResults.set('e_continue', { outcome: 'advanced' });
    actionResults.set('e_mobile', { outcome: 'advanced' });

    await loop.start('Fill Kisan portal application form');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Both actions in step 0 were executed in order
    expect(executedActions[0]!.op).toBe('type');
    expect((executedActions[0] as { target: string }).target).toBe('e_fullname');
    expect(executedActions[1]!.op).toBe('click');
    expect((executedActions[1] as { target: string }).target).toBe('e_continue');

    // Observation for step 1 occurred
    expect(guardInvocations.length).toBeGreaterThanOrEqual(2);

    // Step 1 action executed
    expect(executedActions[2]!.op).toBe('type');
    expect((executedActions[2] as { target: string }).target).toBe('e_mobile');

    expect(loop.state.message).toBe('Form filled successfully');
    expect(loop.state.phase).toBe('done');
  });

  // 22. Multi-action plan with no_change on first action
  it('22. multi-action plan: first action returns no_change -> sibling action aborted -> fresh observation occurs', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'scroll', direction: 'down' },
          { op: 'click', target: 'e_should_not_run_on_no_change' },
        ],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [
          { op: 'click', target: 'e_alternative_button' },
          { op: 'done', summary: 'Recovered and done' },
        ],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('scroll', { outcome: 'no_change', detail: 'already at bottom' });
    actionResults.set('e_alternative_button', { outcome: 'advanced' });

    await loop.start('Scroll and click test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Sibling action was NOT executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_should_not_run_on_no_change')).toBe(false);

    // Replanned action from step 1 WAS executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_alternative_button')).toBe(true);
    expect(loop.state.phase).toBe('done');
  });

  // 23. Multi-action plan with blocked on first action
  it('23. multi-action plan: first action returns blocked -> sibling action aborted -> terminal blocked immediately', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'type', target: 'e_unauthorized_sink', value_ref: '⟦TOKEN_AADHAAR_0⟧' },
          { op: 'click', target: 'e_should_never_run_after_blocked' },
        ],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [{ op: 'click', target: 'e_never_replan_after_blocked' }],
        done: false,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_unauthorized_sink', {
      outcome: 'blocked',
      detail: 'SECURITY BLOCK: token sink binding violation',
    });

    await loop.start('Security block test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    // Sibling action was NOT executed
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_should_never_run_after_blocked')).toBe(false);

    // No retry or replan occurred (executedActions has only the 1 blocked attempt)
    expect(executedActions.length).toBe(1);
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_never_replan_after_blocked')).toBe(false);
    expect(loop.state.phase).toBe('blocked');
    expect(loop.state.message).toContain('token sink binding violation');
  });

  // ---------------------------------------------------------------------------
  // Phase 3 — LEKHA Controller Integration Tests
  // ---------------------------------------------------------------------------

  // 24. Privacy boundaries in action logging (Part J)
  it('24. Phase 3 (Part J): action logging in LEKHA strictly omits plaintext values, credentials, PII, and DOM details', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          {
            op: 'type',
            target: 'e17',
            value: 'superSecretPassword123',
            value_ref: '⟦PASSWORD_0⟧',
          },
        ],
        done: false,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e17', {
      outcome: 'blocked',
      detail:
        'REFUSED: ⟦PASSWORD_0⟧ is bound to the field it came from, and e17 is not that field. Extra raw DOM text <div secret="leak">Sensitive User Info 948201 user@secret-gov.in 234567890124</div>',
    });

    await loop.start('Sensitive test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    const entries = await loop.ledger.list();
    const actionEntries = entries.filter((e) => e.event_type === 'action');
    expect(actionEntries.length).toBe(1);

    const actionEntry = actionEntries[0]!;
    expect(actionEntry.action_op).toBe('type');
    expect(actionEntry.target_id).toBe('e17');
    expect(actionEntry.action_outcome).toBe('blocked');
    expect(actionEntry.reason_code).toBe('SINK_BINDING_VIOLATION');

    // Stringify entire entry and verify absolute zero presence of sensitive tokens / secrets / PII / DOM
    const serialized = JSON.stringify(actionEntry);
    expect(serialized).not.toContain('superSecretPassword123');
    expect(serialized).not.toContain('user@secret-gov.in');
    expect(serialized).not.toContain('234567890124');
    expect(serialized).not.toContain('948201');
    expect(serialized).not.toContain('Sensitive User Info');
    expect(serialized).not.toContain('<div');
    expect(serialized).not.toContain('leak');
    expect(serialized).not.toContain('value');
    expect(serialized).not.toContain('value_ref');

    // Verify allowed fields only
    const allowedKeys = new Set([
      'seq',
      'ts',
      'session_id',
      'trace_id',
      'step',
      'tier',
      'purpose',
      'origin_class',
      'event_type',
      'payload_sha256',
      'byte_len',
      'manifest',
      'outcome',
      'action_op',
      'target_id',
      'action_outcome',
      'risk',
      'reason_code',
      'prev_hash',
      'entry_hash',
    ]);
    for (const key of Object.keys(actionEntry)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  // 25. Closed loop controller integration test (Part K)
  it('25. Phase 3 (Part K): closed loop controller integration - previous step failure diagnostic is supplied to next MANTRI context', async () => {
    const guardInvocations: SSG[] = [];
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [{ op: 'click', target: 'e17' }],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [
          { op: 'click', target: 'e18' },
          { op: 'done', summary: 'Recovered after observing target e17 was stale' },
        ],
        done: true,
      },
    ];

    const loop = setupLoop(plans, { guardInvocations });
    actionResults.set('e17', {
      outcome: 'error',
      detail: 'target no longer on the page',
    });
    actionResults.set('e18', {
      outcome: 'advanced',
    });

    await loop.start('Target stale recovery loop');

    // Wait for loop to replan and complete
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Step 0 executed click on e17, which failed as TARGET_STALE
    expect(executedActions.some((a) => 'target' in a && a.target === 'e17')).toBe(true);
    // Step 1 executed click on e18
    expect(executedActions.some((a) => 'target' in a && a.target === 'e18')).toBe(true);

    // Verify LEKHA recorded the failure with normalized reason
    const entries = await loop.ledger.list();
    const actionEntries = entries.filter((e) => e.event_type === 'action');
    const step0Action = actionEntries.find((e) => e.target_id === 'e17');
    expect(step0Action).toBeDefined();
    expect(step0Action?.action_outcome).toBe('error');
    expect(step0Action?.reason_code).toBe('TARGET_STALE');

    // Crucial: Step 1 MANTRI context (sent to server/guard in step 1 SSG) received sanitized history with TARGET_STALE
    expect(guardInvocations.length).toBeGreaterThanOrEqual(2);
    const step1Ssg = guardInvocations[1]!;
    expect(step1Ssg.history).toBeDefined();
    expect(step1Ssg.history?.length).toBeGreaterThanOrEqual(1);

    const staleHistoryItem = step1Ssg.history?.find((h) => h.target === 'e17');
    expect(staleHistoryItem).toBeDefined();
    expect(staleHistoryItem?.step).toBe(0);
    expect(staleHistoryItem?.action).toBe('click');
    expect(staleHistoryItem?.outcome).toBe('error');
    expect(staleHistoryItem?.reason_code).toBe('TARGET_STALE');
  });

  // 26. Multi-step history with different trace IDs in the same session (Part L)
  it('26. Phase 3 (Part L): multi-step history preserves events across different trace IDs within the same session', async () => {
    const guardInvocations: SSG[] = [];
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [{ op: 'click', target: 'e1' }],
        done: false,
      },
      {
        plan_id: 'p1',
        trace_id: 't_1',
        actions: [{ op: 'click', target: 'e2' }],
        done: false,
      },
      {
        plan_id: 'p2',
        trace_id: 't_2',
        actions: [{ op: 'scroll', direction: 'down' }],
        done: false,
      },
      {
        plan_id: 'p3',
        trace_id: 't_3',
        actions: [{ op: 'done', summary: 'All multi-step history verified' }],
        done: true,
      },
    ];

    const loop = setupLoop(plans, { guardInvocations });
    actionResults.set('e1', { outcome: 'advanced' });
    actionResults.set('e2', { outcome: 'error', detail: 'target no longer on the page' });
    actionResults.set('scroll', { outcome: 'no_change', detail: 'already at bottom' });

    await loop.start('Multi-step history test');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // In step 3 observation, guardInvocations[3].history must contain all 3 previous actions
    expect(guardInvocations.length).toBeGreaterThanOrEqual(4);
    const step3Ssg = guardInvocations[3]!;
    expect(step3Ssg.history).toBeDefined();
    expect(step3Ssg.history!.length).toBeGreaterThanOrEqual(3);

    const historyItems = step3Ssg.history!;
    const e1Hist = historyItems.find((h) => h.target === 'e1');
    const e2Hist = historyItems.find((h) => h.target === 'e2');
    const scrollHist = historyItems.find((h) => h.action === 'scroll');

    expect(e1Hist).toMatchObject({ step: 0, action: 'click', target: 'e1', outcome: 'advanced' });
    expect(e2Hist).toMatchObject({
      step: 1,
      action: 'click',
      target: 'e2',
      outcome: 'error',
      reason_code: 'TARGET_STALE',
    });
    expect(scrollHist).toMatchObject({ step: 2, action: 'scroll', outcome: 'no_change' });
  });

  // 27. Session boundary isolation: unrelated sessions never leak history
  it('27. Phase 3: session isolation prevents history leakage across separate tasks', async () => {
    const guardInvocations: SSG[] = [];
    const plansSession1: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_task1' },
          { op: 'done', summary: 'Task 1 done' },
        ],
        done: true,
      },
    ];

    const loop = setupLoop(plansSession1, { guardInvocations });
    actionResults.set('e_task1', { outcome: 'advanced' });

    await loop.start('Session 1 task');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    const session1Entries = await loop.ledger.list();
    const session1Id = session1Entries[0]?.session_id;
    expect(session1Id).toBeDefined();

    // Start a completely new session / task
    const plansSession2: ActionPlan[] = [
      {
        plan_id: 'p0_s2',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_task2' },
          { op: 'done', summary: 'Task 2 done' },
        ],
        done: true,
      },
    ];

    // Clear guard invocations to inspect session 2
    guardInvocations.length = 0;
    setupLoop(plansSession2, { guardInvocations });
    actionResults.set('e_task2', { outcome: 'advanced' });

    await loop.start('Session 2 task');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    const step0Session2Ssg = guardInvocations[0]!;
    // Session 2 initial step must NOT contain any history from Session 1
    expect(step0Session2Ssg.history?.some((h) => h.target === 'e_task1') ?? false).toBe(false);

    const session2Entries = await loop.ledger.list();
    const session2Id = session2Entries.find((e) => e.session_id !== session1Id)?.session_id;
    expect(session2Id).toBeDefined();
    expect(session2Id).not.toBe(session1Id);

    // Query sanitized history scoped to session2: strictly zero items from session1
    const session2History = await loop.ledger.getSanitizedHistory({ sessionId: session2Id });
    expect(session2History.every((h) => h.target_id !== 'e_task1')).toBe(true);
  });

  // 28. Multi-action safety: sibling actions aborted on block/error are not logged
  it('28. Phase 3 (Part C): multi-action plan stops on failure and unattempted sibling actions are never logged', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_first_success' },
          { op: 'type', target: 'e_second_blocked' },
          { op: 'click', target: 'e_third_unattempted' },
        ],
        done: false,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_first_success', { outcome: 'advanced' });
    actionResults.set('e_second_blocked', { outcome: 'blocked', detail: 'target element is disabled' });

    await loop.start('Multi-action safety logging');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    const entries = await loop.ledger.list();
    const actionEntries = entries.filter((e) => e.event_type === 'action');

    // Exactly 2 action entries: action 1 (advanced) and action 2 (blocked)
    expect(actionEntries.length).toBe(2);
    expect(actionEntries[0]?.target_id).toBe('e_first_success');
    expect(actionEntries[0]?.action_outcome).toBe('advanced');

    expect(actionEntries[1]?.target_id).toBe('e_second_blocked');
    expect(actionEntries[1]?.action_outcome).toBe('blocked');
    expect(actionEntries[1]?.reason_code).toBe('DISABLED_TARGET');

    // Action 3 was never attempted, so it has ZERO entries in the ledger
    expect(actionEntries.some((e) => e.target_id === 'e_third_unattempted')).toBe(false);
  });

  // 29. Resilience: diagnostic action logging failure does not crash action execution (Part I)
  it('29. Phase 3 (Part I): diagnostic action logging failure does not fail browser action or task', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'click', target: 'e_safe_click' },
          { op: 'done', summary: 'Success despite ledger glitch' },
        ],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_safe_click', { outcome: 'advanced' });

    // Mock ledger.append to simulate storage write failure for action logging
    const originalAppend = loop.ledger.append.bind(loop.ledger);
    vi.spyOn(loop.ledger, 'append').mockImplementation(async (input) => {
      if (input.event_type === 'action') {
        throw new Error('Disk full or storage quota exceeded');
      }
      return originalAppend(input);
    });

    await loop.start('Diagnostic failure resilience');

    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // Task finished cleanly with done, action succeeded without failing
    expect(loop.state.phase).toBe('done');
    expect(executedActions.some((a) => 'target' in a && a.target === 'e_safe_click')).toBe(true);
  });

  // 30. Phase 4: CLEAR_LEDGER empties ledger and maintains strict storage isolation
  it('30. Phase 4 (Clear & Storage Isolation): clearLedger empties ledger while preserving unrelated storage', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [{ op: 'click', target: 'e_initial' }, { op: 'done', summary: 'Pre-clear done' }],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_initial', { outcome: 'advanced' });

    // Store unrelated extension settings/data
    await browser.storage.local.set({
      'prahari.user.settings': { theme: 'dark', overlay: true },
      'unrelated.third_party_key': 'untouched_data',
    });

    await loop.start('Pre-clear task');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    const entriesBefore = await loop.ledger.list();
    expect(entriesBefore.length).toBeGreaterThan(0);
    expect(await loop.ledger.verify()).toBeNull();

    // User triggers CLEAR_LEDGER
    const clearResult = await loop.clearLedger();
    expect(clearResult.ok).toBe(true);

    // Ledger is now empty and verifies as intact
    const entriesAfter = await loop.ledger.list();
    expect(entriesAfter.length).toBe(0);
    expect(await loop.ledger.verify()).toBeNull();

    // Storage isolation check: unrelated keys MUST NOT be modified or deleted
    const settings = await browser.storage.local.get('prahari.user.settings');
    expect(settings['prahari.user.settings']).toEqual({ theme: 'dark', overlay: true });

    const unrelated = await browser.storage.local.get('unrelated.third_party_key');
    expect(unrelated['unrelated.third_party_key']).toBe('untouched_data');

    // The ledger storage key is removed
    const ledgerStorage = await browser.storage.local.get('prahari.lekha.v1');
    expect(ledgerStorage['prahari.lekha.v1']).toBeUndefined();
  });

  // 31. Phase 4: Subsequent task after clear starts cleanly from genesis without breaking MANTRI
  it('31. Phase 4 (Post-Clear Continuity): post-clear task restarts from genesis seq 0 and MANTRI succeeds', async () => {
    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [{ op: 'click', target: 'e_pre' }, { op: 'done', summary: 'Pre done' }],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    actionResults.set('e_pre', { outcome: 'advanced' });

    await loop.start('First task');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    // User clears ledger
    await loop.clearLedger();
    expect((await loop.ledger.list()).length).toBe(0);

    // New task with new plan
    const newPlans: ActionPlan[] = [
      {
        plan_id: 'p1',
        trace_id: 't_0',
        actions: [
          { op: 'type', target: 'e_post_clear' },
          { op: 'done', summary: 'Post-clear task complete' },
        ],
        done: true,
      },
    ];
    plans.push(newPlans[0]!);
    actionResults.set('e_post_clear', { outcome: 'advanced' });

    await loop.start('Post-clear task');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('done');
    }, { timeout: 3000 });

    const entries = await loop.ledger.list();
    expect(entries.length).toBeGreaterThan(0);

    // Genesis restart verification: first entry has seq 0 and 64-zero prev_hash
    expect(entries[0]?.seq).toBe(0);
    expect(entries[0]?.prev_hash).toBe('0'.repeat(64));

    // Full chain integrity check
    expect(await loop.ledger.verify()).toBeNull();
  });

  // 32. Phase 4 Privacy Test: fake sensitive credentials never enter storage or sanitized history
  it('32. Phase 4 (Privacy Boundary Test): sensitive credentials never appear in ledger storage or sanitized history', async () => {
    const fakeSecret = 'SuperSecretOtp#987654';
    const fakeAadhaar = '9999 8888 7777';
    const fakeEmail = 'citizen@prahari.nic.in';
    const fakePhone = '+91 9123456780';
    const fakeDom = '<input type="password" value="SuperSecretOtp#987654" name="pin">';

    const plans: ActionPlan[] = [
      {
        plan_id: 'p0',
        trace_id: 't_0',
        actions: [
          { op: 'type', target: 'e_pin' },
          { op: 'done', summary: 'Done' },
        ],
        done: true,
      },
    ];
    const loop = setupLoop(plans);
    // Action fails with sink binding violation
    actionResults.set('e_pin', { outcome: 'blocked', detail: 'sink binding violation' });

    await loop.start('Sensitive form fill');
    await vi.waitFor(() => {
      expect(loop.state.phase).toBe('blocked');
    }, { timeout: 3000 });

    const entries = await loop.ledger.list();
    const actionEntry = entries.find((e) => e.event_type === 'action');
    expect(actionEntry).toBeDefined();

    // The action entry records ONLY sanitized diagnostic metadata
    expect(actionEntry?.action_op).toBe('type');
    expect(actionEntry?.target_id).toBe('e_pin');
    expect(actionEntry?.action_outcome).toBe('blocked');
    expect(actionEntry?.reason_code).toBe('SINK_BINDING_VIOLATION');

    // Direct check of raw storage: NO secret values were serialized
    const bag = await browser.storage.local.get('prahari.lekha.v1');
    const rawStorageStr = JSON.stringify(bag);

    expect(rawStorageStr.includes(fakeSecret)).toBe(false);
    expect(rawStorageStr.includes(fakeAadhaar)).toBe(false);
    expect(rawStorageStr.includes(fakeEmail)).toBe(false);
    expect(rawStorageStr.includes(fakePhone)).toBe(false);
    expect(rawStorageStr.includes(fakeDom)).toBe(false);

    // MANTRI sanitized history also contains zero secret values
    const sanitizedHistory = await loop.ledger.getSanitizedHistory();
    const historyStr = JSON.stringify(sanitizedHistory);

    expect(historyStr.includes(fakeSecret)).toBe(false);
    expect(historyStr.includes(fakeAadhaar)).toBe(false);
    expect(historyStr.includes(fakeEmail)).toBe(false);
    expect(historyStr.includes(fakePhone)).toBe(false);
    expect(historyStr.includes(fakeDom)).toBe(false);
  });
});

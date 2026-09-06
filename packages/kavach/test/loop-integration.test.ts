/**
 * Walking-skeleton integration test.
 *
 * Spawns the real mock server and drives a real SSG through the real guard over a real
 * HTTP request. It is the automated form of the Phase-1 exit criterion "the loop runs"
 * minus the browser, which no CI runner has by default.
 *
 * What it proves:
 *   1. A redacted SSG passes the guard and the server accepts it.
 *   2. The server's independent ingress sweep catches a payload the client failed to
 *      redact - the check that makes the client's correctness verifiable by the
 *      receiver rather than self-asserted.
 *   3. The ledger records both outcomes with the exact payload hash.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedactedText, SSG } from '@prahari/ssg';
import { createEgressGuard, type EgressGuard } from '../src/egress-guard.js';
import { Ledger, MemoryLedgerStore } from '../src/ledger.js';
import { verhoeffChecksum } from '../src/detectors/l1-regex/validators/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../../../tools/mock-server/index.mjs');
const PORT = 8099;
const ORIGIN = 'http://localhost:' + String(PORT);

let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
}, 20_000);

afterAll(() => {
  server.kill();
});

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ORIGIN + '/v1/health');
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock server did not start');
}

const r = (s: string): RedactedText => s as RedactedText;

function ssg(overrides: Partial<SSG> = {}): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_aabbccdd1122',
    trace_id: 't_0',
    step: 0,
    tier: 1,
    purpose: 'assist-user-task',
    goal: r('Apply for the scheme using my saved profile'),
    viewport: { w: 1280, h: 720, dpr: 1, scroll_y: 0 },
    page: { origin_class: 'gov.in', page_type: 'form', sensitivity: 'private' },
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        bbox: [10, 10, 200, 30],
        name: r('Aadhaar Number'),
        value: r('⟦AADHAAR_1⟧'),
        redaction: { applied: true, class: 'AADHAAR', method: 'placeholder' },
        actionable: ['type'],
      },
    ],
    redaction_manifest: {
      policy_id: 'in-default-v0',
      counts: { AADHAAR: 1 },
      methods: { placeholder: 1 },
      detectors: ['dom-rules@0.1', 'regex-in@0.1'],
      coverage_confidence: 0.72,
    },
    ...overrides,
  };
}

/**
 * Mirrors `background/net.ts` without importing it (that module is browser-only).
 *
 * Including the `confirm()` in the `finally`, because that is now part of the contract
 * a caller of the guard has to honour: the guard opens an `attempted` record and the
 * network layer is what closes it.
 */
async function step(guardFn: EgressGuard, payload: SSG) {
  const verdict = await guardFn(payload);
  if (!verdict.ok) return { sent: false as const, reason: verdict.reason };

  let fate: 'sent' | 'failed' = 'failed';
  try {
    const res = await fetch(ORIGIN + '/v1/agent/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Same cast as `background/net.ts`: a Uint8Array is a valid BodyInit at runtime,
      // but the DOM lib types model it as a generic over ArrayBufferLike.
      body: verdict.bytes as unknown as BodyInit,
    });
    fate = 'sent';
    return { sent: true as const, status: res.status, body: await res.json(), sha: verdict.sha256 };
  } finally {
    await guardFn.confirm({
      ssg: payload,
      sha256: verdict.sha256,
      byteLen: verdict.bytes.byteLength,
      outcome: fate,
    });
  }
}

describe('walking skeleton: client guard -> wire -> server -> plan', () => {
  it('completes a full round trip with a redacted SSG', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({
      serverOrigin: ORIGIN,
      ledger,
      allowInsecureLocalhost: true,
    });

    const result = await step(guard, ssg());
    expect(result.sent).toBe(true);
    if (!result.sent) return;

    expect(result.status).toBe(200);
    const plan = result.body as { actions: { op: string }[]; done: boolean; trace_id: string };
    expect(plan.trace_id).toBe('t_0');
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0]?.op).toBe('scroll');

    // One egress, two rows: the guard's `attempted` and the wire's `sent`. Both name
    // the same bytes, and the chain over them still verifies.
    const entries = await ledger.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.outcome)).toEqual(['attempted', 'sent']);
    expect(entries[0]?.payload_sha256).toBe(result.sha);
    expect(entries[1]?.payload_sha256).toBe(result.sha);
    expect(await ledger.verify()).toBeNull();
  });

  it('reaches `done` once the server decides the task is finished', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({ serverOrigin: ORIGIN, ledger, allowInsecureLocalhost: true });

    const result = await step(guard, ssg({ step: 3, trace_id: 't_3' }));
    expect(result.sent).toBe(true);
    if (!result.sent) return;
    const plan = result.body as { done: boolean };
    expect(plan.done).toBe(true);
  });

  it('never reaches the wire when the payload still contains PII', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({ serverOrigin: ORIGIN, ledger, allowInsecureLocalhost: true });

    const payload = '23456789012';
    const realAadhaar = payload + String(verhoeffChecksum(payload));
    const leaky = ssg();
    leaky.elements[0]!.value = r(realAadhaar);

    const result = await step(guard, leaky);
    expect(result.sent).toBe(false);
    if (result.sent) return;
    expect(result.reason).toBe('PII_DETECTED');

    const entries = await ledger.list();
    expect(entries[0]?.outcome).toBe('blocked');
    expect(entries[0]?.byte_len).toBe(0);
  });

  it('the server independently rejects PII if the client guard is bypassed', async () => {
    // Deliberately skipping the guard, which is the one thing production code may never
    // do. This asserts the receiver checks too, so a client bug is loud, not silent.
    const leaky = ssg();
    leaky.elements[0]!.value = r('9876543210');

    const res = await fetch(ORIGIN + '/v1/agent/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(leaky),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('REDACTOR_FAILURE');
  });

  it('refuses an unknown contract version', async () => {
    const res = await fetch(ORIGIN + '/v1/agent/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ssg(), ssg_version: '2.0' }),
    });
    expect(res.status).toBe(409);
  });
});

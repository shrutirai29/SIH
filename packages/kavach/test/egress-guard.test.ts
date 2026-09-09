import { describe, expect, it } from 'vitest';
import type { RedactedText, SSG } from '@prahari/ssg';
import { createEgressGuard, type GuardFailure } from '../src/egress-guard.js';
import { Ledger, MemoryLedgerStore } from '../src/ledger.js';
import { verhoeffChecksum } from '../src/detectors/l1-regex/validators/index.js';

/** A real, checksum-valid Aadhaar. Built, not hard-coded, so it is unmistakably valid. */
const REAL_AADHAAR = (() => {
  const payload = '23456789012';
  return payload + String(verhoeffChecksum(payload));
})();

const r = (s: string): RedactedText => s as RedactedText;

function cleanSsg(overrides: Partial<SSG> = {}): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_0123456789ab',
    trace_id: 't_1',
    step: 0,
    tier: 1,
    purpose: 'fill-government-form',
    goal: r('Apply for the scheme using the saved profile'),
    viewport: { w: 1280, h: 720, dpr: 2, scroll_y: 0, doc_h: 3200 },
    page: {
      origin_class: 'gov.in',
      path_shape: '/scheme/*/apply',
      page_type: 'form',
      sensitivity: 'private',
    },
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        tag: 'input',
        input_type: 'text',
        bbox: [320, 412, 280, 40],
        name: r('Aadhaar Number'),
        value: r('⟦AADHAAR_1⟧'),
        redaction: { applied: true, class: 'AADHAAR', method: 'placeholder' },
        actionable: ['type', 'click', 'clear'],
      },
      {
        id: 'e2',
        role: 'button',
        name: r('Submit Application'),
        bbox: [320, 980, 280, 44],
        actionable: ['click'],
        client_risk: 'high',
        risk_reason: 'form_submit|origin=gov.in',
      },
    ],
    redaction_manifest: {
      policy_id: 'in-default-v1',
      counts: { AADHAAR: 1 },
      methods: { placeholder: 1 },
      detectors: ['dom-rules@0.1', 'regex-in@0.1'],
      coverage_confidence: 0.96,
    },
    ...overrides,
  };
}

function makeGuard(canaries: readonly string[] = []) {
  const ledger = new Ledger(new MemoryLedgerStore());
  const guard = createEgressGuard({
    serverOrigin: 'https://api.prahari.test',
    ledger,
    canaries,
  });
  return { guard, ledger };
}

describe('egress guard — the happy path', () => {
  it('passes a clean, schema-valid, fully redacted SSG', async () => {
    const { guard } = makeGuard();
    const verdict = await guard(cleanSsg());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(verdict.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('opens the record as `attempted`, because at that instant nothing has left', async () => {
    const { guard, ledger } = makeGuard();
    const verdict = await guard(cleanSsg());
    const entries = await ledger.list();
    expect(entries).toHaveLength(1);
    // NOT 'sent'. The guard has cleared the payload and handed over the bytes; whether
    // they reach a server is not something it can observe. Claiming otherwise made the
    // ledger assert an egress that never happened every time the server was down.
    expect(entries[0]?.outcome).toBe('attempted');
    if (verdict.ok) expect(entries[0]?.payload_sha256).toBe(verdict.sha256);
  });

  it('closes the record as `sent` once the caller confirms the bytes landed', async () => {
    const { guard, ledger } = makeGuard();
    const ssg = cleanSsg();
    const verdict = await guard(ssg);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    await guard.confirm({
      ssg,
      sha256: verdict.sha256,
      byteLen: verdict.bytes.byteLength,
      outcome: 'sent',
    });

    const entries = await ledger.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.outcome)).toEqual(['attempted', 'sent']);
    // Both halves attest to the same bytes, so the pair reads as one fact.
    expect(entries[1]?.payload_sha256).toBe(verdict.sha256);
    expect(await ledger.verify()).toBeNull();
  });

  it('closes the record as `failed` when the request never reached a server', async () => {
    const { guard, ledger } = makeGuard();
    const ssg = cleanSsg();
    const verdict = await guard(ssg);
    if (!verdict.ok) throw new Error('guard refused a clean payload');

    await guard.confirm({
      ssg,
      sha256: verdict.sha256,
      byteLen: verdict.bytes.byteLength,
      outcome: 'failed',
      detail: 'unreachable',
    });

    const entries = await ledger.list();
    // The claim this whole pairing exists to make: the ledger does not say `sent`
    // about bytes that never left the machine.
    expect(entries.map((e) => e.outcome)).toEqual(['attempted', 'failed']);
    expect(entries.some((e) => e.outcome === 'sent')).toBe(false);
    expect(entries[1]?.blocked_reason).toBe('unreachable');
    expect(await ledger.verify()).toBeNull();
  });

  it('never puts the payload itself in the ledger (RULES.md P8)', async () => {
    const { guard, ledger } = makeGuard();
    await guard(cleanSsg());
    const serialisedLedger = JSON.stringify(await ledger.list());
    expect(serialisedLedger).not.toContain('Aadhaar Number');
    expect(serialisedLedger).not.toContain('Submit Application');
  });
});

describe('egress guard — payloads that must be blocked', () => {
  /** Every case here is a leak shape. RULES.md T3: one crafted payload per check. */
  const cases: { name: string; reason: GuardFailure; ssg: () => SSG }[] = [
    {
      name: 'a real Aadhaar left in an element value',
      reason: 'PII_DETECTED',
      ssg: () => {
        const s = cleanSsg();
        s.elements[0]!.value = r(REAL_AADHAAR);
        return s;
      },
    },
    {
      name: 'an email address hiding in the page title',
      reason: 'PII_DETECTED',
      ssg: () => cleanSsg({ page: { ...cleanSsg().page, title: r('Inbox — asha@example.com') } }),
    },
    {
      name: 'a card number in a text block',
      reason: 'PII_DETECTED',
      ssg: () =>
        cleanSsg({
          text_blocks: [
            { id: 't1', bbox: [0, 0, 10, 10], source: 'dom', text: r('Card 4111 1111 1111 1111') },
          ],
        }),
    },
    {
      name: 'a JWT in the goal string',
      reason: 'PII_DETECTED',
      ssg: () =>
        cleanSsg({
          goal: r('use token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
        }),
    },
    {
      name: 'a half-written placeholder (redactor offset bug)',
      reason: 'MALFORMED_TOKEN',
      ssg: () => {
        const s = cleanSsg();
        s.elements[0]!.value = r('⟦AADHAAR_1');
        return s;
      },
    },
    {
      name: 'a base64 blob smuggled into a name',
      reason: 'HIGH_ENTROPY_BLOB',
      ssg: () => {
        const s = cleanSsg();
        s.elements[1]!.name = r('QWxhZGRpbjpvcGVuIHNlc2FtZTk4NzZhYmNkZWZnaGlqa2xtbm9wcXJz');
        return s;
      },
    },
    {
      name: 'a manifest that under-declares what was redacted',
      reason: 'MANIFEST_MISMATCH',
      ssg: () => {
        const s = cleanSsg();
        s.redaction_manifest = { ...s.redaction_manifest, counts: {} };
        return s;
      },
    },
    {
      name: 'an attachment declared but never verified',
      reason: 'IMAGE_UNVERIFIED',
      ssg: () =>
        cleanSsg({
          attachment: {
            screenshot: { format: 'jpeg', w: 768, h: 432, sha256: 'a'.repeat(64), redacted: true },
          },
        }),
    },
    {
      name: 'an unknown top-level field nobody redacted',
      reason: 'SCHEMA_INVALID',
      ssg: () => ({ ...cleanSsg(), notes: 'free text nobody scanned' }) as unknown as SSG,
    },
    {
      name: 'a malformed session id',
      reason: 'SCHEMA_INVALID',
      ssg: () => cleanSsg({ session_id: 'not-ephemeral' }),
    },
    {
      name: 'an element id that does not match the contract',
      reason: 'SCHEMA_INVALID',
      ssg: () => {
        const s = cleanSsg();
        s.elements[0]!.id = 'button-submit';
        return s;
      },
    },
  ];

  for (const c of cases) {
    it('blocks ' + c.name, async () => {
      const { guard } = makeGuard();
      const verdict = await guard(c.ssg());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(c.reason);
    });
  }

  it('blocks a planted canary', async () => {
    const canary = 'PRAHARI-CANARY-7f3a91c2e5';
    const { guard } = makeGuard([canary]);
    const s = cleanSsg();
    s.elements[1]!.name = r('Submit ' + canary);
    const verdict = await guard(s);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('CANARY_LEAK');
  });

  it('blocks a raw image even when the SSG itself is clean', async () => {
    const { guard } = makeGuard();
    const verdict = await guard(cleanSsg(), new Blob([new Uint8Array([1, 2, 3])]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('IMAGE_UNVERIFIED');
  });

  it('records blocked attempts in the ledger too', async () => {
    const { guard, ledger } = makeGuard();
    const s = cleanSsg();
    s.elements[0]!.value = r(REAL_AADHAAR);
    await guard(s);
    const entries = await ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('blocked');
    expect(entries[0]?.blocked_reason).toBe('PII_DETECTED');
    expect(entries[0]?.payload_sha256).toBe('');
  });

  it('never leaks the offending value into the failure detail (RULES.md P9)', async () => {
    const { guard } = makeGuard();
    const s = cleanSsg();
    s.elements[0]!.value = r(REAL_AADHAAR);
    const verdict = await guard(s);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.detail).not.toContain(REAL_AADHAAR);
  });
});

describe('egress guard — host allowlist', () => {
  it('refuses a plain-http destination', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({ serverOrigin: 'http://evil.test', ledger });
    const verdict = await guard(cleanSsg());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses a non-URL origin', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const guard = createEgressGuard({ serverOrigin: 'not a url', ledger });
    const verdict = await guard(cleanSsg());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('HOST_NOT_ALLOWED');
  });

  it('allows http://localhost only when explicitly opted in for development', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const strict = createEgressGuard({ serverOrigin: 'http://localhost:8080', ledger });
    expect((await strict(cleanSsg())).ok).toBe(false);

    const dev = createEgressGuard({
      serverOrigin: 'http://localhost:8080',
      ledger: new Ledger(new MemoryLedgerStore()),
      allowInsecureLocalhost: true,
    });
    expect((await dev(cleanSsg())).ok).toBe(true);
  });
});

describe('ledger chain', () => {
  it('links entries and detects tampering', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);
    const guard = createEgressGuard({
      serverOrigin: 'https://api.prahari.test',
      ledger,
    });

    await guard(cleanSsg({ trace_id: 't_1' }));
    await guard(cleanSsg({ trace_id: 't_2', step: 1 }));
    await guard(cleanSsg({ trace_id: 't_3', step: 2 }));

    expect(await ledger.verify()).toBeNull();

    const entries = await store.read();
    const tampered = entries.map((e, i) => (i === 1 ? { ...e, byte_len: 999_999 } : e));
    await store.write(tampered);

    expect(await ledger.verify()).toBe(1);
  });
});

describe('the guard never throws (fail-closed applies to its own bugs)', () => {
  it('turns an unexpected crash into a refusal, not an unhandled rejection', async () => {
    // Serialisation failing stands in for any internal fault with no specific handler.
    // Before this was fixed, such an exception surfaced as an unhandled promise
    // rejection: the agent loop stalled with no message, indistinguishable to the user
    // from a hang. This is how the CSP/EvalError bug actually presented.
    const realStringify = JSON.stringify;
    JSON.stringify = () => {
      throw new TypeError('cannot serialise: secret-looking-value');
    };

    try {
      const { guard } = makeGuard();
      const verdict = await guard(cleanSsg());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toBe('GUARD_ERROR');
        // P9: the error's name, never its message — a throw can carry page text.
        expect(verdict.detail).not.toContain('secret-looking-value');
      }
    } finally {
      JSON.stringify = realStringify;
    }
  });

  it('still prefers a specific reason when one exists', async () => {
    // A ledger that cannot be written has its own verdict; the catch-all must not
    // swallow the more informative answer.
    const exploding = new Ledger({
      read: () => Promise.resolve([]),
      write: () => Promise.reject(new TypeError('storage full')),
    });
    const guard = createEgressGuard({
      serverOrigin: 'https://api.prahari.test',
      ledger: exploding,
    });

    const verdict = await guard(cleanSsg());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('LEDGER_WRITE_FAILED');
  });

  it('validates without runtime code generation, so it survives the extension CSP', async () => {
    // The precompiled validator must work with `new Function` and `eval` removed from
    // the environment entirely — which is what MV3's `script-src 'self'` amounts to.
    const RealFunction = globalThis.Function;
    const trap = function trap(): never {
      throw new EvalError("'unsafe-eval' is not an allowed source of script");
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Function = trap;

    try {
      const { guard } = makeGuard();
      const verdict = await guard(cleanSsg());
      expect(verdict.ok).toBe(true);
    } finally {
      globalThis.Function = RealFunction;
    }
  });
});

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

describe('egress guard — visual attachment security invariant', () => {
  it('blocks payload with attachment when verified image Blob is absent (IMAGE_UNVERIFIED)', async () => {
    const { guard } = makeGuard();
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
    const verdict = await guard(ssg);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('IMAGE_UNVERIFIED');
      expect(verdict.detail).toContain('no image was verified');
    }
  });

  it('blocks payload with attachment when verified image Blob has mismatched sha256', async () => {
    const { guard } = makeGuard();
    const testPng = makeTestPng(100, 100);
    const ssg = cleanSsg({
      tier: 2,
      attachment: {
        screenshot: {
          format: 'png',
          w: 100,
          h: 100,
          sha256: '0'.repeat(64),
          redacted: true,
          data: 'some_base64_data',
        },
      },
    });
    const verdict = await guard(ssg, testPng);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('IMAGE_UNVERIFIED');
      expect(verdict.detail).toContain('sha256 does not match');
    }
  });

  it('passes payload with attachment when verified image Blob is valid and sha256 matches', async () => {
    const { guard } = makeGuard();
    const testPng = makeTestPng(100, 100);
    const { sha256Hex } = await import('../src/ledger.js');
    const buf = new Uint8Array(await testPng.arrayBuffer());
    const realSha = await sha256Hex(buf);
    const ssg = cleanSsg({
      tier: 2,
      attachment: {
        screenshot: {
          format: 'png',
          w: 100,
          h: 100,
          sha256: realSha,
          redacted: true,
          data: 'some_base64_data',
        },
      },
    });
    const verdict = await guard(ssg, testPng);
    expect(verdict.ok).toBe(true);
  });
});

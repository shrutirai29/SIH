/**
 * The canary suite.
 *
 * Plants 60 unique strings, runs real payloads through the real guard, and asserts
 * none of them reaches the wire. This is the test that turns "we redact PII" into a
 * claim that can fail, and per RULES.md T4 it is a blocking CI job.
 */

import { describe, expect, it } from 'vitest';
import type { RedactedText, SSG } from '@prahari/ssg';
import {
  CANARY_SURFACES,
  checkForLeaks,
  formatReport,
  generateCanaries,
  type Canary,
} from '../src/canary.js';
import { createEgressGuard } from '../src/egress-guard.js';
import { Ledger, MemoryLedgerStore } from '../src/ledger.js';
import { redactText } from '../src/redact/text.js';
import { Vault } from '../src/vault.js';

const ORIGIN = 'https://pmkisan.gov.in';
const r = (s: string): RedactedText => s as RedactedText;

function ssgWith(text: string, counts: Record<string, number> = {}): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_c0ffee123456',
    trace_id: 't_1',
    step: 0,
    tier: 1,
    purpose: 'canary-test',
    goal: r('canary run'),
    viewport: { w: 1280, h: 720, dpr: 1, scroll_y: 0 },
    page: { origin_class: 'gov.in', page_type: 'form', sensitivity: 'private' },
    elements: [
      { id: 'e1', role: 'textbox', bbox: [0, 0, 10, 10], value: r(text), actionable: ['type'] },
    ],
    redaction_manifest: {
      policy_id: 'canary',
      counts,
      methods: {},
      detectors: ['regex-in@0.2'],
      coverage_confidence: 0.55,
    },
  };
}

function makeGuard(canaries: readonly Canary[]) {
  const ledger = new Ledger(new MemoryLedgerStore());
  const guard = createEgressGuard({
    serverOrigin: 'https://api.prahari.test',
    ledger,
    canaries: canaries.map((c) => c.value),
  });
  return { guard, ledger };
}

describe('canary generation', () => {
  it('produces 60 canaries across all 12 surfaces', () => {
    const canaries = generateCanaries(5);
    expect(canaries).toHaveLength(60);
    expect(new Set(canaries.map((c) => c.surface)).size).toBe(CANARY_SURFACES.length);
  });

  it('produces globally unique values', () => {
    const canaries = generateCanaries(5);
    expect(new Set(canaries.map((c) => c.value)).size).toBe(canaries.length);
  });
});

describe('the guard blocks every canary, on every surface', () => {
  it('0 / 60 leaked', async () => {
    const canaries = generateCanaries(5);
    const { guard, ledger } = makeGuard(canaries);

    const sentPayloads: string[] = [];
    let blocked = 0;

    for (const canary of canaries) {
      const verdict = await guard(ssgWith('user data: ' + canary.value));
      if (verdict.ok) {
        sentPayloads.push(new TextDecoder().decode(verdict.bytes));
      } else {
        blocked++;
        expect(verdict.reason).toBe('CANARY_LEAK');
      }
    }

    expect(blocked).toBe(60);

    const report = checkForLeaks(sentPayloads.join('\n'), canaries);
    expect(formatReport(report)).toBe('0 / 60 leaked');
    expect(report.clean).toBe(true);

    // Every refusal is recorded, so the user can see the system defending itself.
    const entries = await ledger.list();
    expect(entries.filter((e) => e.outcome === 'blocked')).toHaveLength(60);
  });

  it('catches a canary hidden anywhere in the payload, not just in a known field', async () => {
    const canaries = generateCanaries(1);
    const canary = canaries[0]!;
    const { guard } = makeGuard(canaries);

    // A leak that lands in the page title, a text block or a manifest key is still a
    // leak. The guard scans the SERIALISED BYTES, so location does not matter.
    const inTitle = ssgWith('clean');
    inTitle.page.title = r('Portal — ' + canary.value);
    expect((await guard(inTitle)).ok).toBe(false);

    const inTextBlock = ssgWith('clean');
    inTextBlock.text_blocks = [
      { id: 't1', bbox: [0, 0, 1, 1], source: 'dom', text: r(canary.value) },
    ];
    expect((await guard(inTextBlock)).ok).toBe(false);

    const inGoal = ssgWith('clean');
    (inGoal as { goal: RedactedText }).goal = r('find ' + canary.value);
    expect((await guard(inGoal)).ok).toBe(false);
  });

  it('lets a genuinely clean payload through, so the test is not vacuous', async () => {
    const canaries = generateCanaries(5);
    const { guard } = makeGuard(canaries);
    const verdict = await guard(ssgWith('nothing sensitive here'));
    expect(verdict.ok).toBe(true);
  });
});

describe('the redactor removes real identifiers before the guard ever sees them', () => {
  async function redactedPayload(input: string): Promise<string> {
    const vault = new Vault();
    await vault.init();
    const result = await redactText(input, {
      vault,
      policy: { sitePack: 'gov' },
      originElementId: 'e1',
      originOrigin: ORIGIN,
    });

    const counts: Record<string, number> = {};
    for (const d of result.detections) counts[d.cls] = (counts[d.cls] ?? 0) + 1;

    const { guard } = makeGuard([]);
    const verdict = await guard(ssgWith(result.text, counts));
    expect(verdict.ok, 'guard should accept a properly redacted payload').toBe(true);
    return verdict.ok ? new TextDecoder().decode(verdict.bytes) : '';
  }

  const cases: [string, string][] = [
    ['a valid Aadhaar', '2345 6789 0124'],
    ['a PAN', 'ABCPE1234F'],
    ['an IFSC code', 'HDFC0001234'],
    ['an email address', 'asha.patil@example.com'],
    ['an Indian mobile number', '9876543210'],
    ['a payment card', '4111 1111 1111 1111'],
  ];

  for (const [label, value] of cases) {
    it('removes ' + label, async () => {
      const payload = await redactedPayload('The value is ' + value + ' as recorded.');
      expect(payload).not.toContain(value);
      // Digits without separators must not survive either.
      expect(payload).not.toContain(value.replace(/[\s-]/g, ''));
      // The surrounding text is preserved, because redaction is an encoding, not a
      // deletion — the server still needs to be able to read the sentence.
      expect(payload).toContain('The value is');
      expect(payload).toContain('as recorded.');
    });
  }

  it('preserves coreference so the server can still reason', async () => {
    const vault = new Vault();
    await vault.init();
    const opts = {
      vault,
      policy: { sitePack: 'gov' as const },
      originElementId: 'e1',
      originOrigin: ORIGIN,
    };
    const result = await redactText(
      'Applicant 2345 6789 0124 confirms that 2345 6789 0124 is correct.',
      opts,
    );
    // Same value -> same token, twice. This is what makes the sanitized text readable.
    const matches = result.text.match(/⟦AADHAAR_\d+⟧/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]);
  });

  it('drops a credential entirely rather than tokenising it', async () => {
    const vault = new Vault();
    await vault.init();
    const token = await vault.tokenFor({
      cls: 'PASSWORD',
      value: 'hunter2-secret',
      originElementId: 'e9',
      originOrigin: ORIGIN,
      reversible: true,
      confirmRequired: true,
    });
    // The credential is still DECLARED in the manifest even though its value was
    // dropped: the server is told that a password field exists and is masked, which is
    // what lets it reason "there is a credential here, ask the human" instead of
    // hallucinating over a gap. Omitting it would be under-reporting, and the guard's
    // check 6 refuses that.
    const { guard } = makeGuard([]);
    const verdict = await guard(ssgWith(token, { PASSWORD: 1 }));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      const payload = new TextDecoder().decode(verdict.bytes);
      expect(payload).not.toContain('hunter2-secret');
      expect(payload).toContain('⟦REDACTED_0⟧');
    }
  });
});

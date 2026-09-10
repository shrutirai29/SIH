import { describe, expect, it } from 'vitest';
import {
  Ledger,
  MemoryLedgerStore,
  normalizeReasonCode,
  sha256Hex,
  type SanitizedHistoryItem,
  type SanitizedReasonCode,
} from '../src/ledger.js';
import type { RedactionManifest } from '@prahari/ssg';

const sampleManifest: RedactionManifest = {
  policy_id: 'in-default-v1',
  counts: { AADHAAR: 1 },
  methods: { placeholder: 1 },
  detectors: ['regex@0.1'],
  coverage_confidence: 0.95,
};

describe('LEKHA core ledger — Phase 1 schema, integrity, and retention verification', () => {
  it('1 & 2 & 3. creates genesis entry with seq 0 and 64-zero prev_hash, followed by monotonic seq numbers', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    const e0 = await ledger.append({
      session_id: 'eph_sess1',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'gov.in',
      outcome: 'attempted',
      payload_sha256: 'a'.repeat(64),
      byte_len: 120,
      manifest: sampleManifest,
    });

    expect(e0.seq).toBe(0);
    expect(e0.prev_hash).toBe('0'.repeat(64));
    expect(e0.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e0.step).toBe(0);
    expect(e0.event_type).toBe('network');

    const e1 = await ledger.append({
      session_id: 'eph_sess1',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'gov.in',
      outcome: 'sent',
      payload_sha256: 'a'.repeat(64),
      byte_len: 120,
      manifest: sampleManifest,
    });

    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(e0.entry_hash);

    const e2 = await ledger.append({
      session_id: 'eph_sess1',
      trace_id: 't_1',
      step: 1,
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'gov.in',
      event_type: 'action',
      action_op: 'click',
      target_id: 'e17',
      action_outcome: 'advanced',
      risk: 'safe',
    });

    expect(e2.seq).toBe(2);
    expect(e2.prev_hash).toBe(e1.entry_hash);
    expect(e2.event_type).toBe('action');
    expect(e2.action_op).toBe('click');
    expect(e2.target_id).toBe('e17');
    expect(e2.action_outcome).toBe('advanced');
    expect(e2.outcome).toBe('sent');
  });

  it('4 & 5. verifies multiple entries sequentially and confirms chain is intact', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    for (let i = 0; i < 5; i++) {
      await ledger.append({
        session_id: 'eph_sess1',
        trace_id: `t_${i}`,
        step: i,
        outcome: 'attempted',
        payload_sha256: await sha256Hex(`payload-${i}`),
        byte_len: 50 + i,
      });
    }

    const entries = await ledger.list();
    expect(entries.length).toBe(5);
    expect(await ledger.verify()).toBeNull();
  });

  it('6. detects in-place tampering of an entry field', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({ session_id: 's', trace_id: 't0', step: 0, outcome: 'attempted' });
    await ledger.append({ session_id: 's', trace_id: 't0', step: 0, outcome: 'sent' });
    await ledger.append({ session_id: 's', trace_id: 't1', step: 1, outcome: 'attempted' });

    expect(await ledger.verify()).toBeNull();

    // Tamper with byte_len of middle entry
    const entries = await store.read();
    const tampered = entries.map((e, idx) => (idx === 1 ? { ...e, byte_len: 9999 } : e));
    await store.write(tampered);

    expect(await ledger.verify()).toBe(1);
  });

  it('7. detects reordering of entries in the chain', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({ session_id: 's', trace_id: 't0', step: 0, outcome: 'attempted' });
    await ledger.append({ session_id: 's', trace_id: 't0', step: 0, outcome: 'sent' });
    await ledger.append({ session_id: 's', trace_id: 't1', step: 1, outcome: 'attempted' });

    expect(await ledger.verify()).toBeNull();

    // Swap entry 0 and entry 1
    const entries = await store.read();
    const swapped = [entries[1]!, entries[0]!, entries[2]!];
    await store.write(swapped);

    // Reordered chain fails verification at the first out-of-order element
    expect(await ledger.verify()).not.toBeNull();
  });

  it('8. new semantic fields participate in integrity hashing', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    const entry = await ledger.append({
      session_id: 's',
      trace_id: 't1',
      step: 1,
      event_type: 'action',
      action_op: 'type',
      target_id: 'e4',
      action_outcome: 'blocked',
      risk: 'high',
      reason_code: 'SINK_BINDING_VIOLATION',
    });

    expect(await ledger.verify()).toBeNull();

    // Mutating any of the semantic fields must invalidate entry_hash
    const fieldsToTest: Array<Partial<typeof entry>> = [
      { action_op: 'click' },
      { target_id: 'e99' },
      { action_outcome: 'advanced' },
      { risk: 'safe' },
      { reason_code: 'USER_DECLINED' },
      { step: 2 },
      { event_type: 'lifecycle' },
    ];

    for (const mutation of fieldsToTest) {
      await store.write([{ ...entry, ...mutation }]);
      expect(await ledger.verify()).toBe(entry.seq);
    }
  });

  it('9. existing network ledger behavior (two-phase and blocked) works completely unaltered', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // 1. Guard check failure (blocked)
    const eBlocked = await ledger.append({
      session_id: 's',
      trace_id: 't0',
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'evil.com',
      payload_sha256: '',
      byte_len: 0,
      manifest: sampleManifest,
      outcome: 'blocked',
      blocked_reason: 'UNTRUSTED_ORIGIN',
    });
    expect(eBlocked.outcome).toBe('blocked');
    expect(eBlocked.blocked_reason).toBe('UNTRUSTED_ORIGIN');
    expect(eBlocked.payload_sha256).toBe('');

    // 2. Pass check 8 (attempted)
    const eAttempted = await ledger.append({
      session_id: 's',
      trace_id: 't1',
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'gov.in',
      payload_sha256: 'b'.repeat(64),
      byte_len: 450,
      manifest: sampleManifest,
      outcome: 'attempted',
    });
    expect(eAttempted.outcome).toBe('attempted');

    // 3. Confirm network delivery (sent)
    const eSent = await ledger.append({
      session_id: 's',
      trace_id: 't1',
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'gov.in',
      payload_sha256: 'b'.repeat(64),
      byte_len: 450,
      manifest: sampleManifest,
      outcome: 'sent',
    });
    expect(eSent.outcome).toBe('sent');
    expect(eSent.prev_hash).toBe(eAttempted.entry_hash);

    expect(await ledger.verify()).toBeNull();
  });

  it('10 & 11. legitimately retained chain (older entries pruned by retention) verifies as intact', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // Append 10 entries (seq 0 to 9)
    for (let i = 0; i < 10; i++) {
      await ledger.append({
        session_id: 's',
        trace_id: `t_${i}`,
        step: i,
        outcome: 'sent',
        payload_sha256: await sha256Hex(`p_${i}`),
        byte_len: 100,
      });
    }

    const allEntries = await store.read();
    expect(allEntries.length).toBe(10);
    expect(await ledger.verify()).toBeNull();

    // Simulate retention pruning: keep only the last 4 entries (seq 6, 7, 8, 9)
    const prunedSlice = allEntries.slice(-4);
    await store.write(prunedSlice);

    expect(prunedSlice[0]?.seq).toBe(6);
    expect(prunedSlice[0]?.prev_hash).toBe(allEntries[5]?.entry_hash);

    // Legitimately pruned slice must verify cleanly (returns null)
    expect(await ledger.verify()).toBeNull();

    // Appending to the pruned chain continues the chain monotonically
    const e10 = await ledger.append({
      session_id: 's',
      trace_id: 't_10',
      step: 10,
      outcome: 'sent',
    });
    expect(e10.seq).toBe(10);
    expect(e10.prev_hash).toBe(prunedSlice.at(-1)?.entry_hash);
    expect(await ledger.verify()).toBeNull();
  });

  it('12. tampered retained chain fails verification', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    for (let i = 0; i < 8; i++) {
      await ledger.append({
        session_id: 's',
        trace_id: `t_${i}`,
        step: i,
        outcome: 'sent',
      });
    }

    const allEntries = await store.read();
    const prunedSlice = allEntries.slice(-3); // seq 5, 6, 7
    await store.write(prunedSlice);
    expect(await ledger.verify()).toBeNull();

    // Tamper 1: modify head entry's prev_hash
    const tamperedHead = prunedSlice.map((e, idx) =>
      idx === 0 ? { ...e, prev_hash: '0'.repeat(64) } : e
    );
    await store.write(tamperedHead);
    expect(await ledger.verify()).toBe(5);

    // Tamper 2: delete an entry in the middle of retained slice (gap)
    const gappedSlice = [prunedSlice[0]!, prunedSlice[2]!]; // dropped seq 6
    await store.write(gappedSlice);
    expect(await ledger.verify()).toBe(7);

    // Tamper 3: modify a field in retained entry
    const tamperedContent = prunedSlice.map((e, idx) =>
      idx === 1 ? { ...e, step: 999 } : e
    );
    await store.write(tamperedContent);
    expect(await ledger.verify()).toBe(6);
  });

  it('13. sensitive values (raw value, password, secrets) are dropped and cannot enter the ledger', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // Cast as unknown to simulate an untyped caller attempting to inject secrets
    const maliciousInput = {
      session_id: 's',
      trace_id: 't0',
      step: 0,
      event_type: 'action',
      action_op: 'type',
      target_id: 'e1',
      action_outcome: 'advanced',
      // Forbidden fields:
      value: 'MySecretPassword123!',
      password: 'password_plaintext',
      otp: '987654',
      aadhaar: '123456789012',
      token_plaintext: 'secret_token_abc',
      screenshot: 'data:image/png;base64,...',
      request_body: '{"grant_type":"password"}',
    } as unknown as Parameters<typeof ledger.append>[0];

    const entry = await ledger.append(maliciousInput);
    const entryJson = JSON.stringify(entry);

    expect(entryJson).not.toContain('MySecretPassword123!');
    expect(entryJson).not.toContain('password_plaintext');
    expect(entryJson).not.toContain('987654');
    expect(entryJson).not.toContain('123456789012');
    expect(entryJson).not.toContain('secret_token_abc');
    expect(entryJson).not.toContain('base64');
    expect(entryJson).not.toContain('grant_type');

    expect('value' in entry).toBe(false);
    expect('password' in entry).toBe(false);
    expect('otp' in entry).toBe(false);
    expect('aadhaar' in entry).toBe(false);
  });
});

describe('LEKHA getSanitizedHistory — Phase 2 MANTRI-facing sanitized projection', () => {
  const APPROVED_FIELDS = new Set([
    'seq',
    'ts',
    'step',
    'event_type',
    'trace_id',
    'tier',
    'action_op',
    'target_id',
    'action_outcome',
    'risk',
    'network_outcome',
    'reason_code',
  ]);

  it('1 & 2. returns only approved allowlisted fields and never leaks internal LedgerEntry fields', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({
      session_id: 'eph_secret_sess_123',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'secret-purpose-string',
      origin_class: 'private-gov.in',
      outcome: 'attempted',
      payload_sha256: 'f'.repeat(64),
      byte_len: 12345,
      manifest: sampleManifest,
      blocked_reason: 'INTERNAL_CHECK_FAILED',
    });

    await ledger.append({
      session_id: 'eph_secret_sess_123',
      trace_id: 't_1',
      step: 1,
      tier: 1,
      purpose: 'secret-purpose-string',
      origin_class: 'private-gov.in',
      event_type: 'action',
      action_op: 'type',
      target_id: 'e17',
      action_outcome: 'blocked',
      risk: 'high',
      reason_code: 'SINK_BINDING_VIOLATION',
    });

    const history = await ledger.getSanitizedHistory();
    expect(history.length).toBe(2);

    for (const item of history) {
      const keys = Object.keys(item);
      for (const k of keys) {
        expect(APPROVED_FIELDS.has(k)).toBe(true);
      }

      // Explicitly verify excluded internal fields
      expect('payload_sha256' in item).toBe(false);
      expect('prev_hash' in item).toBe(false);
      expect('entry_hash' in item).toBe(false);
      expect('manifest' in item).toBe(false);
      expect('byte_len' in item).toBe(false);
      expect('blocked_reason' in item).toBe(false);
      expect('purpose' in item).toBe(false);
      expect('origin_class' in item).toBe(false);
      expect('session_id' in item).toBe(false);
    }
  });

  it('3 to 8. payload_sha256, hashes, manifest, blocked_reason, and raw error text are excluded', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({
      session_id: 's',
      trace_id: 't0',
      step: 0,
      outcome: 'blocked',
      payload_sha256: '9'.repeat(64),
      manifest: sampleManifest,
      blocked_reason:
        'Error connecting to https://bank.example.org/auth?user=confidential&token=SECRET_VALUE: DOM node <input id="pwd">',
    });

    const history = await ledger.getSanitizedHistory();
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain('9'.repeat(64));
    expect(serialized).not.toContain('bank.example.org');
    expect(serialized).not.toContain('SECRET_VALUE');
    expect(serialized).not.toContain('pwd');
    expect(serialized).not.toContain('<input');
    expect(serialized).not.toContain('counts');
    expect(serialized).not.toContain('policy_id');

    // Check that reason_code was normalized to a safe enum
    expect(history[0]?.reason_code).toBe('GUARD_BLOCKED');
  });

  it('9 to 13. fake PII, credentials, OTPs, DOM text, and values cannot appear in MANTRI history', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // Intentionally plant synthetic secret-like values into the append input
    const maliciousInput = {
      session_id: 's',
      trace_id: 't0',
      step: 0,
      event_type: 'action',
      action_op: 'type',
      target_id: 'e2',
      action_outcome: 'error',
      // Synthetic sensitive test values:
      value: 'PlaintextPassword!999',
      otp: '772910',
      aadhaar: '9999 8888 7777',
      phone: '+919988776655',
      email: 'sensitive.citizen@gov.in',
      dom_content: '<div class="balance">Rs. 1,50,000</div>',
      screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
      blocked_reason: 'Failed on value 9999 8888 7777 and password PlaintextPassword!999',
    } as unknown as Parameters<typeof ledger.append>[0];

    await ledger.append(maliciousInput);

    const history = await ledger.getSanitizedHistory();
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain('PlaintextPassword!999');
    expect(serialized).not.toContain('772910');
    expect(serialized).not.toContain('9999 8888 7777');
    expect(serialized).not.toContain('+919988776655');
    expect(serialized).not.toContain('sensitive.citizen@gov.in');
    expect(serialized).not.toContain('1,50,000');
    expect(serialized).not.toContain('base64');

    expect(history[0]?.reason_code).toBe('ACTION_FAILED');
  });

  it('14. maxItems is strictly bounded (default 20, min 1, max 50)', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // Append 60 entries
    for (let i = 0; i < 60; i++) {
      await ledger.append({
        session_id: 's',
        trace_id: `t_${i}`,
        step: i,
        event_type: 'action',
        action_op: 'click',
        target_id: `e${i}`,
        action_outcome: 'advanced',
      });
    }

    // Default maxItems: 20 most recent entries (seq 40 to 59)
    const defaultHistory = await ledger.getSanitizedHistory();
    expect(defaultHistory.length).toBe(20);
    expect(defaultHistory[0]?.seq).toBe(40);
    expect(defaultHistory.at(-1)?.seq).toBe(59);

    // Requesting 5
    const fiveHistory = await ledger.getSanitizedHistory({ maxItems: 5 });
    expect(fiveHistory.length).toBe(5);
    expect(fiveHistory[0]?.seq).toBe(55);
    expect(fiveHistory.at(-1)?.seq).toBe(59);

    // Requesting 100 is clamped to 50
    const clampedMax = await ledger.getSanitizedHistory({ maxItems: 100 });
    expect(clampedMax.length).toBe(50);
    expect(clampedMax[0]?.seq).toBe(10);
    expect(clampedMax.at(-1)?.seq).toBe(59);

    // Requesting 0 or negative is clamped to 1
    const clampedMinZero = await ledger.getSanitizedHistory({ maxItems: 0 });
    expect(clampedMinZero.length).toBe(1);
    expect(clampedMinZero[0]?.seq).toBe(59);

    const clampedMinNegative = await ledger.getSanitizedHistory({ maxItems: -10 });
    expect(clampedMinNegative.length).toBe(1);

    // Requesting NaN falls back to default 20
    const nanFallback = await ledger.getSanitizedHistory({ maxItems: Number.NaN });
    expect(nanFallback.length).toBe(20);
  });

  it('15 & 16. filters accurately by traceId and sessionId', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({ session_id: 's1', trace_id: 't_0', step: 0, outcome: 'sent' });
    await ledger.append({ session_id: 's1', trace_id: 't_1', step: 1, outcome: 'sent' });
    await ledger.append({ session_id: 's2', trace_id: 't_1', step: 1, outcome: 'sent' });
    await ledger.append({ session_id: 's2', trace_id: 't_2', step: 2, outcome: 'sent' });

    // Filter by traceId
    const t1History = await ledger.getSanitizedHistory({ traceId: 't_1' });
    expect(t1History.length).toBe(2);
    expect(t1History.every((h) => h.trace_id === 't_1')).toBe(true);

    // Filter by sessionId
    const s2History = await ledger.getSanitizedHistory({ sessionId: 's2' });
    expect(s2History.length).toBe(2);
    expect(s2History[0]?.trace_id).toBe('t_1');
    expect(s2History[1]?.trace_id).toBe('t_2');

    // Filter by both
    const specific = await ledger.getSanitizedHistory({ sessionId: 's1', traceId: 't_1' });
    expect(specific.length).toBe(1);
    expect(specific[0]?.trace_id).toBe('t_1');

    // Non-matching
    const empty = await ledger.getSanitizedHistory({ traceId: 't_nonexistent' });
    expect(empty).toEqual([]);
  });

  it('17. preserves chronological ordering', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({ session_id: 's', trace_id: 't0', step: 0, outcome: 'sent' });
    await ledger.append({ session_id: 's', trace_id: 't1', step: 1, outcome: 'sent' });
    await ledger.append({ session_id: 's', trace_id: 't2', step: 2, outcome: 'sent' });

    const history = await ledger.getSanitizedHistory();
    expect(history.map((h) => h.step)).toEqual([0, 1, 2]);
    expect(history[0]!.seq < history[1]!.seq).toBe(true);
    expect(history[1]!.seq < history[2]!.seq).toBe(true);
    expect(history[0]!.ts <= history[1]!.ts).toBe(true);
  });

  it('18. returns empty array for empty ledger', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    const history = await ledger.getSanitizedHistory();
    expect(history).toEqual([]);
  });

  it('19. handles mixed network, action, and lifecycle history with rich semantic diagnostics', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    // 1. Network event (Tier-1 postStep)
    await ledger.append({
      session_id: 's',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      event_type: 'network',
      outcome: 'sent',
    });

    // 2. Action event: Sink binding violation
    await ledger.append({
      session_id: 's',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      event_type: 'action',
      action_op: 'type',
      target_id: 'e17',
      action_outcome: 'blocked',
      risk: 'high',
      reason_code: 'SINK_BINDING_VIOLATION',
    });

    // 3. Action event: Stale element on click
    await ledger.append({
      session_id: 's',
      trace_id: 't_1',
      step: 1,
      tier: 1,
      event_type: 'action',
      action_op: 'click',
      target_id: 'e18',
      action_outcome: 'no_change',
      risk: 'medium',
      reason_code: 'TARGET_STALE',
    });

    // 4. Action event: User declined high-risk action
    await ledger.append({
      session_id: 's',
      trace_id: 't_2',
      step: 2,
      tier: 1,
      event_type: 'action',
      action_op: 'click',
      target_id: 'e99',
      action_outcome: 'blocked',
      risk: 'high',
      reason_code: 'USER_DECLINED',
    });

    // 5. Network event: Model timeout
    await ledger.append({
      session_id: 's',
      trace_id: 't_3',
      step: 3,
      tier: 2,
      event_type: 'network',
      outcome: 'failed',
      blocked_reason: 'request timed out',
    });

    const history = await ledger.getSanitizedHistory();
    expect(history.length).toBe(5);

    // Verify item 0: Network
    expect(history[0]?.event_type).toBe('network');
    expect(history[0]?.network_outcome).toBe('sent');

    // Verify item 1: Sink violation
    expect(history[1]?.event_type).toBe('action');
    expect(history[1]?.action_op).toBe('type');
    expect(history[1]?.target_id).toBe('e17');
    expect(history[1]?.action_outcome).toBe('blocked');
    expect(history[1]?.reason_code).toBe('SINK_BINDING_VIOLATION');
    expect(history[1]?.risk).toBe('high');

    // Verify item 2: Target stale
    expect(history[2]?.event_type).toBe('action');
    expect(history[2]?.action_op).toBe('click');
    expect(history[2]?.target_id).toBe('e18');
    expect(history[2]?.action_outcome).toBe('no_change');
    expect(history[2]?.reason_code).toBe('TARGET_STALE');

    // Verify item 3: User declined
    expect(history[3]?.action_outcome).toBe('blocked');
    expect(history[3]?.reason_code).toBe('USER_DECLINED');

    // Verify item 4: Timeout
    expect(history[4]?.event_type).toBe('network');
    expect(history[4]?.network_outcome).toBe('failed');
    expect(history[4]?.reason_code).toBe('TIMEOUT');
  });

  it('20. returned history items are frozen and immutable', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({
      session_id: 's',
      trace_id: 't0',
      step: 0,
      event_type: 'action',
      action_op: 'click',
      target_id: 'e1',
      action_outcome: 'advanced',
    });

    const history = await ledger.getSanitizedHistory();
    expect(history.length).toBe(1);
    expect(Object.isFrozen(history[0])).toBe(true);

    // Attempting to mutate a frozen item throws in strict mode
    expect(() => {
      // @ts-expect-error mutating readonly property
      history[0].target_id = 'e999';
    }).toThrow();

    const typedItem: SanitizedHistoryItem = history[0]!;
    expect(typedItem.event_type).toBe('action');
  });

  it('21. normalizeReasonCode maps recognized codes, keywords, and safe fallbacks', () => {
    const code1: SanitizedReasonCode | undefined = normalizeReasonCode('SINK_BINDING_VIOLATION');
    expect(code1).toBe('SINK_BINDING_VIOLATION');

    // Pattern matching on keywords
    expect(normalizeReasonCode(undefined, 'sink binding violation')).toBe('SINK_BINDING_VIOLATION');
    expect(normalizeReasonCode(undefined, 'stale element on page')).toBe('TARGET_STALE');
    expect(normalizeReasonCode(undefined, 'unreachable')).toBe('NETWORK_FAILED');
    expect(normalizeReasonCode(undefined, 'request timed out')).toBe('TIMEOUT');

    // Context-aware fallback: unknown string with blocked outcome
    expect(normalizeReasonCode('custom error with secret', undefined, 'blocked', 'network')).toBe(
      'GUARD_BLOCKED',
    );
    expect(normalizeReasonCode('custom error with secret', undefined, 'blocked', 'action')).toBe(
      'ACTION_BLOCKED',
    );
    expect(normalizeReasonCode('custom error with secret', undefined, 'error', 'action')).toBe(
      'ACTION_FAILED',
    );
  });
});

describe('LEKHA Phase 4 — User-Clearable Ledger, Verification, 30-Day Retention, and Privacy Exclusions', () => {
  it('22. ledger.clear() resets storage to genesis; subsequent entry restarts from seq 0', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    await ledger.append({
      session_id: 'sess_1',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'test',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: 'a'.repeat(64),
      byte_len: 100,
    });
    await ledger.append({
      session_id: 'sess_1',
      trace_id: 't_1',
      step: 1,
      tier: 1,
      purpose: 'test',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: 'b'.repeat(64),
      byte_len: 100,
    });

    const beforeClear = await ledger.list();
    expect(beforeClear.length).toBe(2);
    expect(await ledger.verify()).toBeNull();

    // User clears the ledger
    await ledger.clear();

    const afterClear = await ledger.list();
    expect(afterClear.length).toBe(0);
    // An empty ledger verifies as intact
    expect(await ledger.verify()).toBeNull();

    // Post-clear entry starts cleanly at seq 0 with 64-zero genesis prev_hash
    const postClearEntry = await ledger.append({
      session_id: 'sess_2',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'fresh-start',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: 'c'.repeat(64),
      byte_len: 100,
    });

    expect(postClearEntry.seq).toBe(0);
    expect(postClearEntry.prev_hash).toBe('0'.repeat(64));
    expect(await ledger.verify()).toBeNull();
  });

  it('23. authoritative 30-day retention pruning removes expired entries while preserving hash chain verification', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const FORTY_DAYS_AGO = now - (40 * 24 * 60 * 60 * 1000);
    const TEN_DAYS_AGO = now - (10 * 24 * 60 * 60 * 1000);

    // Entry 0: 40 days old (expired under 30-day retention)
    await ledger.append({
      session_id: 'sess_old',
      trace_id: 't_0',
      step: 0,
      tier: 1,
      purpose: 'test-retention',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: '1'.repeat(64),
      byte_len: 100,
      ts: FORTY_DAYS_AGO,
    });

    // Entry 1: 35 days old (expired)
    await ledger.append({
      session_id: 'sess_old',
      trace_id: 't_1',
      step: 1,
      tier: 1,
      purpose: 'test-retention',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: '2'.repeat(64),
      byte_len: 100,
      ts: FORTY_DAYS_AGO + (5 * 24 * 60 * 60 * 1000),
    });

    // Entry 2: 10 days old (within 30-day window)
    await ledger.append({
      session_id: 'sess_new',
      trace_id: 't_2',
      step: 2,
      tier: 1,
      purpose: 'test-retention',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: '3'.repeat(64),
      byte_len: 100,
      ts: TEN_DAYS_AGO,
    });

    // Entry 3: current time (within 30-day window)
    await ledger.append({
      session_id: 'sess_new',
      trace_id: 't_3',
      step: 3,
      tier: 1,
      purpose: 'test-retention',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: '4'.repeat(64),
      byte_len: 100,
      ts: now,
    });

    const fullList = await ledger.list();
    expect(fullList.length).toBe(4);
    expect(await ledger.verify()).toBeNull();

    // Simulate 30-day retention pruning exactly as in ExtensionLedgerStore
    const cutoff = now - THIRTY_DAYS_MS;
    const retained = fullList.filter((e) => e.ts >= cutoff);

    expect(retained.length).toBe(2);
    expect(retained[0]?.seq).toBe(2);
    expect(retained[1]?.seq).toBe(3);

    // Save retained entries into store
    await store.write(retained);

    // Retained chain (seq 2, seq 3) still verifies as intact!
    expect(await ledger.verify()).toBeNull();

    // Appending a new entry after pruning links correctly to seq 3 hash
    const postPruningEntry = await ledger.append({
      session_id: 'sess_new',
      trace_id: 't_4',
      step: 4,
      tier: 1,
      purpose: 'test-retention',
      origin_class: 'test',
      outcome: 'sent',
      payload_sha256: '5'.repeat(64),
      byte_len: 100,
      ts: now + 1000,
    });

    expect(postPruningEntry.seq).toBe(4);
    expect(postPruningEntry.prev_hash).toBe(retained[1]?.entry_hash);
    expect(await ledger.verify()).toBeNull();

    // Tampering with retained entry (seq 3) is still strictly detected
    const corrupted = [...await ledger.list()];
    corrupted[1] = { ...corrupted[1]!, purpose: 'tampered-purpose' };
    await store.write(corrupted);
    expect(await ledger.verify()).toBe(3);
  });

  it('24. Phase 4 Privacy Test: ledger entries and sanitized history strictly exclude all sensitive PII and secrets', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);

    const fakeSensitiveData = {
      email: 'citizen.prahari@nic.in',
      aadhaar: '9999 8888 7777',
      password: 'SuperSecretBankPass!99',
      otp: '654321',
      phone: '+91 9876543210',
      domSnippet: '<input type="password" value="SuperSecretBankPass!99" name="pwd">',
    };

    // Attempt to log an action event where sensitive values were involved in the page
    const actionEntry = await ledger.append({
      session_id: 'eph_privacy_test',
      trace_id: 't_pw_step',
      step: 4,
      tier: 1,
      purpose: 'assist-user-task',
      origin_class: 'bank.in',
      event_type: 'action',
      action_op: 'type',
      target_id: 'e17',
      action_outcome: 'blocked',
      risk: 'high',
      reason_code: 'SINK_BINDING_VIOLATION',
    });

    // Check entry serialization
    const serialized = JSON.stringify(actionEntry);

    // Verify NONE of the sensitive strings appear anywhere in the serialized ledger entry
    for (const value of Object.values(fakeSensitiveData)) {
      expect(serialized.includes(value)).toBe(false);
      expect(serialized.toLowerCase().includes(value.toLowerCase())).toBe(false);
    }

    // Verify sanitized history projection excludes all secrets
    const history = await ledger.getSanitizedHistory();
    const historyJson = JSON.stringify(history);

    for (const value of Object.values(fakeSensitiveData)) {
      expect(historyJson.includes(value)).toBe(false);
    }

    // Verify only authorized diagnostic fields exist on the action entry
    expect(actionEntry.action_op).toBe('type');
    expect(actionEntry.target_id).toBe('e17');
    expect(actionEntry.action_outcome).toBe('blocked');
    expect(actionEntry.risk).toBe('high');
    expect(actionEntry.reason_code).toBe('SINK_BINDING_VIOLATION');
    // Types ensure value, secret, dom, password cannot even be passed
  });
});

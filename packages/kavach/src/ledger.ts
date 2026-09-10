/**
 * LEKHA - the privacy ledger.
 *
 * Records every egress attempt, browser action, and security boundary decision.
 * Entries are hash-chained so a deleted, reordered, or edited row is detectable.
 *
 * RULES.md P8: the ledger stores hashes and manifests, NEVER payloads or raw secrets.
 * That is enforced by this file's types - there is no parameter through which raw
 * values, passwords, OTPs, DOM content, or request bodies can be stored.
 * An audit log that contains the data it audits is a liability.
 */

import type { ActionOp, Outcome, RedactionManifest, Risk, Tier } from '@prahari/ssg';

/**
 * Event category in LEKHA.
 * - 'network': Egress guard checks and wire transmissions.
 * - 'action': HASTA browser actions executed on the page.
 * - 'lifecycle': Controller lifecycle and bounded recovery events.
 */
export type LedgerEventType = 'network' | 'action' | 'lifecycle';

/**
 * What happened to one network payload.
 *
 * `blocked` is terminal and stands alone: the guard refused, so nothing was ever
 * offered to the network.
 *
 * The other three come in PAIRS, and that is the point. The guard writes `attempted`
 * the instant it clears a payload — before `fetch` is called, because a record written
 * afterwards could be lost to a crash and an unlogged egress is the one thing this
 * system exists to make impossible. The network layer then writes `sent` or `failed`
 * once the request resolves.
 */
export type GuardOutcome = 'attempted' | 'sent' | 'failed' | 'blocked';

export interface LedgerEntry {
  /** Monotonic within a session; gaps mean tampering. */
  readonly seq: number;
  readonly ts: number;
  readonly session_id: string;
  readonly trace_id: string;
  /** Execution step in the agent loop (from SSG.step). */
  readonly step?: number;
  readonly tier: Tier;
  readonly purpose: string;
  readonly origin_class: string;

  /** Event category. Defaults to 'network' for backward compatibility. */
  readonly event_type: LedgerEventType;

  /** SHA-256 of the exact bytes that were offered to the network (or empty string if not applicable). */
  readonly payload_sha256: string;
  readonly byte_len: number;
  readonly manifest: RedactionManifest;
  readonly outcome: GuardOutcome;

  /** Present when `outcome` is `blocked` or `failed`. Names the check, HTTP status, or fault. */
  readonly blocked_reason?: string;

  // Semantic Action & Diagnostic Metadata (never raw values, secrets, or DOM text)
  /** HASTA action operation (e.g. 'click', 'type', 'scroll', 'select', 'ask_user', 'done', 'fail'). */
  readonly action_op?: ActionOp;
  /** Target element reference ID (e.g. 'e17'), never arbitrary selector or text. */
  readonly target_id?: string;
  /** Semantic outcome of the action execution. */
  readonly action_outcome?: Outcome;
  /** Effective risk tier assessed for the action. */
  readonly risk?: Risk;
  /**
   * Diagnostic reason code (e.g. 'SINK_BINDING_VIOLATION', 'TARGET_STALE', 'USER_DECLINED').
   * Strictly metadata/code; never raw secrets or page content.
   */
  readonly reason_code?: string;

  /** `entry_hash` of the previous record, or 64 zeros for the first. */
  readonly prev_hash: string;
  readonly entry_hash: string;
}

/** Storage is injected so `kavach` stays free of browser globals and is testable. */
export interface LedgerStore {
  read(): Promise<LedgerEntry[]>;
  write(entries: LedgerEntry[]): Promise<void>;
  clear?(): Promise<void>;
}

export class MemoryLedgerStore implements LedgerStore {
  #entries: LedgerEntry[] = [];
  read(): Promise<LedgerEntry[]> {
    return Promise.resolve([...this.#entries]);
  }
  write(entries: LedgerEntry[]): Promise<void> {
    this.#entries = [...entries];
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.#entries = [];
    return Promise.resolve();
  }
}

const GENESIS = '0'.repeat(64);

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  // Copy into a fresh ArrayBuffer so a Uint8Array view over a larger buffer
  // (common with subarray slices) hashes only its own bytes.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic canonical JSON serialization with sorted object keys. */
function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((val as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

/** Fields that go into the chain hash, in a fixed, unambiguous order. */
type ChainInput = Omit<LedgerEntry, 'entry_hash'>;

async function chainHash(e: ChainInput): Promise<string> {
  const canonical = [
    e.seq,
    e.ts,
    e.session_id,
    e.trace_id,
    e.tier,
    e.purpose,
    e.origin_class,
    e.payload_sha256,
    e.byte_len,
    e.outcome,
    e.blocked_reason ?? '',
    e.prev_hash,
    canonicalJson(e.manifest),
    e.event_type,
    e.step ?? '',
    e.action_op ?? '',
    e.target_id ?? '',
    e.action_outcome ?? '',
    e.risk ?? '',
    e.reason_code ?? '',
  ].join('\u0000');
  return sha256Hex(canonical);
}

const DEFAULT_MANIFEST: RedactionManifest = {
  policy_id: 'in-default-v1',
  counts: {},
  methods: {},
  detectors: [],
  coverage_confidence: 1,
};

export interface AppendInput {
  readonly ts?: number;
  readonly session_id: string;
  readonly trace_id: string;
  readonly step?: number;
  readonly tier?: Tier;
  readonly purpose?: string;
  readonly origin_class?: string;
  readonly event_type?: LedgerEventType;
  readonly payload_sha256?: string;
  readonly byte_len?: number;
  readonly manifest?: RedactionManifest;
  readonly outcome?: GuardOutcome;
  readonly blocked_reason?: string;
  readonly action_op?: ActionOp;
  readonly target_id?: string;
  readonly action_outcome?: Outcome;
  readonly risk?: Risk;
  readonly reason_code?: string;
}

/**
 * Controlled normalized reason codes for MANTRI reasoning.
 * Strictly metadata identifiers; NEVER raw error messages, URLs, or secrets.
 */
export type SanitizedReasonCode =
  | 'SINK_BINDING_VIOLATION'
  | 'NOT_REVERSIBLE'
  | 'ORIGIN_CHANGED'
  | 'EXPIRED_TOKEN'
  | 'UNKNOWN_TOKEN'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_STALE'
  | 'DISABLED_TARGET'
  | 'TARGET_TYPE_MISMATCH'
  | 'OPTION_NOT_FOUND'
  | 'VALUE_VERIFICATION_FAILED'
  | 'USER_DECLINED'
  | 'HIGH_RISK_CONFIRMATION_REQUIRED'
  | 'NAVIGATION_DISABLED'
  | 'LITERAL_PII_REFUSED'
  | 'LITERAL_TOKEN_REFUSED'
  | 'GUARD_BLOCKED'
  | 'IMAGE_UNVERIFIED'
  | 'NETWORK_FAILED'
  | 'TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'SERVER_REJECTED_UNREDACTED'
  | 'SERVER_ERROR'
  | 'ACTION_FAILED'
  | 'ACTION_BLOCKED'
  | 'RECOVERY_EXHAUSTED'
  | 'RECOVERY_STARTED'
  | 'TASK_COMPLETE'
  | 'TASK_FAILED'
  | 'UNKNOWN_FAILURE';

const KNOWN_REASON_CODES = new Set<string>([
  'SINK_BINDING_VIOLATION',
  'NOT_REVERSIBLE',
  'ORIGIN_CHANGED',
  'EXPIRED_TOKEN',
  'UNKNOWN_TOKEN',
  'TARGET_NOT_FOUND',
  'TARGET_STALE',
  'DISABLED_TARGET',
  'TARGET_TYPE_MISMATCH',
  'OPTION_NOT_FOUND',
  'VALUE_VERIFICATION_FAILED',
  'USER_DECLINED',
  'HIGH_RISK_CONFIRMATION_REQUIRED',
  'NAVIGATION_DISABLED',
  'LITERAL_PII_REFUSED',
  'LITERAL_TOKEN_REFUSED',
  'GUARD_BLOCKED',
  'IMAGE_UNVERIFIED',
  'NETWORK_FAILED',
  'TIMEOUT',
  'MODEL_UNAVAILABLE',
  'SERVER_REJECTED_UNREDACTED',
  'SERVER_ERROR',
  'ACTION_FAILED',
  'ACTION_BLOCKED',
  'RECOVERY_EXHAUSTED',
  'RECOVERY_STARTED',
  'TASK_COMPLETE',
  'TASK_FAILED',
  'UNKNOWN_FAILURE',
]);

/**
 * Normalizes an incoming reason or error string into an explicit, allowlisted SanitizedReasonCode.
 * Guarantees that free-form exception strings, DOM snippets, or server dumps cannot leak into MANTRI.
 */
export function normalizeReasonCode(
  rawCode?: string,
  rawBlockedReason?: string,
  outcome?: string,
  eventType?: LedgerEventType,
): SanitizedReasonCode | undefined {
  // 1. Direct match on allowlisted enum
  if (rawCode !== undefined && KNOWN_REASON_CODES.has(rawCode)) {
    return rawCode as SanitizedReasonCode;
  }
  if (rawBlockedReason !== undefined && KNOWN_REASON_CODES.has(rawBlockedReason)) {
    return rawBlockedReason as SanitizedReasonCode;
  }

  // 2. Controlled pattern matching over known project failure modes
  const combined = `${rawCode ?? ''} ${rawBlockedReason ?? ''}`.toLowerCase();

  if (
    combined.includes('sink') ||
    combined.includes('bound to the field') ||
    combined.includes('point target') ||
    combined.includes('no vault')
  ) {
    return 'SINK_BINDING_VIOLATION';
  }
  if (combined.includes('not reversible') || combined.includes('credential')) return 'NOT_REVERSIBLE';
  if (combined.includes('origin')) return 'ORIGIN_CHANGED';
  if (combined.includes('expired')) return 'EXPIRED_TOKEN';
  if (combined.includes('unknown token')) return 'UNKNOWN_TOKEN';
  if (
    combined.includes('stale') ||
    combined.includes('no longer on the page') ||
    combined.includes('no longer on page')
  ) {
    return 'TARGET_STALE';
  }
  if (
    combined.includes('no target') ||
    combined.includes('target not found') ||
    combined.includes('not interactable')
  ) {
    return 'TARGET_NOT_FOUND';
  }
  if (combined.includes('disabled')) return 'DISABLED_TARGET';
  if (combined.includes('decline') || combined.includes('declined')) return 'USER_DECLINED';
  if (combined.includes('confirm') || combined.includes('confirmation') || combined.includes('high-risk')) {
    return 'HIGH_RISK_CONFIRMATION_REQUIRED';
  }
  if (combined.includes('navigate') || combined.includes('navigation')) return 'NAVIGATION_DISABLED';
  if (combined.includes('literal pii')) return 'LITERAL_PII_REFUSED';
  if (combined.includes('literal token') || combined.includes('token supplied as a literal')) {
    return 'LITERAL_TOKEN_REFUSED';
  }
  if (
    combined.includes('text field') ||
    combined.includes('not a select') ||
    combined.includes('target is not a') ||
    combined.includes('type mismatch')
  ) {
    return 'TARGET_TYPE_MISMATCH';
  }
  if (combined.includes('option not found')) return 'OPTION_NOT_FOUND';
  if (
    combined.includes('not updated') ||
    combined.includes('could not be set') ||
    combined.includes('verification failed')
  ) {
    return 'VALUE_VERIFICATION_FAILED';
  }
  if (combined.includes('timeout') || combined.includes('timed out')) return 'TIMEOUT';
  if (combined.includes('unreachable') || combined.includes('network')) return 'NETWORK_FAILED';
  if (combined.includes('model')) return 'MODEL_UNAVAILABLE';
  if (combined.includes('recovery exhausted') || combined.includes('budget exhausted')) {
    return 'RECOVERY_EXHAUSTED';
  }
  if (
    combined.includes('recovery attempt') ||
    combined.includes('recovery started') ||
    combined.includes('replanning')
  ) {
    return 'RECOVERY_STARTED';
  }
  if (combined.includes('task complete') || combined.includes('task completed')) return 'TASK_COMPLETE';
  if (combined.includes('task failure') || combined.includes('task failed')) return 'TASK_FAILED';
  if (combined.includes('422') || combined.includes('unredacted')) {
    return 'SERVER_REJECTED_UNREDACTED';
  }
  if (
    combined.includes('500') ||
    combined.includes('502') ||
    combined.includes('503') ||
    combined.includes('server http 5')
  ) {
    return 'SERVER_ERROR';
  }
  if (
    combined.includes('guard') ||
    combined.includes('untrusted_origin') ||
    combined.includes('insecure_transport') ||
    combined.includes('pii_in_payload') ||
    combined.includes('forged_token') ||
    combined.includes('unregistered_canary')
  ) {
    return 'GUARD_BLOCKED';
  }
  if (combined.includes('image')) return 'IMAGE_UNVERIFIED';

  // 3. Fallbacks for failures without a specific signature
  if (outcome === 'blocked') {
    return eventType === 'network' ? 'GUARD_BLOCKED' : 'ACTION_BLOCKED';
  }
  if (outcome === 'failed' || outcome === 'error') {
    return eventType === 'network' ? 'NETWORK_FAILED' : 'ACTION_FAILED';
  }

  return undefined;
}

/**
 * Sanitized, privacy-safe historical view of a LEKHA ledger entry projected specifically for MANTRI.
 *
 * RULES.md P8: STRICT ALLOWLIST. This type deliberately omits:
 * - payload_sha256
 * - prev_hash & entry_hash
 * - manifest internals
 * - byte_len
 * - raw blocked_reason
 * - purpose & origin strings
 * - session_id
 * - raw input values, secrets, DOM text, passwords, and screenshots.
 */
export interface SanitizedHistoryItem {
  /** Monotonic sequence within the ledger. */
  readonly seq: number;
  /** Millisecond timestamp. */
  readonly ts: number;
  /** Execution step in the agent loop. */
  readonly step?: number;
  /** Event category ('network' | 'action' | 'lifecycle'). */
  readonly event_type: LedgerEventType;
  /** Trace identifier for cross-step correlation. */
  readonly trace_id: string;
  /** Perception tier for this step. */
  readonly tier: Tier;

  // Semantic Action Fields
  /** HASTA action operation (e.g. 'click', 'type', 'scroll', 'select', 'ask_user', 'done', 'fail'). */
  readonly action_op?: ActionOp;
  /** Stable target element identifier (e.g. 'e17'), never DOM text or raw selector. */
  readonly target_id?: string;
  /** Semantic outcome of the action ('advanced' | 'no_change' | 'error' | 'blocked'). */
  readonly action_outcome?: Outcome;
  /** Assessed risk level ('safe' | 'medium' | 'high'). */
  readonly risk?: Risk;

  // Semantic Network Fields
  /** Egress outcome if this entry represents a network transmission attempt. */
  readonly network_outcome?: GuardOutcome;

  // Normalized Diagnostic Code (strictly allowlisted, never raw messages or secrets)
  /** Safe diagnostic reason code for failure, block, or stagnation. */
  readonly reason_code?: SanitizedReasonCode;
}

export interface SanitizedHistoryOptions {
  /** Filter by trace ID (e.g. 't_0'). */
  readonly traceId?: string;
  /** Filter by session ID (e.g. 'eph_...'). */
  readonly sessionId?: string;
  /**
   * Maximum items to return.
   * Default: 20. Bounded between 1 and 50 to prevent prompt or memory bloat.
   */
  readonly maxItems?: number;
}

export class Ledger {
  readonly #store: LedgerStore;

  constructor(store: LedgerStore) {
    this.#store = store;
  }

  async append(input: AppendInput): Promise<LedgerEntry> {
    const entries = await this.#store.read();
    const prev = entries.at(-1);

    const event_type: LedgerEventType = input.event_type ?? 'network';

    // Map action outcome to guard outcome if outcome is not explicitly provided:
    // 'blocked' -> 'blocked', 'error' -> 'failed', 'advanced' | 'no_change' -> 'sent'
    let outcome: GuardOutcome = input.outcome ?? 'sent';
    if (input.outcome === undefined && input.action_outcome !== undefined) {
      if (input.action_outcome === 'blocked') outcome = 'blocked';
      else if (input.action_outcome === 'error') outcome = 'failed';
      else outcome = 'sent';
    }

    const base: ChainInput = {
      seq: (prev?.seq ?? -1) + 1,
      ts: input.ts ?? Date.now(),
      session_id: input.session_id,
      trace_id: input.trace_id,
      ...(input.step !== undefined ? { step: input.step } : {}),
      tier: input.tier ?? 1,
      purpose: input.purpose ?? 'assist-user-task',
      origin_class: input.origin_class ?? 'unknown',
      event_type,
      payload_sha256: input.payload_sha256 ?? '',
      byte_len: input.byte_len ?? 0,
      manifest: input.manifest ?? DEFAULT_MANIFEST,
      outcome,
      ...(input.blocked_reason !== undefined ? { blocked_reason: input.blocked_reason } : {}),
      ...(input.action_op !== undefined ? { action_op: input.action_op } : {}),
      ...(input.target_id !== undefined ? { target_id: input.target_id } : {}),
      ...(input.action_outcome !== undefined ? { action_outcome: input.action_outcome } : {}),
      ...(input.risk !== undefined ? { risk: input.risk } : {}),
      ...(input.reason_code !== undefined ? { reason_code: input.reason_code } : {}),
      prev_hash: prev?.entry_hash ?? GENESIS,
    };

    const entry: LedgerEntry = { ...base, entry_hash: await chainHash(base) };
    await this.#store.write([...entries, entry]);
    return entry;
  }

  list(): Promise<LedgerEntry[]> {
    return this.#store.read();
  }

  /**
   * Resets the ledger storage completely.
   * Subsequent writes will start from a clean genesis entry (seq: 0, prev_hash: GENESIS).
   */
  async clear(): Promise<void> {
    if (typeof this.#store.clear === 'function') {
      await this.#store.clear();
    } else {
      await this.#store.write([]);
    }
  }

  /**
   * Recomputes the chain. Returns the seq of the first bad entry, or null if intact.
   *
   * Handles both full chains starting from genesis (seq 0, prev_hash: GENESIS)
   * and legitimately truncated chains resulting from retention pruning (seq > 0),
   * while continuing to strictly detect any tampering, reordering, or gap deletion.
   */
  async verify(): Promise<number | null> {
    const entries = await this.#store.read();
    if (entries.length === 0) return null;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (typeof e.seq !== 'number' || e.seq < 0) return e.seq ?? -1;

      // 1. Content integrity: verify that entry_hash matches canonical recomputation
      const { entry_hash: _ignored, ...rest } = e;
      const expectedHash = await chainHash(rest);
      if (expectedHash !== e.entry_hash) {
        return e.seq;
      }

      if (i === 0) {
        if (e.seq === 0) {
          // Un-pruned chain starting at genesis
          if (e.prev_hash !== GENESIS) return e.seq;
        } else {
          // Truncated chain (older entries pruned by retention policy):
          // prev_hash must be a valid 64-char hex SHA-256 hash pointing to the pruned predecessor.
          if (!/^[0-9a-f]{64}$/i.test(e.prev_hash) || e.prev_hash === GENESIS) {
            return e.seq;
          }
        }
      } else {
        const prev = entries[i - 1]!;
        // Sequence must be strictly sequential with zero gaps
        if (e.seq !== prev.seq + 1) return e.seq;
        // Hash link: prev_hash must equal the previous entry's entry_hash
        if (e.prev_hash !== prev.entry_hash) return e.seq;
      }
    }
    return null;
  }

  /**
   * Returns a sanitized, privacy-safe view of historical entries for MANTRI.
   *
   * Enforces:
   * 1. Explicit allowlist projection (no payload, no hashes, no raw error messages, no secrets).
   * 2. Strict bounding (default 20, max 50, min 1).
   * 3. Chronological ordering preserved (latest matching items returned).
   * 4. Normalized reason codes.
   */
  async getSanitizedHistory(options: SanitizedHistoryOptions = {}): Promise<SanitizedHistoryItem[]> {
    const rawEntries = await this.#store.read();

    const rawMax =
      typeof options.maxItems === 'number' && !Number.isNaN(options.maxItems)
        ? options.maxItems
        : 20;
    const boundedMax = Math.max(1, Math.min(Math.floor(rawMax), 50));

    const filtered = rawEntries.filter((e) => {
      if (options.traceId !== undefined && e.trace_id !== options.traceId) {
        return false;
      }
      if (options.sessionId !== undefined && e.session_id !== options.sessionId) {
        return false;
      }
      return true;
    });

    const slice = filtered.slice(-boundedMax);

    return slice.map((e): SanitizedHistoryItem => {
      const reason_code = normalizeReasonCode(
        e.reason_code,
        e.blocked_reason,
        e.outcome,
        e.event_type,
      );

      const item: SanitizedHistoryItem = {
        seq: e.seq,
        ts: e.ts,
        event_type: e.event_type,
        trace_id: e.trace_id,
        tier: e.tier,
        ...(e.step !== undefined ? { step: e.step } : {}),
        ...(e.action_op !== undefined ? { action_op: e.action_op } : {}),
        ...(e.target_id !== undefined ? { target_id: e.target_id.slice(0, 16) } : {}),
        ...(e.action_outcome !== undefined ? { action_outcome: e.action_outcome } : {}),
        ...(e.risk !== undefined ? { risk: e.risk } : {}),
        ...(e.event_type === 'network' ? { network_outcome: e.outcome } : {}),
        ...(reason_code !== undefined ? { reason_code } : {}),
      };

      return Object.freeze(item);
    });
  }
}

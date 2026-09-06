/**
 * LEKHA - the privacy ledger.
 *
 * Records every egress attempt, including the blocked ones. Entries are hash-chained
 * so a deleted or edited row is detectable.
 *
 * RULES.md P8: the ledger stores hashes and manifests, NEVER payloads. That is
 * enforced by this file's types - there is no parameter through which a payload can
 * be passed in. An audit log that contains the data it audits is a liability.
 */

import type { RedactionManifest, Tier } from '@prahari/ssg';

/**
 * What happened to one payload.
 *
 * `blocked` is terminal and stands alone: the guard refused, so nothing was ever
 * offered to the network.
 *
 * The other three come in PAIRS, and that is the point. The guard writes `attempted`
 * the instant it clears a payload — before `fetch` is called, because a record written
 * afterwards could be lost to a crash and an unlogged egress is the one thing this
 * system exists to make impossible. The network layer then writes `sent` or `failed`
 * once the request resolves.
 *
 * Writing `sent` up front (as an earlier version did) made the ledger claim an egress
 * that never happened whenever the server was unreachable: a hash-chained, tamper-
 * evident row attesting to bytes that never left the machine. "Everything that leaves
 * is logged" was true; "everything logged, left" was false, and an audit record only
 * earns trust when both directions hold.
 */
export type GuardOutcome = 'attempted' | 'sent' | 'failed' | 'blocked';

export interface LedgerEntry {
  /** Monotonic within a session; gaps mean tampering. */
  readonly seq: number;
  readonly ts: number;
  readonly session_id: string;
  readonly trace_id: string;
  readonly tier: Tier;
  readonly purpose: string;
  readonly origin_class: string;
  /** SHA-256 of the exact bytes that were offered to the network. */
  readonly payload_sha256: string;
  readonly byte_len: number;
  readonly manifest: RedactionManifest;
  readonly outcome: GuardOutcome;
  /** Present when `outcome` is `blocked` or `failed`. Names the check or the fault. */
  readonly blocked_reason?: string;
  /** `entry_hash` of the previous record, or 64 zeros for the first. */
  readonly prev_hash: string;
  readonly entry_hash: string;
}

/** Storage is injected so `kavach` stays free of browser globals and is testable. */
export interface LedgerStore {
  read(): Promise<LedgerEntry[]>;
  write(entries: LedgerEntry[]): Promise<void>;
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

/** Fields that go into the chain hash, in a fixed order. */
type ChainInput = Omit<LedgerEntry, 'entry_hash'>;

async function chainHash(e: ChainInput): Promise<string> {
  const canonical = [
    e.seq, e.ts, e.session_id, e.trace_id, e.tier, e.purpose, e.origin_class,
    e.payload_sha256, e.byte_len, e.outcome, e.blocked_reason ?? '', e.prev_hash,
    JSON.stringify(e.manifest),
  ].join('\u0000');
  return sha256Hex(canonical);
}

export interface AppendInput {
  readonly session_id: string;
  readonly trace_id: string;
  readonly tier: Tier;
  readonly purpose: string;
  readonly origin_class: string;
  readonly payload_sha256: string;
  readonly byte_len: number;
  readonly manifest: RedactionManifest;
  readonly outcome: GuardOutcome;
  readonly blocked_reason?: string;
}

export class Ledger {
  readonly #store: LedgerStore;

  constructor(store: LedgerStore) {
    this.#store = store;
  }

  async append(input: AppendInput): Promise<LedgerEntry> {
    const entries = await this.#store.read();
    const prev = entries.at(-1);
    const base: ChainInput = {
      seq: (prev?.seq ?? -1) + 1,
      ts: Date.now(),
      prev_hash: prev?.entry_hash ?? GENESIS,
      ...input,
    };
    const entry: LedgerEntry = { ...base, entry_hash: await chainHash(base) };
    await this.#store.write([...entries, entry]);
    return entry;
  }

  list(): Promise<LedgerEntry[]> {
    return this.#store.read();
  }

  /** Recomputes the chain. Returns the seq of the first bad entry, or null if intact. */
  async verify(): Promise<number | null> {
    const entries = await this.#store.read();
    let expectedPrev = GENESIS;
    for (const e of entries) {
      if (e.prev_hash !== expectedPrev) return e.seq;
      const { entry_hash: _ignored, ...rest } = e;
      if ((await chainHash(rest)) !== e.entry_hash) return e.seq;
      expectedPrev = e.entry_hash;
    }
    return null;
  }
}

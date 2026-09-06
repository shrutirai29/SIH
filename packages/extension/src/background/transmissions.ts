/**
 * The transmission buffer behind the "what the server saw" viewer (ticket D16).
 *
 * ## Why this is not the ledger
 *
 * RULES.md P8: the ledger stores hashes and manifests, never payloads. An audit log
 * that contains the data it audits is a liability, and `LedgerEntry` has no field a
 * payload could arrive through.
 *
 * But the viewer has to show the *exact bytes*, or it proves nothing — a
 * reconstruction is a claim about a claim. ARCHITECTURE.md §10 resolves this: the
 * redacted artefact for the CURRENT session is kept in memory, bounded, and dropped at
 * session end.
 *
 * So: memory only. Never `storage.local`, never IndexedDB, never survives a restart.
 * The ledger remains the durable record and remains payload-free; this is a short-lived
 * window onto what just happened.
 *
 * The bytes here are already sanitized — they are what passed the egress guard — so
 * holding them is not a new disclosure. It is the same data the server has.
 */

import type { DiffRow } from '@prahari/kavach';

export interface Transmission {
  readonly traceId: string;
  readonly step: number;
  readonly sentAt: number;
  /** The exact serialised payload that was handed to `fetch`. */
  readonly payload: string;
  readonly sha256: string;
  readonly byteLen: number;
  /** What was on screen, masked, beside what the server got. */
  readonly diff: readonly DiffRow[];
  /** Present when the guard refused; the payload was never sent. */
  readonly blockedReason?: string;
}

/** ARCHITECTURE.md §10: bounded to the last 20 steps. */
const MAX_KEPT = 20;

export class TransmissionBuffer {
  #items: Transmission[] = [];

  record(t: Transmission): void {
    this.#items.push(t);
    if (this.#items.length > MAX_KEPT) {
      this.#items = this.#items.slice(-MAX_KEPT);
    }
  }

  get(traceId: string): Transmission | undefined {
    return this.#items.find((t) => t.traceId === traceId);
  }

  list(): readonly Transmission[] {
    return [...this.#items];
  }

  /** Task end, kill switch, or panic button. */
  clear(): void {
    this.#items = [];
  }

  get size(): number {
    return this.#items.length;
  }
}

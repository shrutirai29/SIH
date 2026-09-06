/**
 * LEKHA persistence, backed by `storage.local`.
 *
 * RULES.md P8: hashes and manifests only. `LedgerEntry` has no field through which a
 * payload could arrive, so this file cannot store one even by accident.
 */

import type { LedgerEntry, LedgerStore } from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';
import { browser } from '../platform/index.js';

const KEY = 'prahari.lekha.v1';
const MAX_ENTRIES = 2000;

export class ExtensionLedgerStore implements LedgerStore {
  async read(): Promise<LedgerEntry[]> {
    const bag = await browser.storage.local.get(KEY);
    const raw = bag[KEY];
    return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
  }

  async write(entries: LedgerEntry[]): Promise<void> {
    const cutoff = Date.now() - CONFIG.ledgerRetentionDays * 24 * 60 * 60 * 1000;
    // Trim by age first, then by count. Both bounds exist because a long session can
    // blow the quota inside the retention window.
    const kept = entries.filter((e) => e.ts >= cutoff).slice(-MAX_ENTRIES);
    await browser.storage.local.set({ [KEY]: kept });
  }

  async clear(): Promise<void> {
    await browser.storage.local.remove(KEY);
  }
}

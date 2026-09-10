/**
 * AgentManager — registry of per-tab AgentLoop instances.
 *
 * One loop per tabId; creating a second loop for the same tab while the first
 * is still active is an explicit error (the caller must stop the old one first).
 *
 * Lifecycle hooks wired:
 *   - tabs.onRemoved  → remove(tabId)   // clean teardown on tab close
 *   - tabs.onUpdated  → interrupt(tabId) // navigation away from the task page
 */

import { browser } from '../platform/index.js';
import { AgentLoop } from './agent-loop.js';
import type { AgentState } from '../shared/messages.js';
import type { UserProfile } from '../shared/profile.js';

/** Phases that mean a loop has finished and its slot can be freely reused. */
const TERMINAL_PHASES = new Set(['idle', 'done', 'blocked', 'error', 'interrupted']);

export class AgentManager {
  readonly #loops = new Map<number, AgentLoop>();
  readonly #unsubscribes = new Map<number, () => void>();
  readonly #stateListeners = new Set<(tabId: number, state: AgentState) => void>();

  /**
   * Subscribe a listener to receive state updates from all managed loops.
   */
  onStateChange(fn: (tabId: number, state: AgentState) => void): () => void {
    this.#stateListeners.add(fn);
    return () => this.#stateListeners.delete(fn);
  }

  #registerLoop(tabId: number, loop: AgentLoop): void {
    // Unsubscribe existing loop's listener if any
    this.#unsubscribes.get(tabId)?.();
    this.#loops.set(tabId, loop);

    const unsub = loop.subscribe((state) => {
      for (const listener of this.#stateListeners) {
        try {
          listener(tabId, state);
        } catch (err) {
          console.error('Error in state listener:', err);
        }
      }
    });
    this.#unsubscribes.set(tabId, unsub);
  }

  /**
   * Returns the existing loop for this tab, or creates a fresh one.
   */
  getOrCreate(tabId: number): AgentLoop {
    const existing = this.#loops.get(tabId);
    if (existing) return existing;
    const loop = new AgentLoop(tabId);
    this.#registerLoop(tabId, loop);
    return loop;
  }

  get(tabId: number): AgentLoop | undefined {
    return this.#loops.get(tabId);
  }

  has(tabId: number): boolean {
    return this.#loops.has(tabId);
  }

  /**
   * Start a task on the given tab.
   *
   * Rejects if a non-terminal task is already running there — the user must
   * explicitly stop it first rather than silently killing it.
   */
  async start(
    tabId: number,
    goal: string,
    opts?: {
      autoFillPrefilled?: boolean;
      userProfile?: UserProfile;
      savedFields?: Record<string, string>;
    },
  ): Promise<AgentState> {
    const existing = this.#loops.get(tabId);
    if (existing && !TERMINAL_PHASES.has(existing.state.phase)) {
      throw new Error('A task is already running on this tab.');
    }
    // Replace the old (terminal) loop with a fresh instance so taskId rotates.
    const loop = new AgentLoop(tabId);
    this.#registerLoop(tabId, loop);
    return loop.start(goal, opts);
  }

  /**
   * Stop and remove the loop for a tab. Safe to call for unknown tabIds.
   * Called on tabs.onRemoved so closed-tab loops are cleaned up immediately.
   */
  remove(tabId: number): void {
    const loop = this.#loops.get(tabId);
    if (!loop) return;
    this.#unsubscribes.get(tabId)?.();
    this.#unsubscribes.delete(tabId);
    loop.stop('Tab closed.');
    this.#loops.delete(tabId);
  }

  /**
   * Transition a non-terminal loop to 'interrupted' when the tab navigates
   * to a new page.
   */
  interrupt(tabId: number, reason = 'Page navigated away — task stopped.'): void {
    const loop = this.#loops.get(tabId);
    if (!loop || TERMINAL_PHASES.has(loop.state.phase)) return;
    loop.interrupt(reason);
  }

  /** Iterate over all (tabId, loop) pairs. */
  all(): IterableIterator<[number, AgentLoop]> {
    return this.#loops.entries();
  }

  /** Wire browser tab lifecycle events. */
  listenToTabEvents(): void {
    browser.tabs.onRemoved.addListener((tabId: number) => {
      this.remove(tabId);
    });

    browser.tabs.onUpdated.addListener(
      (tabId: number, changeInfo: { url?: string; status?: string }) => {
        // Only real navigations (url change), not hash/query updates.
        if (changeInfo.url) {
          this.interrupt(tabId);
        }
      },
    );
  }
}

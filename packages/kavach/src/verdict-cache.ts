/**
 * Verdict cache — step-scoped LRU that prevents re-scanning unchanged text.
 *
 * The content script re-runs the detection cascade on every step tick. Most text on the
 * page has not changed: the same nav bar, the same footer, the same static labels. Each
 * run costs regex time and, once NER ships, an inference round-trip. This cache gives
 * the cascade a fast path: if the normalised input is byte-identical to a previous scan
 * on the SAME step, return the stored verdict.
 *
 * ## Why step-scoped and not perpetual
 *
 * A DOM node's text can change between steps — a hostile page could swap the content of
 * a node from harmless text to PII after the first scan. Step-scoping means every step
 * starts clean: only within a single step do we skip re-scanning, and within a step the
 * DOM snapshot is frozen (PIPELINE.md §5.1, step 1).
 *
 * ## Why LRU
 *
 * A page with 10,000 text nodes would grow an unbounded cache until tab close. LRU with
 * a configurable cap ensures memory stays proportional to what we actually look at.
 */

export interface CachedVerdict<T> {
  readonly key: string;
  readonly step: number;
  readonly value: T;
}

export class VerdictCache<T> {
  readonly #maxSize: number;
  readonly #entries = new Map<string, CachedVerdict<T>>();
  #currentStep = 0;

  constructor(maxSize = 2048) {
    this.#maxSize = maxSize;
  }

  /** Advances the step clock and invalidates all cached verdicts. */
  setStep(step: number): void {
    if (step !== this.#currentStep) {
      this.#entries.clear();
      this.#currentStep = step;
    }
  }

  get step(): number {
    return this.#currentStep;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Returns the cached verdict for `key` if it exists and was set on the current step.
   * Promotes the entry in LRU order on hit.
   */
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;

    // Step mismatch means stale: evict and miss.
    if (entry.step !== this.#currentStep) {
      this.#entries.delete(key);
      return undefined;
    }

    // LRU promotion: delete and re-insert moves to end of insertion order.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Stores a verdict for `key` on the current step. Evicts the oldest entry if full. */
  set(key: string, value: T): void {
    // Delete first so re-insert goes to end of order.
    this.#entries.delete(key);

    if (this.#entries.size >= this.#maxSize) {
      // Evict the least recently used (first key in insertion order).
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }

    this.#entries.set(key, { key, step: this.#currentStep, value });
  }

  /** Returns true if a verdict for `key` exists on the current step. */
  has(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    if (entry.step !== this.#currentStep) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  /** Drops all cached verdicts. */
  clear(): void {
    this.#entries.clear();
  }

  /** Cache hit rate stats for observability. */
  #hits = 0;
  #misses = 0;

  hit(): void {
    this.#hits++;
  }

  miss(): void {
    this.#misses++;
  }

  stats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.#hits + this.#misses;
    return {
      hits: this.#hits,
      misses: this.#misses,
      hitRate: total === 0 ? 0 : this.#hits / total,
      size: this.#entries.size,
    };
  }
}

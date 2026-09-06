/**
 * THE ONLY PLACE IN THE CODEBASE WITH A BROWSER BRANCH (RULES.md X1).
 *
 * Everywhere else programs against these abstractions. If you find yourself writing
 * `if (isFirefox)` in another file, the abstraction is missing - add it here.
 */

import browser from 'webextension-polyfill';

export type BrowserTarget = 'chrome' | 'firefox';

/**
 * Detected at runtime rather than baked in, so one bundle behaves correctly if it is
 * ever loaded in the other engine (which happens constantly during development).
 */
export function detectTarget(): BrowserTarget {
  // `offscreen` exists only in Chromium; `sidebarAction` only in Firefox. Either alone
  // is a reliable discriminator, and checking both makes the intent legible.
  const api = browser as unknown as Record<string, unknown>;
  if (typeof api['offscreen'] === 'object') return 'chrome';
  if (typeof api['sidebarAction'] === 'object') return 'firefox';
  // Fall back to Chrome semantics: assuming the more restrictive environment (a service
  // worker with no DOM) fails safely, while assuming Firefox would break inference.
  return 'chrome';
}

/**
 * Where local inference lives.
 *
 * Chrome: an offscreen document, because MV3 service workers have no DOM and no
 * `navigator.gpu`, and are killed after ~30s idle - which would evict a loaded model
 * constantly.
 *
 * Firefox: the event page itself, which is already a document.
 */
export interface InferenceHost {
  readonly kind: 'offscreen-document' | 'event-page';
  /** Idempotent. Safe to call before every use. */
  ensure(): Promise<void>;
  /** Round-trips a message to prove the boundary is alive. */
  ping(): Promise<{ ok: boolean; host: string }>;
  teardown(): Promise<void>;
}

const OFFSCREEN_PATH = 'offscreen.html';

class ChromeOffscreenHost implements InferenceHost {
  readonly kind = 'offscreen-document' as const;
  #creating: Promise<void> | null = null;

  async ensure(): Promise<void> {
    const offscreen = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
    if (offscreen === undefined) throw new Error('offscreen API unavailable');

    if (await this.#exists()) return;
    // Concurrent callers must not race into two createDocument calls; Chrome throws
    // on the second and the error is easy to misread as a real failure.
    this.#creating ??= offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_SCRAPING'],
        justification:
          'Runs local vision and PII models with WebGPU. Service workers have neither DOM nor WebGPU.',
      })
      .finally(() => {
        this.#creating = null;
      });
    await this.#creating;
  }

  async #exists(): Promise<boolean> {
    const runtime = browser.runtime as unknown as {
      getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]>;
    };
    if (typeof runtime.getContexts !== 'function') return false;
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }

  async ping(): Promise<{ ok: boolean; host: string }> {
    await this.ensure();
    const reply = (await browser.runtime.sendMessage({ kind: 'HOST_PING' })) as
      | { ok: boolean; host: string }
      | undefined;
    return reply ?? { ok: false, host: 'offscreen (no reply)' };
  }

  async teardown(): Promise<void> {
    const offscreen = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
    if (offscreen === undefined) return;
    if (await this.#exists()) await offscreen.closeDocument();
  }
}

interface OffscreenApi {
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}

/** Firefox: the background page is already a document, so there is nothing to create. */
class EventPageHost implements InferenceHost {
  readonly kind = 'event-page' as const;
  ensure(): Promise<void> {
    return Promise.resolve();
  }
  ping(): Promise<{ ok: boolean; host: string }> {
    const hasDom = typeof document !== 'undefined';
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    return Promise.resolve({
      ok: hasDom,
      host: 'event-page' + (hasGpu ? ' (webgpu available)' : ' (wasm only)'),
    });
  }
  teardown(): Promise<void> {
    return Promise.resolve();
  }
}

export function createInferenceHost(target: BrowserTarget = detectTarget()): InferenceHost {
  return target === 'chrome' ? new ChromeOffscreenHost() : new EventPageHost();
}

/** Opens the extension's own UI surface, whatever it is called in this browser. */
export async function openPanel(tabId: number | undefined): Promise<void> {
  const api = browser as unknown as {
    sidePanel?: { open: (o: { tabId?: number }) => Promise<void> };
    sidebarAction?: { open: () => Promise<void> };
  };
  if (api.sidePanel !== undefined) {
    await api.sidePanel.open(tabId === undefined ? {} : { tabId });
    return;
  }
  if (api.sidebarAction !== undefined) {
    await api.sidebarAction.open();
  }
}

export { browser };

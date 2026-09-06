/**
 * NETRA inference host (Chrome).
 *
 * Exists because MV3 service workers have no DOM and no `navigator.gpu`, and are
 * killed after ~30s idle - which would evict a loaded model from VRAM constantly.
 * On Firefox the event page is already a document, so this file is not used there and
 * `platform/EventPageHost` answers the same ping.
 *
 * Right now it only reports its capabilities. From Phase 2 this is where ONNX Runtime
 * Web, BlazeFace, the UI-element detector and GLiNER live, with a warm session pool.
 */

import browser from 'webextension-polyfill';
import type { Request } from '../shared/messages.js';

function describeCapabilities(): string {
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const cores = navigator.hardwareConcurrency;
  return (
    'offscreen-document (' +
    (hasGpu ? 'webgpu available' : 'wasm only') +
    ', ' + String(cores) + ' cores)'
  );
}

browser.runtime.onMessage.addListener((raw: unknown): Promise<unknown> | undefined => {
  const msg = raw as Request | undefined;
  if (msg?.kind !== 'HOST_PING') return undefined;
  return Promise.resolve({ ok: true, host: describeCapabilities() });
});

// A probe, not a commitment: it tells the capability report whether the WebGPU path is
// real on this machine without downloading a model. Full probe is ticket C1.
void (async () => {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (gpu === undefined) return;
  try {
    await gpu.requestAdapter();
  } catch {
    // Adapter unavailable is a normal outcome, not an error worth surfacing.
  }
})();

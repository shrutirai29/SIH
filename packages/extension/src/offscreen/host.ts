/**
 * NETRA inference host (Chrome).
 *
 * The offscreen document owns the long-lived local vision models because
 * Chrome MV3 service workers have no DOM and cannot reliably keep models
 * loaded in memory.
 */

import browser from 'webextension-polyfill';

import {
  NetraInferenceHost,
  probeDevice,
} from '@prahari/netra';

import type { Request } from '../shared/messages.js';

const netra = new NetraInferenceHost();

let initialization: Promise<void> | null = null;

/**
 * Initializes NETRA exactly once.
 *
 * Multiple messages may arrive while the model is loading, so all callers
 * share the same initialization promise.
 */
function ensureNetra(): Promise<void> {
  initialization ??= (async () => {
    const profile = await probeDevice();

    console.log(
      'NETRA: initializing inference host',
      profile,
    );

    await netra.init(profile);

    console.log('NETRA: inference host ready');
  })();

  return initialization;
}

function describeCapabilities(): string {
  const hasGpu =
    typeof navigator !== 'undefined' &&
    'gpu' in navigator;

  const cores = navigator.hardwareConcurrency;

  return (
    'offscreen-document (' +
    (hasGpu ? 'webgpu available' : 'wasm only') +
    ', ' +
    String(cores) +
    ' cores)'
  );
}

browser.runtime.onMessage.addListener(
  (raw: unknown): Promise<unknown> | undefined => {
    const msg = raw as Request | undefined;

    if (msg?.kind === 'HOST_PING') {
      return Promise.resolve({
        ok: true,
        host: describeCapabilities(),
      });
    }

    if (msg?.kind === 'DETECT_FACES') {
      return (async () => {
        await ensureNetra();

        const faces = await netra.detectFaces(
          msg.image,
          [],
        );

        return { faces };
      })();
    }

    return undefined;
  },
);

/**
 * Probe WebGPU availability without forcing model initialization.
 */
void (async () => {
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter: () => Promise<unknown>;
      };
    }
  ).gpu;

  if (gpu === undefined) return;

  try {
    await gpu.requestAdapter();
  } catch {
    // Adapter unavailable is a normal fallback condition.
  }
})();
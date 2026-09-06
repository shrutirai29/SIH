/**
 * Content script entry. Runs in the ISOLATED world, so page JS can neither observe
 * nor tamper with extraction.
 *
 * Everything sensitive happens here, on purpose. Redaction runs before anything
 * crosses a message boundary, and the vault — the only decoder for the tokens the
 * server reasons over — lives in this context too (ADR-0002). A raw value therefore
 * never enters a `postMessage` in either direction.
 *
 * This file must never call the network (RULES.md P1) — the lint rule enforces it.
 */

import browser from 'webextension-polyfill';
import type { ExecuteAction, ExtractScreen, Request, SetOverlay } from '../shared/messages.js';
import { extractScreen } from './extract.js';
import { execute } from './executor.js';
import { wipeSession } from './session.js';
import { setOverlayEnabled } from './overlay.js';
import { runCanaryAudit } from './canary-audit.js';

browser.runtime.onMessage.addListener((raw: unknown): Promise<unknown> | undefined => {
  const msg = raw as Request | undefined;
  if (msg === undefined || typeof msg.kind !== 'string') return undefined;

  if (msg.kind === 'EXTRACT_SCREEN') {
    const m = msg as ExtractScreen;
    // Async now: minting a token is an HMAC, and the vault must hold the binding
    // before an SSG referencing its tokens can be built.
    return extractScreen({
      goal: m.goal,
      step: m.step,
      traceId: m.traceId,
      sessionId: m.sessionId,
    });
  }

  if (msg.kind === 'EXECUTE_ACTION') {
    const m = msg as ExecuteAction;
    return execute(m.action);
  }

  if (msg.kind === 'SET_OVERLAY') {
    setOverlayEnabled((msg as SetOverlay).enabled);
    return Promise.resolve({ ok: true });
  }

  if (msg.kind === 'RUN_CANARY_AUDIT') {
    // Plants into the live DOM, runs the real extractor over it, and restores in a
    // `finally`. This half answers "did anything the redactor produced contain a
    // canary?"; the background then asks the guard the same question independently.
    return runCanaryAudit();
  }

  if (msg.kind === 'STOP_TASK') {
    // Kill switch. The vault is wiped in the tab that holds it, which is the only
    // place it ever existed.
    wipeSession();
    setOverlayEnabled(false);
    return Promise.resolve({ outcome: 'blocked', detail: 'session wiped' });
  }

  // Not addressed to us. Leave the channel for the background or offscreen document.
  return undefined;
});

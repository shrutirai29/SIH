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
import type {
  AgentState,
  ExecuteAction,
  ExtractScreen,
  Request,
  SetMascotVisible,
  SetOverlay,
} from '../shared/messages.js';
import { extractScreen } from './extract.js';
import { execute } from './executor.js';
import { wipeSession } from './session.js';
import { setOverlayEnabled } from './overlay.js';
import { runCanaryAudit } from './canary-audit.js';
import { getMascotOverlay } from './mascot/mascot-overlay.js';

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

  if (msg.kind === 'TOGGLE_MASCOT') {
    const mascot = getMascotOverlay();
    mascot.toggle();
    return Promise.resolve({ visible: mascot.getVisible() });
  }

  if (msg.kind === 'SET_MASCOT_VISIBLE') {
    const mascot = getMascotOverlay();
    if ((msg as SetMascotVisible).visible) {
      mascot.show();
    } else {
      mascot.hide();
    }
    return Promise.resolve({ ok: true });
  }

  if ((msg as { kind: string }).kind === 'STATE_UPDATE') {
    const push = msg as unknown as { state: AgentState };
    if (push.state) {
      // If a task starts or is active, ensure the mascot is visible to display progress
      if (push.state.phase !== 'idle') {
        getMascotOverlay().show();
      }
      getMascotOverlay().updateState(push.state);
    }
    return Promise.resolve({ ok: true });
  }

  if (msg.kind === 'TASK_NOTIFY') {
    const notify = msg as unknown as {
      tabId: number;
      tabTitle: string;
      phase: AgentState['phase'];
      message: string;
    };
    getMascotOverlay().showToast(notify);
    return Promise.resolve({ ok: true });
  }

  if (msg.kind === 'SET_MASCOT_THEME') {
    const themeMsg = msg as unknown as { themeIndex?: number; themeName?: string; tabNumber?: number };
    const mascot = getMascotOverlay();
    if (typeof themeMsg.tabNumber === 'number') {
      mascot.setTabNumber(themeMsg.tabNumber);
    }
    if (typeof themeMsg.themeIndex === 'number') {
      mascot.setTheme(themeMsg.themeIndex);
    } else if (typeof themeMsg.themeName === 'string') {
      mascot.setThemeByName(themeMsg.themeName);
    }
    return Promise.resolve({ ok: true });
  }

  // Not addressed to us. Leave the channel for the background or offscreen document.
  return undefined;
});

// On page load or navigation, query current tab's agent state from background.
// If an active task is running, automatically show the mascot and synchronize state.
browser.runtime
  .sendMessage({ kind: 'GET_STATE' })
  .then((rawState) => {
    const s = rawState as (AgentState & { tabNumber?: number }) | null;
    if (s && s.phase && s.phase !== 'idle') {
      const mascot = getMascotOverlay();
      if (typeof s.tabNumber === 'number') {
        mascot.setTabNumber(s.tabNumber);
      }
      mascot.show();
      mascot.updateState(s);
    }
  })
  .catch(() => {
    // Ignore initial state query error if background script is not ready
  });



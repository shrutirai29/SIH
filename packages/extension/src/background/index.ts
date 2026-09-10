/**
 * Background entry point.
 *
 * Chrome: MV3 service worker. Firefox: event page. The difference is confined to the
 * manifest and `platform/`; this file is identical on both.
 *
 * The background owns the network because it is the only context that survives
 * navigation and the only one we can starve of everything else.
 */

import { browser, openPanel } from '../platform/index.js';
import { PANEL_PORT, type PanelPush, type Request } from '../shared/messages.js';
import { AgentLoop } from './agent-loop.js';

const loop = new AgentLoop();

/* -------------------------------------------------- side panel live subscription */

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  const unsubscribe = loop.subscribe((state) => {
    const push: PanelPush = { kind: 'STATE_UPDATE', state };
    try {
      port.postMessage(push);
    } catch {
      // The panel closed between the state change and this post. Nothing to do.
    }
  });
  port.onDisconnect.addListener(unsubscribe);
});



/* ------------------------------------------------------------- request handling */

browser.runtime.onMessage.addListener((raw: unknown): Promise<unknown> | undefined => {
  const msg = raw as Request | undefined;
  if (msg === undefined || typeof msg.kind !== 'string') return undefined;

  switch (msg.kind) {
    case 'START_TASK':
      return loop.start(msg.goal);

    case 'STOP_TASK':
      loop.stop();
      return Promise.resolve(loop.state);

    case 'GET_STATE':
      return Promise.resolve(loop.state);

    case 'GET_LEDGER':
      return loop.ledger.list();

    case 'SELF_TEST':
      return loop.selfTest();

    case 'SET_OVERLAY':
      return loop.setOverlay(msg.enabled);

    case 'RUN_CANARY_AUDIT':
      return loop.canaryAudit();

    case 'GET_TRANSMISSION':
      // The exact bytes of a past step, from memory. Nothing is read back from
      // storage, because nothing was written there (RULES.md P8).
      return Promise.resolve(loop.transmissions.get(msg.traceId) ?? null);

    // Messages addressed to other contexts. Returning undefined leaves the channel
    // open for the offscreen document or content script to answer.
    case 'HOST_PING':
    case 'DETECT_FACES':
    case 'EXTRACT_SCREEN':
    case 'EXECUTE_ACTION':
      return undefined;

    default: {
      // Exhaustiveness: adding a message kind without handling it fails the build.
      const _never: never = msg;
      void _never;
      return undefined;
    }
  }
});

/* --------------------------------------------------------------- toolbar action */

browser.action.onClicked.addListener((tab) => {
  void openPanel(tab.id);
});

// Chrome only: make clicking the toolbar icon open the side panel directly.
const sidePanel = (browser as unknown as {
  sidePanel?: { setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void> };
}).sidePanel;
void sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // Not fatal: the onClicked handler above is the fallback.
});

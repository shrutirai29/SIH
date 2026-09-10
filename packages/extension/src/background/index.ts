/**
 * Background entry point.
 *
 * Chrome: MV3 service worker. Firefox: event page. The difference is confined to the
 * manifest and `platform/`; this file is identical on both.
 *
 * The background owns the network because it is the only context that survives
 * navigation and the only one we can starve of everything else.
 */

import type { Runtime } from 'webextension-polyfill';
import { browser } from '../platform/index.js';
import { PANEL_PORT, type AgentState, type PanelPush, type Request } from '../shared/messages.js';
import { AgentManager } from './agent-manager.js';
import { ExtensionLedgerStore } from './ledger-store.js';

const manager = new AgentManager();
manager.listenToTabEvents();

/* --------------------------------------------- side panel port & subscriptions */

const panelPorts = new Set<Runtime.Port>();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  panelPorts.add(port);

  // Send current state for all existing loops immediately on connect
  for (const [, loop] of manager.all()) {
    try {
      const push: PanelPush = { kind: 'STATE_UPDATE', state: loop.state };
      port.postMessage(push);
    } catch {
      // Ignore initial post errors
    }
  }

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
});

/* ---------------------------------------------- badge & notification tracking */

const unacknowledgedTerminalTasks = new Set<string>();

function updateBadge(): void {
  const count = unacknowledgedTerminalTasks.size;
  const text = count > 0 ? String(count) : '';
  try {
    if (browser.action?.setBadgeText) {
      browser.action.setBadgeText({ text }).catch(() => {});
    }
  } catch {
    // Ignore badge update errors in unsupported contexts
  }
}

function clearBadgeForTask(taskId: string): void {
  if (unacknowledgedTerminalTasks.delete(taskId)) {
    updateBadge();
  }
}

/* ---------------------------------------------- state distribution & notifications */

const tabNumberMap = new Map<number, number>();
function getTabNumber(tabId: number): number {
  if (!tabNumberMap.has(tabId)) {
    tabNumberMap.set(tabId, tabNumberMap.size + 1);
  }
  return tabNumberMap.get(tabId)!;
}

manager.onStateChange(async (tabId, state) => {
  const tabNumber = getTabNumber(tabId);
  const themeIndex = (tabNumber - 1) % 6;
  const enrichedState: AgentState = { ...state, tabNumber };

  // 0. Send tab-specific color theme and tabNumber to mascot
  browser.tabs.sendMessage(tabId, { kind: 'SET_MASCOT_THEME', themeIndex, tabNumber }).catch(() => {});

  // 1. Send state update directly to the task's own tab (mascot updates in background)
  browser.tabs.sendMessage(tabId, { kind: 'STATE_UPDATE', state: enrichedState }).catch(() => {
    // Tab may not have content script running or might be navigating
  });

  // 2. Forward push to all open side panel ports
  const push: PanelPush = { kind: 'STATE_UPDATE', state: enrichedState };
  for (const port of panelPorts) {
    try {
      port.postMessage(push);
    } catch {
      panelPorts.delete(port);
    }
  }

  // 3. Handle terminal notifications (done / blocked / error / interrupted)
  const isTerminal =
    state.phase === 'done' ||
    state.phase === 'blocked' ||
    state.phase === 'error' ||
    state.phase === 'interrupted';

  if (isTerminal && state.taskId) {
    unacknowledgedTerminalTasks.add(state.taskId);
    updateBadge();

    try {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id !== undefined && activeTab.id !== tabId) {
        // Retrieve the task tab's title
        let tabTitle = `Tab #${tabId}`;
        try {
          const taskTab = await browser.tabs.get(tabId);
          if (taskTab?.title) tabTitle = taskTab.title;
        } catch {
          // Tab might have just closed
        }

        // Send cross-tab toast notification to the focused tab
        browser.tabs
          .sendMessage(activeTab.id, {
            kind: 'TASK_NOTIFY',
            tabId,
            tabTitle,
            phase: state.phase,
            message: state.message,
          })
          .catch(() => {
            // Focused tab might be a restricted browser tab (e.g. chrome://)
          });
      }
    } catch {
      // Ignore tab query errors
    }

    // Fallback system notification (covers cases where active tab has no content script)
    try {
      if (browser.notifications?.create) {
        browser.notifications
          .create({
            type: 'basic',
            iconUrl: 'icon128.png',
            title: `PRAHARI: Task ${state.phase}`,
            message: state.message || `Task on tab ${tabId} reached state: ${state.phase}`,
          })
          .catch(() => {});
      }
    } catch {
      // Notifications API may not be available on all browsers
    }
  }
});

/* ------------------------------------------------------------- request handling */

async function getEffectiveTabId(msgTabId?: number, senderTabId?: number): Promise<number | undefined> {
  const isWeb = (u?: string) =>
    Boolean(
      u &&
        !u.startsWith('chrome://') &&
        !u.startsWith('chrome-extension://') &&
        !u.startsWith('edge://') &&
        !u.startsWith('about:') &&
        !u.startsWith('moz-extension://'),
    );

  if (typeof msgTabId === 'number' && msgTabId > 0) {
    try {
      const tab = await browser.tabs.get(msgTabId);
      if (tab?.id !== undefined && isWeb(tab.url)) return tab.id;
    } catch {
      // ignore
    }
  }
  if (typeof senderTabId === 'number' && senderTabId > 0) {
    try {
      const tab = await browser.tabs.get(senderTabId);
      if (tab?.id !== undefined && isWeb(tab.url)) return tab.id;
    } catch {
      // ignore
    }
  }
  try {
    const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused?.id !== undefined && isWeb(focused.url)) return focused.id;
  } catch {
    // ignore
  }
  try {
    const activeTabs = await browser.tabs.query({ active: true });
    const webActive = activeTabs.find((t) => isWeb(t.url));
    if (webActive?.id !== undefined) return webActive.id;
  } catch {
    // ignore
  }
  try {
    const allTabs = await browser.tabs.query({});
    const webTab = allTabs.find((t) => isWeb(t.url));
    if (webTab?.id !== undefined) return webTab.id;
  } catch {
    // ignore
  }
  return msgTabId ?? senderTabId;
}

browser.runtime.onMessage.addListener(
  (raw: unknown, sender: Runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = raw as (Request | { kind: string; [k: string]: unknown }) | undefined;
    if (msg === undefined || typeof msg.kind !== 'string') return undefined;

    switch (msg.kind) {
      case 'START_TASK': {
        const startMsg = msg as { kind: 'START_TASK'; goal: string; tabId?: number; autoFillPrefilled?: boolean; userProfile?: unknown };
        return (async () => {
          const tabId = await getEffectiveTabId(startMsg.tabId, sender.tab?.id);
          if (tabId === undefined) {
            throw new Error('START_TASK requires a valid tabId or active tab');
          }
          // Load any permanently-saved field answers from storage so the agent
          // pre-populates them without asking the user again.
          let savedFields: Record<string, string> = {};
          try {
            const stored = await browser.storage.local.get('prahari_saved_fields');
            if (stored['prahari_saved_fields'] && typeof stored['prahari_saved_fields'] === 'object') {
              savedFields = stored['prahari_saved_fields'] as Record<string, string>;
            }
          } catch {
            // Ignore storage errors — saved fields are a convenience, not critical.
          }
          return manager.start(tabId, startMsg.goal, {
            autoFillPrefilled: startMsg.autoFillPrefilled,
            userProfile: startMsg.userProfile as import('../shared/profile.js').UserProfile | undefined,
            savedFields,
          });
        })();
      }

      case 'STOP_TASK': {
        const stopMsg = msg as { kind: 'STOP_TASK'; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(stopMsg.tabId, sender.tab?.id);
          if (tabId === undefined) return null;
          const loop = manager.get(tabId);
          if (loop) {
            loop.stop();
            clearBadgeForTask(loop.taskId);
            return loop.state;
          }
          return null;
        })();
      }

      case 'GET_TAB_INFO': {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          return Promise.resolve({ tabNumber: 1, themeIndex: 0 });
        }
        const tabNumber = getTabNumber(tabId);
        const themeIndex = (tabNumber - 1) % 6;
        return Promise.resolve({ tabNumber, themeIndex, tabId });
      }

      case 'GET_STATE': {
        const getMsg = msg as { kind: 'GET_STATE'; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(getMsg.tabId, sender.tab?.id);
          if (tabId === undefined) return null;
          const loop = manager.get(tabId);
          if (!loop) return null;
          const tabNumber = getTabNumber(tabId);
          return { ...loop.state, tabNumber };
        })();
      }

      case 'GET_LEDGER': {
        const ledgerMsg = msg as { kind: 'GET_LEDGER'; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(ledgerMsg.tabId, sender.tab?.id);
          if (typeof tabId === 'number') {
            const loop = manager.get(tabId);
            if (loop) return loop.ledger.list();
          }
          for (const [, loop] of manager.all()) {
            const list = await loop.ledger.list();
            if (list.length > 0) return list;
          }
          const store = new ExtensionLedgerStore();
          return store.read();
        })();
      }

      case 'SELF_TEST': {
        const selfMsg = msg as { kind: 'SELF_TEST'; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(selfMsg.tabId, sender.tab?.id);
          if (tabId === undefined) return { passed: false, checks: [] };
          const loop = manager.getOrCreate(tabId);
          return loop.selfTest();
        })();
      }

      case 'SET_OVERLAY': {
        const overlayMsg = msg as { kind: 'SET_OVERLAY'; enabled: boolean; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(overlayMsg.tabId, sender.tab?.id);
          if (tabId === undefined) return { ok: false };
          const loop = manager.get(tabId);
          return loop ? loop.setOverlay(overlayMsg.enabled) : { ok: false };
        })();
      }

      case 'RUN_CANARY_AUDIT': {
        const canaryMsg = msg as { kind: 'RUN_CANARY_AUDIT'; tabId?: number };
        return (async () => {
          const tabId = await getEffectiveTabId(canaryMsg.tabId, sender.tab?.id);
          const loop = manager.getOrCreate(tabId ?? 0);
          return loop.canaryAudit();
        })();
      }

      case 'GET_TRANSMISSION': {
        const transMsg = msg as { kind: 'GET_TRANSMISSION'; traceId: string; tabId?: number };
        return (async () => {
          if (typeof transMsg.tabId === 'number') {
            const loop = manager.get(transMsg.tabId);
            const found = loop?.transmissions.get(transMsg.traceId);
            if (found) return found;
          }
          for (const [, loop] of manager.all()) {
            const found = loop.transmissions.get(transMsg.traceId);
            if (found) return found;
          }
          return null;
        })();
      }

      case 'FOCUS_TAB': {
        const focusMsg = msg as { kind: 'FOCUS_TAB'; tabId: number };
        if (typeof focusMsg.tabId === 'number') {
          const loop = manager.get(focusMsg.tabId);
          if (loop) {
            clearBadgeForTask(loop.taskId);
          }
          browser.tabs.update(focusMsg.tabId, { active: true }).catch(() => {});
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false });
      }

      // Messages addressed to other contexts (content script, offscreen document).
      // Returning undefined leaves the channel open for them to answer.
      case 'HOST_PING':
      case 'DETECT_FACES':
      case 'EXTRACT_SCREEN':
      case 'EXECUTE_ACTION':
      case 'TOGGLE_MASCOT':
      case 'SET_MASCOT_VISIBLE':
      case 'SET_MASCOT_THEME':
      case 'TASK_NOTIFY':
        return undefined;

      case 'ANSWER_QUESTION': {
        const answerMsg = msg as { kind: 'ANSWER_QUESTION'; tabId?: number; fieldKey: string; value: string };
        return (async () => {
          const tabId = await getEffectiveTabId(answerMsg.tabId, sender.tab?.id);
          if (tabId === undefined) return { ok: false };
          const loop = manager.get(tabId);
          if (loop) {
            loop.provideAnswer(answerMsg.fieldKey, answerMsg.value);
            return { ok: true };
          }
          return { ok: false };
        })();
      }

      case 'SAVE_FIELD': {
        // Persist a field answer permanently so future tasks skip asking.
        const saveMsg = msg as { kind: 'SAVE_FIELD'; fieldKey: string; label: string; value: string };
        return (async () => {
          try {
            const stored = await browser.storage.local.get('prahari_saved_fields');
            const existing: Record<string, string> =
              (stored['prahari_saved_fields'] as Record<string, string>) ?? {};
            existing[saveMsg.fieldKey] = saveMsg.value;
            await browser.storage.local.set({ prahari_saved_fields: existing });
            return { ok: true };
          } catch {
            return { ok: false };
          }
        })();
      }

      default: {
        return undefined;
      }
    }
  },
);

/* --------------------------------------------------------------- toolbar action */

// On extension toolbar click:
//   1. Open the side panel (primary action - the user's main control UI)
//   2. Inject/show the floating mascot icon on the active page (so the agent can be seen on-page)
browser.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;

  // Step 1: Open the side panel
  try {
    const sidePanel = (globalThis as unknown as {
      chrome?: { sidePanel?: { open: (opts: { tabId?: number }) => Promise<void> } };
    }).chrome?.sidePanel;
    if (sidePanel?.open) {
      await sidePanel.open({ tabId: tab.id });
    }
  } catch (e) {
    console.warn('PRAHARI: could not open side panel:', e);
  }

  // Step 2: Toggle the floating mascot on the page (only for real web pages)
  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://')
  ) {
    return; // Cannot inject into browser internal pages
  }

  try {
    const res = (await browser.tabs.sendMessage(tab.id, { kind: 'TOGGLE_MASCOT' })) as
      | { visible?: boolean }
      | undefined;
    if (res === undefined) throw new Error('No response');
  } catch {
    // Content script not yet active — inject it first then show mascot
    try {
      if (browser.scripting) {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        setTimeout(() => {
          if (tab.id !== undefined) {
            browser.tabs
              .sendMessage(tab.id, { kind: 'SET_MASCOT_VISIBLE', visible: true })
              .catch(() => {});
          }
        }, 80);
      }
    } catch (err) {
      console.error('Failed to inject PRAHARI mascot:', err);
    }
  }
});


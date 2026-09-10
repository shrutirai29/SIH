/**
 * The side panel.
 *
 * Its job is not decoration: PRD.md principle 4 is "show your work". Every privacy
 * claim the system makes has to be visible here, or it is just a slide.
 *
 * Present in the multi-mascot extension:
 * - Tab-aware task manager: tracks multiple concurrent tasks across tabs
 * - Tab selector for launching or inspecting tasks on specific tabs
 * - Live phase, byte counter, redaction counter per tab
 * - Privacy ledger with per-entry hashes and diff inspector
 * - Live canary audit and self-test per tab
 */

import { useCallback, useEffect, useState } from 'react';
import type { Runtime } from 'webextension-polyfill';
import browser from 'webextension-polyfill';
import type { LedgerEntry } from '@prahari/kavach';

import {
  PANEL_PORT,
  type AgentState,
  type CanaryAuditResult,
  type PanelPush,
  type SelfTestResult,
} from '../shared/messages.js';

import { CONFIG } from '../shared/config.js';
import { DEFAULT_PROFILE, getStoredProfile, saveStoredProfile, type UserProfile } from '../shared/profile.js';
import { DiffViewer } from './DiffViewer.js';

type MainTab = 'task' | 'ledger' | 'profile';

interface BrowserTabInfo {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string | undefined;
}

const PHASE_LABEL: Record<AgentState['phase'], string> = {
  idle: 'Idle',
  observing: 'Reading screen',
  sanitizing: 'Redacting',
  sending: 'Guard check',
  thinking: 'Server planning',
  acting: 'Acting',
  done: 'Done',
  blocked: 'Blocked',
  error: 'Error',
  interrupted: 'Interrupted',
};

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  if (n < 1024) return String(n) + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

const OUTCOME_LABEL: Record<LedgerEntry['outcome'], string> = {
  attempted: 'OFFERED',
  sent: 'SENT',
  failed: 'NOT SENT',
  blocked: 'BLOCKED',
};

export function App(): React.JSX.Element {
  const [states, setStates] = useState<Map<number, AgentState>>(new Map());
  const [availableTabs, setAvailableTabs] = useState<BrowserTabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [goal, setGoal] = useState('');
  const [mainTab, setMainTab] = useState<MainTab>('task');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(true);
  const [audit, setAudit] = useState<CanaryAuditResult | null>(null);

  const [userProfile, setUserProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [profileSavedMsg, setProfileSavedMsg] = useState(false);

  useEffect(() => {
    getStoredProfile().then((p) => setUserProfile(p));
  }, []);

  const handleSaveProfile = async (p: UserProfile) => {
    setUserProfile(p);
    await saveStoredProfile(p);
    setProfileSavedMsg(true);
    setTimeout(() => setProfileSavedMsg(false), 3000);
  };

  // Load available browser tabs (filtering restricted schemes)
  const refreshTabs = useCallback(async (): Promise<void> => {
    try {
      const tabs = await browser.tabs.query({});
      const filtered: BrowserTabInfo[] = [];

      for (const t of tabs) {
        if (t.id === undefined) continue;
        const u = t.url || '';
        if (
          u.startsWith('chrome://') ||
          u.startsWith('chrome-extension://') ||
          u.startsWith('edge://') ||
          u.startsWith('about:') ||
          u.startsWith('moz-extension://')
        ) {
          continue;
        }
        filtered.push({
          id: t.id,
          title: t.title || `Tab #${t.id}`,
          url: u,
          favIconUrl: t.favIconUrl,
        });
      }

      setAvailableTabs(filtered);

      // Default selectedTabId to the currently active tab if not set or invalid
      if (filtered.length > 0) {
        const [active] = await browser.tabs.query({ active: true, currentWindow: true });
        if (active?.id !== undefined && filtered.some((f) => f.id === active.id)) {
          setSelectedTabId((prev) => (prev !== null && filtered.some((f) => f.id === prev) ? prev : active.id!));
        } else {
          const firstId = filtered[0]?.id;
          if (firstId !== undefined) {
            setSelectedTabId((prev) => (prev !== null && filtered.some((f) => f.id === prev) ? prev : firstId));
          }
        }
      }
    } catch (err) {
      console.error('Failed to query tabs:', err);
    }
  }, []);

  useEffect(() => {
    void refreshTabs();

    const handleActivated = (activeInfo: { tabId: number }) => {
      setSelectedTabId(activeInfo.tabId);
      void refreshTabs();
    };

    const handleUpdated = (_tabId: number, changeInfo: { status?: string }) => {
      if (changeInfo.status === 'complete') {
        void refreshTabs();
      }
    };

    browser.tabs.onActivated.addListener(handleActivated);
    browser.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      browser.tabs.onActivated.removeListener(handleActivated);
      browser.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [refreshTabs]);

  // Subscribe to background push stream via PANEL_PORT
  useEffect(() => {
    let port: Runtime.Port | null = null;
    try {
      port = browser.runtime.connect({ name: PANEL_PORT });

      port.onMessage.addListener((raw: unknown) => {
        const msg = raw as PanelPush | undefined;
        if (msg?.kind === 'STATE_UPDATE' && msg.state) {
          setStates((prev) => {
            const next = new Map(prev);
            const tid = msg.state.tabId;
            if (tid) {
              next.set(tid, msg.state);
            }
            return next;
          });
        }
      });
    } catch {
      // Connect failed
    }

    return () => {
      port?.disconnect();
    };
  }, []);

  const currentState = selectedTabId !== null ? states.get(selectedTabId) ?? null : null;

  const refreshLedger = useCallback(async (): Promise<void> => {
    if (selectedTabId === null) {
      setLedger([]);
      return;
    }
    try {
      const entries = (await browser.runtime.sendMessage({
        kind: 'GET_LEDGER',
        tabId: selectedTabId,
      })) as LedgerEntry[];

      setLedger([...(entries || [])].reverse());
    } catch {
      setLedger([]);
    }
  }, [selectedTabId]);

  useEffect(() => {
    if (mainTab === 'ledger') {
      void refreshLedger();
    }
  }, [mainTab, currentState?.step, refreshLedger]);

  const start = async (): Promise<void> => {
    let targetTabId = selectedTabId;
    if (targetTabId === null) {
      try {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        targetTabId = activeTab?.id ?? null;
      } catch {
        targetTabId = null;
      }
    }
    if (goal.trim().length === 0 || targetTabId === null) return;

    setBusy(true);
    setSelfTest(null);

    try {
      await browser.runtime.sendMessage({
        kind: 'START_TASK',
        tabId: targetTabId,
        goal: goal.trim(),
      });
    } catch (err) {
      console.error('Failed to start task:', err);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (tabId?: number): Promise<void> => {
    const target = tabId ?? selectedTabId;
    if (target === null || target === undefined) return;
    await browser.runtime.sendMessage({
      kind: 'STOP_TASK',
      tabId: target,
    });
  };

  const focusTab = async (tabId: number): Promise<void> => {
    await browser.runtime.sendMessage({
      kind: 'FOCUS_TAB',
      tabId,
    });
  };

  useEffect(() => {
    if (selectedTabId !== null) {
      void browser.runtime.sendMessage({
        kind: 'SET_OVERLAY',
        tabId: selectedTabId,
        enabled: overlay,
      }).catch(() => {});
    }
  }, [overlay, selectedTabId]);

  const runAudit = async (): Promise<void> => {
    if (selectedTabId === null) return;
    setBusy(true);
    setAudit(null);

    try {
      const result = (await browser.runtime.sendMessage({
        kind: 'RUN_CANARY_AUDIT',
        tabId: selectedTabId,
      })) as CanaryAuditResult;

      setAudit(result);
    } finally {
      setBusy(false);
    }
  };

  const runSelfTest = async (): Promise<void> => {
    if (selectedTabId === null) return;
    setBusy(true);

    try {
      const result = (await browser.runtime.sendMessage({
        kind: 'SELF_TEST',
        tabId: selectedTabId,
      })) as SelfTestResult;

      setSelfTest(result);
      await refreshLedger();
    } finally {
      setBusy(false);
    }
  };

  const [isPrahariOn, setIsPrahariOn] = useState<boolean>(false);

  const toggleFloatingMascot = async (): Promise<void> => {
    const nextState = !isPrahariOn;
    try {
      // Prioritize the active tab in the current window
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      const targetId = active?.id ?? selectedTabId;
      if (targetId === null || targetId === undefined) return;

      setSelectedTabId(targetId);

      try {
        await browser.tabs.sendMessage(targetId, { kind: 'SET_MASCOT_VISIBLE', visible: nextState });
        setIsPrahariOn(nextState);
      } catch {
        if (browser.scripting) {
          try {
            await browser.scripting.executeScript({
              target: { tabId: targetId },
              files: ['content.js'],
            });
            await new Promise((r) => setTimeout(r, 300));
            await browser.tabs.sendMessage(targetId, { kind: 'SET_MASCOT_VISIBLE', visible: nextState });
            setIsPrahariOn(nextState);
          } catch (scriptErr) {
            console.error('Failed to inject content script:', scriptErr);
          }
        }
      }
    } catch (e) {
      console.error('Error toggling mascot from sidepanel:', e);
    }
  };

  const running =
    currentState !== null &&
    !['idle', 'done', 'error', 'blocked', 'interrupted'].includes(currentState.phase);

  // List of active / non-idle tasks across tabs
  const activeTaskEntries = Array.from(states.entries()).filter(
    ([, s]) => s.phase !== 'idle' || s.goal.length > 0,
  );

  return (
    <div className="app">
      <header className="head">
        <div className="brand">
          <span className="mark">प</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <h1 style={{ margin: 0 }}>PRAHARI</h1>
              <span
                style={{
                  fontSize: '10px',
                  background: 'rgba(59, 130, 246, 0.25)',
                  color: '#93c5fd',
                  border: '1px solid rgba(59, 130, 246, 0.5)',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  fontWeight: 700,
                }}
              >
                Tab #{selectedTabId ?? '—'}
              </span>
            </div>
            <p className="sub">
              Privacy-preserving concurrent agent tasks
            </p>
          </div>
        </div>

        <button
          className={`btn-mascot-toggle ${isPrahariOn ? 'on' : 'off'}`}
          onClick={toggleFloatingMascot}
          title={isPrahariOn ? 'Turn PRAHARI OFF' : 'Turn PRAHARI ON'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            background: isPrahariOn
              ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
              : 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
            color: '#fff',
            border: 'none',
            padding: '6px 14px',
            borderRadius: '20px',
            fontSize: '12px',
            fontWeight: '700',
            cursor: 'pointer',
            boxShadow: isPrahariOn
              ? '0 0 12px rgba(16, 185, 129, 0.4)'
              : '0 0 12px rgba(239, 68, 68, 0.4)',
            transition: 'all 0.2s ease',
          }}
        >
          <span style={{ fontSize: '10px' }}>{isPrahariOn ? '🟢' : '🔴'}</span>
          <span>{isPrahariOn ? 'PRAHARI: ON' : 'PRAHARI: OFF'}</span>
        </button>
      </header>

      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mainTab === 'task'}
          onClick={() => setMainTab('task')}
        >
          Tasks {activeTaskEntries.length > 0 ? `(${activeTaskEntries.length})` : ''}
        </button>

        <button
          role="tab"
          aria-selected={mainTab === 'ledger'}
          onClick={() => setMainTab('ledger')}
        >
          Ledger {ledger.length > 0 ? `(${ledger.length})` : ''}
        </button>

        <button
          role="tab"
          aria-selected={mainTab === 'profile'}
          onClick={() => setMainTab('profile')}
        >
          👤 Profile
        </button>
      </nav>

      {openDiff !== null ? (
        <main className="pane">
          <DiffViewer
            traceId={openDiff}
            tabId={selectedTabId ?? undefined}
            onClose={() => setOpenDiff(null)}
          />
        </main>
      ) : mainTab === 'task' ? (
        <main className="pane">
          {/* Active Tasks Overview if multiple tasks exist */}
          {activeTaskEntries.length > 0 ? (
            <section className="card" style={{ width: '100%' }}>
              <h2>Running / Recent Tasks</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                {activeTaskEntries.map(([tId, tState]) => {
                  const tabInfo = availableTabs.find((t) => t.id === tId);
                  const isCurRunning = !['idle', 'done', 'error', 'blocked', 'interrupted'].includes(
                    tState.phase,
                  );
                  const isSelected = selectedTabId === tId;

                  return (
                    <div
                      key={tId}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        background: isSelected ? 'var(--bg)' : 'transparent',
                        border: isSelected ? '1px solid var(--accent-soft)' : '1px solid var(--border)',
                        cursor: 'pointer',
                      }}
                      onClick={() => setSelectedTabId(tId)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 600,
                              color: 'var(--text)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxWidth: '160px',
                            }}
                          >
                            {tabInfo?.title || `Tab #${tId}`}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span className={`badge ${tState.phase}`}>
                            {PHASE_LABEL[tState.phase]}
                          </span>
                          <button
                            style={{ padding: '2px 6px', fontSize: '10px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              void focusTab(tId);
                            }}
                            title="Focus Tab"
                          >
                            ↗
                          </button>
                          {isCurRunning ? (
                            <button
                              className="danger"
                              style={{ padding: '2px 6px', fontSize: '10px' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void stop(tId);
                              }}
                              title="Stop Task"
                            >
                              Stop
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {tState.goal ? (
                        <p className="muted" style={{ fontSize: '11px', margin: 0 }}>
                          <strong>Goal:</strong> {tState.goal}
                        </p>
                      ) : null}
                      <p className="muted" style={{ fontSize: '11px', margin: 0 }}>
                        {tState.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* Tab Selector for launching / inspecting */}
          <label className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>
                Target Tab <span style={{ color: 'var(--accent)', fontWeight: 700 }}>(Tab ID: #{selectedTabId ?? '—'})</span>
              </span>
              <button
                type="button"
                onClick={() => void refreshTabs()}
                style={{ padding: '2px 8px', fontSize: '11px' }}
              >
                ↻ Refresh
              </button>
            </div>
            <select
              value={selectedTabId ?? ''}
              onChange={(e) => setSelectedTabId(Number(e.target.value))}
              disabled={running}
              style={{
                width: '100%',
                padding: '7px 9px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'inherit',
                font: 'inherit',
              }}
            >
              {availableTabs.map((t) => {
                const s = states.get(t.id);
                const statusTag = s && s.phase !== 'idle' ? ` [${PHASE_LABEL[s.phase]}]` : '';
                return (
                  <option key={t.id} value={t.id}>
                    [Tab #{t.id}] {t.title} {statusTag}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="field">
            <span>What should PRAHARI do on this tab?</span>
            <textarea
              value={goal}
              rows={3}
              placeholder="Apply for the scheme using my saved profile"
              onChange={(e) => setGoal(e.target.value)}
              disabled={running}
            />
          </label>

          <label className="toggle" style={{ marginBottom: '10px' }}>
            <input
              type="checkbox"
              checked={userProfile.usePrefilledData !== false}
              onChange={(e) => {
                const updated = { ...userProfile, usePrefilledData: e.target.checked };
                void handleSaveProfile(updated);
              }}
              disabled={running}
            />
            <span>
              <strong>Use saved profile data for prefilling forms</strong>
              <em>Uncheck if you want PRAHARI to only fill values from your prompt or ask conversationally.</em>
            </span>
          </label>

          <div className="row">
            <button
              className="primary"
              onClick={() => void start()}
              disabled={running || busy}
            >
              Run
            </button>

            <button
              className="danger"
              onClick={() => void stop()}
              disabled={!running}
            >
              Stop
            </button>
          </div>

          <StatusCard state={currentState} />

          <label className="toggle">
            <input
              type="checkbox"
              checked={overlay}
              onChange={(e) => setOverlay(e.target.checked)}
            />
            <span>
              <strong>Show redactions on the page</strong>
              <em>Boxes every element KAVACH masked, live, as it happens.</em>
            </span>
          </label>

          <section className="card">
            <h2>Canary audit</h2>
            <p className="muted">
              Plants two sets of strings across 12 places a value can hide
              on this page, runs the real extraction pipeline over it, and
              searches the bytes that come out.
            </p>

            <button
              onClick={() => void runAudit()}
              disabled={busy || selectedTabId === null}
            >
              {busy ? 'Running…' : 'Run canary audit'}
            </button>

            {audit !== null ? <AuditResult audit={audit} /> : null}
          </section>

          <section className="card">
            <h2>Prove it</h2>
            <p className="muted">
              Asks the guard to inspect a payload that deliberately contains
              a valid Aadhaar number. A passing result means the guard
              refused to send it.
            </p>

            <button
              onClick={() => void runSelfTest()}
              disabled={busy || selectedTabId === null}
            >
              Run self-test
            </button>

            {selfTest !== null ? (
              <ul className="checks">
                {selfTest.checks.map((c) => (
                  <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
                    <span className="dot" aria-hidden="true" />
                    <div>
                      <strong>{c.name}</strong>
                      <em>{c.detail}</em>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <footer className="foot">
            <span>Server: {CONFIG.serverOrigin}</span>
            <span>Tier ceiling: {CONFIG.tierCeiling}</span>
          </footer>
        </main>
      ) : mainTab === 'ledger' ? (
        <LedgerView
          entries={ledger}
          onRefresh={() => void refreshLedger()}
          onInspect={setOpenDiff}
        />
      ) : (
        <ProfileView
          profile={userProfile}
          savedMsg={profileSavedMsg}
          onSave={handleSaveProfile}
        />
      )}
    </div>
  );
}

function StatusCard({
  state,
}: {
  state: AgentState | null;
}): React.JSX.Element {
  if (state === null) {
    return (
      <section className="card">
        No active task on this tab. Ready to start.
      </section>
    );
  }

  return (
    <section className={'card status ' + state.phase}>
      <div className="statusline">
        <span className="badge">{PHASE_LABEL[state.phase] || state.phase}</span>
        <span className="badge tier">Tier {state.tier}</span>
        {state.step > 0 ? (
          <span className="badge">Step {state.step}</span>
        ) : null}
        {state.tabId ? (
          <span className="badge">Tab #{state.tabId}</span>
        ) : null}
      </div>

      <p className="msg">{state.message}</p>

      <dl className="metrics">
        <div>
          <dt>Redacted</dt>
          <dd>{state.redactionCount}</dd>
        </div>
        <div>
          <dt>Sent this step</dt>
          <dd>{fmtBytes(state.lastBytes)}</dd>
        </div>
        <div>
          <dt>Sent total</dt>
          <dd>{fmtBytes(state.totalBytes)}</dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd>{state.blockedCount}</dd>
        </div>
      </dl>

      <p className="host">
        Inference host: {state.inferenceHost}
      </p>
    </section>
  );
}

function LedgerView({
  entries,
  onRefresh,
  onInspect,
}: {
  entries: LedgerEntry[];
  onRefresh: () => void;
  onInspect: (traceId: string) => void;
}): React.JSX.Element {
  return (
    <main className="pane ledger-pane">
      <h2>Privacy ledger (LEKHA)</h2>
      <div className="row">
        <button onClick={onRefresh}>↻ Refresh</button>
        <span className="grow" />
        <span className="muted">{entries.length} entries</span>
      </div>

      {entries.length === 0 ? (
        <p className="muted pad">No entries recorded for this tab yet.</p>
      ) : (
        <ul className="ledger-list">
          {entries.map((entry) => (
            <li key={entry.entry_hash} className="ledger-item">
              <div className="lhead">
                <span className={`outcome ${entry.outcome}`}>
                  {OUTCOME_LABEL[entry.outcome] ?? entry.outcome}
                </span>
                <span className="time">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                <span className="grow" />
                <button
                  className="diff-btn"
                  onClick={() => onInspect(entry.trace_id)}
                  aria-label="Inspect What the server saw"
                  title="Inspect What the server saw"
                >
                  Inspect Diff →
                </button>
              </div>
              <div className="lbody">
                <span className="mono hash" title={entry.entry_hash}>
                  {entry.entry_hash.slice(0, 16)}…
                </span>
                <span className="bytes">{fmtBytes(entry.byte_len)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function AuditResult({
  audit,
}: {
  audit: CanaryAuditResult;
}): React.JSX.Element {
  const passed = audit.leaked === 0 && audit.guardBlocked;

  return (
    <div className={`audit-box ${passed ? 'pass' : 'fail'}`}>
      <div className="audit-header">
        <strong>{passed ? '✓ PASSED' : '✗ FAILED'}</strong>
        <span>
          {audit.observed}/{audit.total} canaries observed · {audit.leaked} leaked
        </span>
      </div>
      <div className="audit-details">
        <div>Guard backstop: {audit.guardBlocked ? 'Passed' : 'Failed'}</div>
        <div>Required surfaces: {audit.requiredObserved}/{audit.requiredTotal}</div>
      </div>
    </div>
  );
}

function ProfileView({
  profile,
  savedMsg,
  onSave,
}: {
  profile: UserProfile;
  savedMsg: boolean;
  onSave: (p: UserProfile) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<UserProfile>(profile);

  useEffect(() => {
    setForm(profile);
  }, [profile]);

  return (
    <main className="pane">
      <section className="card" style={{ width: '100%' }}>
        <h2>👤 Saved Profile & Auto-Fill Details</h2>
        <p className="muted" style={{ fontSize: '12px', marginBottom: '14px' }}>
          PRAHARI uses these saved details to automatically fill web forms (Name, Enrollment/Roll No, Phone, Email, DOB) when the extension is ON.
        </p>

        {savedMsg ? (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'rgba(16, 185, 129, 0.2)',
              border: '1px solid #10b981',
              color: '#34d399',
              fontSize: '12px',
              fontWeight: 600,
              marginBottom: '12px',
            }}
          >
            ✓ Saved! PRAHARI will automatically use these details when filling form fields.
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label className="toggle" style={{ margin: '0 0 4px 0', padding: '10px', background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <input
              type="checkbox"
              checked={form.usePrefilledData !== false}
              onChange={(e) => setForm({ ...form, usePrefilledData: e.target.checked })}
            />
            <span>
              <strong>Automatically use prefilled profile data</strong>
              <em>When enabled, PRAHARI uses saved profile details for matching form fields. If disabled, it only fills what you type in prompt or asks conversationally.</em>
            </span>
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>Full Name</span>
            <input
              type="text"
              value={form.fullName}
              placeholder="e.g. Nitin Mali"
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>Enrollment / Roll Number</span>
            <input
              type="text"
              value={form.enrollmentNo}
              placeholder="e.g. 60 or ENR123456"
              onChange={(e) => setForm({ ...form, enrollmentNo: e.target.value })}
            />
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>Phone Number</span>
            <input
              type="text"
              value={form.phone}
              placeholder="e.g. 9876543210"
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>Email Address</span>
            <input
              type="email"
              value={form.email}
              placeholder="e.g. user@example.com"
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>

          <label className="field" style={{ margin: 0 }}>
            <span>Date of Birth</span>
            <input
              type="text"
              value={form.dob}
              placeholder="e.g. 31/05/2007 or 2007-05-31"
              onChange={(e) => setForm({ ...form, dob: e.target.value })}
            />
          </label>

          <button
            className="primary"
            style={{ marginTop: '6px' }}
            onClick={() => onSave(form)}
          >
            💾 Save Profile Details
          </button>
        </div>
      </section>
    </main>
  );
}
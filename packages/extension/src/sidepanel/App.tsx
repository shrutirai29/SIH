/**
 * The side panel.
 *
 * Its job is not decoration: PRD.md principle 4 is "show your work". Every privacy
 * claim the system makes has to be visible here, or it is just a slide.
 *
 * Present in the skeleton: live phase, byte counter, redaction counter, the ledger
 * with per-entry hashes, and a self-test that makes the guard block something on
 * demand. Still to come: the glass-box overlay (D15), the "what the server saw" diff
 * viewer (D16), and the live canary run (D17).
 */

import { useCallback, useEffect, useState } from 'react';
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
import { DiffViewer } from './DiffViewer.js';

type Tab = 'task' | 'ledger';

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
};

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  if (n < 1024) return String(n) + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

/**
 * An egress is recorded in two halves, so the ledger can distinguish "we handed these
 * bytes to the network" from "the network took them". A row still reading OFFERED is
 * not a bug: it means the request never resolved, which is the honest answer.
 */
const OUTCOME_LABEL: Record<LedgerEntry['outcome'], string> = {
  attempted: 'OFFERED',
  sent: 'SENT',
  failed: 'NOT SENT',
  blocked: 'BLOCKED',
};

export function App(): React.JSX.Element {
  const [state, setState] = useState<AgentState | null>(null);
  const [goal, setGoal] = useState('');
  const [tab, setTab] = useState<Tab>('task');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** trace_id of the step whose diff is open, if any (ticket D16). */
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(true);
  const [audit, setAudit] = useState<CanaryAuditResult | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: PANEL_PORT });
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as PanelPush | undefined;
      if (msg?.kind === 'STATE_UPDATE') setState(msg.state);
    });
    return () => {
      port.disconnect();
    };
  }, []);

  const refreshLedger = useCallback(async () => {
    const entries = (await browser.runtime.sendMessage({ kind: 'GET_LEDGER' })) as LedgerEntry[];
    setLedger([...entries].reverse());
  }, []);

  useEffect(() => {
    if (tab === 'ledger') void refreshLedger();
  }, [tab, state?.step, refreshLedger]);

  const start = async (): Promise<void> => {
    if (goal.trim().length === 0) return;
    setBusy(true);
    setSelfTest(null);
    await browser.runtime.sendMessage({ kind: 'START_TASK', goal: goal.trim() });
    setBusy(false);
  };

  const stop = async (): Promise<void> => {
    await browser.runtime.sendMessage({ kind: 'STOP_TASK' });
  };

  // The overlay is on by default: the point of the product is that you can see it
  // working, and a proof you have to switch on is a proof most users never see.
  useEffect(() => {
    void browser.runtime.sendMessage({ kind: 'SET_OVERLAY', enabled: overlay });
  }, [overlay]);

  const runAudit = async (): Promise<void> => {
    setBusy(true);
    setAudit(null);
    try {
      const result = (await browser.runtime.sendMessage({
        kind: 'RUN_CANARY_AUDIT',
      })) as CanaryAuditResult;
      setAudit(result);
    } finally {
      setBusy(false);
    }
  };

  const runSelfTest = async (): Promise<void> => {
    setBusy(true);
    const result = (await browser.runtime.sendMessage({ kind: 'SELF_TEST' })) as SelfTestResult;
    setSelfTest(result);
    setBusy(false);
    void refreshLedger();
  };

  const running = state !== null && !['idle', 'done', 'error', 'blocked'].includes(state.phase);

  return (
    <div className="app">
      <header className="head">
        <div className="brand">
          <span className="mark">प</span>
          <div>
            <h1>PRAHARI</h1>
            <p className="sub">The server sees the shape of your screen, never its secrets.</p>
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'task'} onClick={() => setTab('task')}>
          Task
        </button>
        <button role="tab" aria-selected={tab === 'ledger'} onClick={() => setTab('ledger')}>
          Ledger{ledger.length > 0 ? ' (' + String(ledger.length) + ')' : ''}
        </button>
      </nav>

      {openDiff !== null ? (
        <main className="pane">
          <DiffViewer traceId={openDiff} onClose={() => setOpenDiff(null)} />
        </main>
      ) : tab === 'task' ? (
        <main className="pane">
          <label className="field">
            <span>What should PRAHARI do on this page?</span>
            <textarea
              value={goal}
              rows={3}
              placeholder="Apply for the scheme using my saved profile"
              onChange={(e) => setGoal(e.target.value)}
              disabled={running}
            />
          </label>

          <div className="row">
            <button className="primary" onClick={() => void start()} disabled={running || busy}>
              Run
            </button>
            <button className="danger" onClick={() => void stop()} disabled={!running}>
              Stop
            </button>
          </div>

          <StatusCard state={state} />

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
              Plants two sets of strings across 12 places a value can hide on this page,
              runs the real extraction pipeline over it, and searches the bytes that
              come out. <strong>Leaked</strong> counts synthetic, checksum-valid Aadhaar
              numbers that survived — it must be zero.{' '}
              <strong>Read</strong> counts conspicuous markers the harvester saw, because
              a leak count alone can be passed by a reader that looks nowhere. The page
              is restored afterwards, and a task in flight keeps its vault.
            </p>
            <button onClick={() => void runAudit()} disabled={busy}>
              {busy ? 'Running…' : 'Run canary audit'}
            </button>
            {audit !== null ? <AuditResult audit={audit} /> : null}
          </section>

          <section className="card">
            <h2>Prove it</h2>
            <p className="muted">
              Asks the guard to inspect a payload that deliberately contains a valid
              Aadhaar number. A passing result means the guard refused to send it.
            </p>
            <button onClick={() => void runSelfTest()} disabled={busy}>
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
      ) : (
        <LedgerView
          entries={ledger}
          onRefresh={() => void refreshLedger()}
          onInspect={setOpenDiff}
        />
      )}
    </div>
  );
}

function StatusCard({ state }: { state: AgentState | null }): React.JSX.Element {
  if (state === null) return <section className="card">Connecting…</section>;

  return (
    <section className={'card status ' + state.phase}>
      <div className="statusline">
        <span className="badge">{PHASE_LABEL[state.phase]}</span>
        <span className="badge tier">Tier {state.tier}</span>
        {state.step > 0 ? <span className="badge">Step {state.step}</span> : null}
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
      <p className="host">Inference host: {state.inferenceHost}</p>
    </section>
  );
}

function LedgerView({
  entries,
  onRefresh,
  onInspect,
}: {
  entries: readonly LedgerEntry[];
  onRefresh: () => void;
  onInspect: (traceId: string) => void;
}): React.JSX.Element {
  return (
    <main className="pane">
      <section className="card">
        <h2>Privacy ledger (LEKHA)</h2>
        <p className="muted">
          Every egress attempt, including refused ones. Hashes and manifests only — the
          ledger never stores the payload it describes. A cleared payload is recorded
          twice: <strong>OFFERED</strong> before it meets the network, then{' '}
          <strong>SENT</strong> or <strong>NOT SENT</strong> once the request resolves.
          So the record says what left, and never claims a send that did not happen.
        </p>
        <button onClick={onRefresh}>Refresh</button>
      </section>

      {entries.length === 0 ? (
        <p className="muted pad">Nothing sent yet.</p>
      ) : (
        <ul className="ledger">
          {entries.map((e) => (
            <li key={e.entry_hash} className={e.outcome}>
              <div className="lrow">
                <span className="badge">{OUTCOME_LABEL[e.outcome]}</span>
                <span className="badge tier">T{e.tier}</span>
                <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="grow" />
                <span className="muted">{e.byte_len > 0 ? fmtBytes(e.byte_len) : '—'}</span>
              </div>
              <div className="lmeta">
                <code title="SHA-256 of the exact bytes offered to the network">
                  {e.payload_sha256 === '' ? 'not sent' : e.payload_sha256.slice(0, 16) + '…'}
                </code>
                <span className="muted">{e.origin_class}</span>
                <span className="grow" />
                <button className="link" onClick={() => onInspect(e.trace_id)}>
                  What the server saw →
                </button>
              </div>
              {e.blocked_reason !== undefined ? (
                <p className="reason">{e.blocked_reason}</p>
              ) : null}
              <p className="counts">
                {Object.entries(e.manifest.counts).length === 0
                  ? 'no redactions declared'
                  : Object.entries(e.manifest.counts)
                      .map(([k, v]) => k + '×' + String(v))
                      .join('  ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * The canary audit result (ticket D17).
 *
 * Three numbers, because no one of them is a privacy property on its own.
 *
 *  - **leaked** comes from running the real extractor over the planted page and
 *    searching the bytes it produced. It is a statement about the REDACTOR.
 *  - **observed** is how many canaries the harvester saw at all. `0 / 60 leaked` from
 *    a reader that inspects nothing is not a result, so this is shown with equal
 *    weight and every blind surface is named rather than averaged away.
 *  - **guardBlocked** is the independent backstop: the guard, asked separately,
 *    refused every payload carrying a canary.
 *
 * `observed` is reported against the surfaces we can honestly read TODAY. Canvas
 * pixels, CSS generated content and cross-frame text are planted for real and are
 * expected to come back unread — that gap is the report's job to show.
 */
function AuditResult({ audit }: { audit: CanaryAuditResult }): React.JSX.Element {
  const sawEverythingItShould = audit.requiredObserved === audit.requiredTotal;
  const clean = audit.leaked === 0 && audit.guardBlocked && sawEverythingItShould;
  const blind = audit.surfaces.filter((s) => s.observed === 0);

  return (
    <div className="audit">
      <div className="auditline">
        <span className={audit.leaked === 0 ? 'verdict ok' : 'verdict bad'}>
          {audit.leaked} / {audit.piiTotal} leaked
        </span>
        <span className={sawEverythingItShould ? 'verdict ok' : 'verdict bad'}>
          {audit.requiredObserved} / {audit.requiredTotal} read
        </span>
      </div>

      <p className="muted">
        {clean
          ? 'No canary reached the payload the extractor produced, the reader saw every ' +
            'surface it is expected to read, and the guard independently refused every ' +
            'payload carrying one.'
          : audit.leaked > 0
            ? 'A canary reached the payload the real pipeline produced. This is a leak.'
            : 'A surface the reader is expected to read was missed, so the leak count ' +
              'above does not yet mean what it says.'}
      </p>

      <ul className="surfaces">
        {audit.surfaces.map((s) => (
          <li key={s.surface} className={s.observed === 0 && s.required ? 'blind' : ''}>
            <code>{s.surface}</code>
            {s.required ? null : <span className="muted"> (not read yet)</span>}
            <span className="grow" />
            <span className="muted">
              {s.observed}/{s.planted} seen · {s.leaked} leaked
            </span>
          </li>
        ))}
      </ul>

      {blind.length > 0 ? (
        <p className="muted">
          {blind.length} surface{blind.length === 1 ? '' : 's'} not read by any detector
          yet. Nothing leaked from them because nothing looked — that is a gap, not a
          result. Canvas pixels need Tier 2 (C4–C9); CSS generated content and
          cross-frame text need B4/B5.
        </p>
      ) : null}
    </div>
  );
}

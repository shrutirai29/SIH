/**
 * "What the server saw" — the diff viewer (ticket D16).
 *
 * `SOLUTION-SPACE.md` calls this the strongest single feature in the project, and the
 * reason is not the UI. It is that every other privacy claim here is something we say,
 * and this one is something the audience can check. Left: what was on the screen, with
 * values masked. Right: the exact bytes that crossed the network, with the SHA-256
 * that the ledger independently recorded.
 *
 * The right-hand pane is byte-accurate on purpose. It is not a re-serialisation of the
 * SSG object, it is the decoded payload the guard hashed and `fetch` sent. Showing a
 * regenerated version would make this a claim about a claim.
 */

import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import type { DiffRow } from '@prahari/kavach';
import type { TransmissionView } from '../shared/messages.js';

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  if (n < 1024) return String(n) + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

/** Renders the payload with tokens highlighted, so the eye lands on them first. */
function HighlightedPayload({ payload }: { payload: string }): React.JSX.Element {
  // Pretty-print for reading, but say so — the transmitted bytes were compact.
  let pretty = payload;
  try {
    pretty = JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // Not JSON (or truncated); show it raw rather than nothing.
  }

  const parts = pretty.split(/(⟦[A-Z][A-Z0-9_]*_[0-9]+⟧)/g);
  return (
    <pre className="payload">
      {parts.map((part, i) =>
        /^⟦/.test(part) ? (
          <mark key={i}>{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </pre>
  );
}

function DiffRowItem({ row }: { row: DiffRow }): React.JSX.Element {
  return (
    <li className={row.reversible ? 'drow' : 'drow irreversible'}>
      <div className="dhead">
        <span className="badge cls">{row.cls}</span>
        <span className="muted">{row.label}</span>
        <span className="grow" />
        <span className="muted mono">{row.elementId}</span>
      </div>
      <div className="dbody">
        <div className="side before">
          <span className="sidelabel">On your screen</span>
          <code>{row.preview ?? 'never stored'}</code>
        </div>
        <span className="arrow" aria-hidden="true">→</span>
        <div className="side after">
          <span className="sidelabel">Sent to the server</span>
          <code className="token">{row.token}</code>
        </div>
      </div>
      <p className="dwhy">
        {row.sources.join(' + ')} · confidence {row.confidence}
        {row.reversible
          ? ' · this laptop can resolve it, only back into ' + row.elementId
          : ' · never stored, nothing can resolve it'}
      </p>
    </li>
  );
}

export function DiffViewer({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [view, setView] = useState<TransmissionView | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = (await browser.runtime.sendMessage({
        kind: 'GET_TRANSMISSION',
        traceId,
      })) as TransmissionView | null;
      if (!cancelled) setView(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  if (view === 'loading') {
    return (
      <section className="card">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  if (view === null) {
    return (
      <section className="card">
        <h2>What the server saw</h2>
        <p className="muted">
          The exact bytes for this step are no longer in memory. Only the last 20 steps
          of the current session are kept, and they are dropped when the task ends —
          the ledger stores hashes, never payloads.
        </p>
        <button onClick={onClose}>Back</button>
      </section>
    );
  }

  const redacted = view.diff.length;
  const irreversible = view.diff.filter((d) => !d.reversible).length;

  return (
    <div className="diff">
      <section className="card">
        <div className="dtitle">
          <h2>What the server saw</h2>
          <button onClick={onClose}>Back</button>
        </div>

        {view.blockedReason !== undefined ? (
          <p className="reason">
            This payload was never sent. The guard refused it ({view.blockedReason}).
          </p>
        ) : null}

        <dl className="metrics">
          <div>
            <dt>Redacted</dt>
            <dd>{redacted}</dd>
          </div>
          <div>
            <dt>Unrecoverable</dt>
            <dd>{irreversible}</dd>
          </div>
          <div>
            <dt>Bytes sent</dt>
            <dd>{fmtBytes(view.byteLen)}</dd>
          </div>
          <div>
            <dt>Step</dt>
            <dd>{view.step}</dd>
          </div>
        </dl>

        <p className="host">
          SHA-256 of the exact bytes:{' '}
          <code title={view.sha256}>
            {view.sha256 === '' ? 'nothing was sent' : view.sha256.slice(0, 32) + '…'}
          </code>
        </p>
      </section>

      {redacted === 0 ? (
        <p className="muted pad">Nothing sensitive was found on this screen.</p>
      ) : (
        <section className="card">
          <h2>Replaced before sending</h2>
          <ul className="dlist">
            {view.diff.map((row) => (
              <DiffRowItem key={row.elementId + row.token + row.cls} row={row} />
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>The exact bytes that left</h2>
        <p className="muted">
          Byte-for-byte what was handed to the network, indented here for reading. Every
          highlighted token is a reference the server cannot resolve.
        </p>
        {view.payload === '' ? (
          <p className="muted">No payload — this step was blocked before sending.</p>
        ) : (
          <HighlightedPayload payload={view.payload} />
        )}
      </section>
    </div>
  );
}

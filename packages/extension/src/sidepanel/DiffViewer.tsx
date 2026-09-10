/**
 * "What the server saw" — the diff viewer.
 *
 * Shows the redacted screen values alongside the exact payload retained
 * temporarily for the current session.
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

function HighlightedPayload({
  payload,
}: {
  payload: string;
}): React.JSX.Element {
  let pretty = payload;

  try {
    pretty = JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // If the payload is not JSON, show the exact text we received.
  }

  const parts = pretty.split(/(⟦[A-Z][A-Z0-9_]*_[0-9]+⟧)/g);

  return (
    <pre className="payload">
      {parts.map((part, index) =>
        /^(⟦[A-Z][A-Z0-9_]*_[0-9]+⟧)$/.test(part) ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </pre>
  );
}

function DiffRowItem({
  row,
}: {
  row: DiffRow;
}): React.JSX.Element {
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

        <span className="arrow" aria-hidden="true">
          →
        </span>

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
  tabId,
  onClose,
}: {
  traceId: string;
  tabId?: number | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const [view, setView] = useState<
    TransmissionView | null | 'loading'
  >('loading');

  useEffect(() => {
    let cancelled = false;

    const loadTransmission = async (): Promise<void> => {
      // The ledger can become visible slightly before the in-memory
      // transmission cache is readable. Retry for a short period.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (cancelled) return;

        try {
          const result = (await browser.runtime.sendMessage({
            kind: 'GET_TRANSMISSION',
            traceId,
            ...(tabId !== undefined ? { tabId } : {}),
          })) as TransmissionView | null;

          if (result !== null) {
            if (!cancelled) {
              setView(result);
            }
            return;
          }
        } catch {
          // The extension may still be updating state.
          // Retry instead of permanently showing "not available".
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 100);
        });
      }

      if (!cancelled) {
        setView(null);
      }
    };

    void loadTransmission();

    return () => {
      cancelled = true;
    };
  }, [traceId, tabId]);

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
          The exact bytes for this step are no longer in memory. Only the
          most recent steps of the current session are retained temporarily,
          while the ledger permanently stores hashes rather than payloads.
        </p>

        <button type="button" onClick={onClose}>
          Back
        </button>
      </section>
    );
  }

  const redacted = view.diff.length;

  const irreversible = view.diff.filter(
    (row) => !row.reversible,
  ).length;

  return (
    <div className="diff">
      <section className="card">
        <div className="dtitle">
          <h2>What the server saw</h2>

          <button type="button" onClick={onClose}>
            Back
          </button>
        </div>

        {view.blockedReason !== undefined ? (
          <p className="reason">
            This payload was never sent. The guard refused it (
            {view.blockedReason}).
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
            {view.sha256 === ''
              ? 'nothing was sent'
              : view.sha256.slice(0, 32) + '…'}
          </code>
        </p>
      </section>

      {redacted === 0 ? (
        <p className="muted pad">
          Nothing sensitive was found on this screen.
        </p>
      ) : (
        <section className="card">
          <h2>Replaced before sending</h2>

          <ul className="dlist">
            {view.diff.map((row) => (
              <DiffRowItem
                key={row.elementId + row.token + row.cls}
                row={row}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>The exact bytes that left</h2>

        <p className="muted">
          Byte-for-byte what was handed to the network, indented here for
          reading. Every highlighted token is a reference the server cannot
          resolve.
        </p>

        {view.payload === '' ? (
          <p className="muted">
            No payload — this step was blocked before sending.
          </p>
        ) : (
          <HighlightedPayload payload={view.payload} />
        )}
      </section>
    </div>
  );
}
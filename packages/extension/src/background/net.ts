/**
 * ===========================================================================
 *  THE ONLY MODULE IN PRAHARI PERMITTED TO TOUCH THE NETWORK.
 * ===========================================================================
 *
 * RULES.md P1/P2. Every other context is network-denied by manifest, and
 * `eslint-plugin-prahari/no-network-outside-net` fails CI on any `fetch`,
 * `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or remote dynamic
 * import outside this file.
 *
 * The single exported function takes an SSG, runs it through `guard()`, and sends
 * ONLY on `ok: true`. There is deliberately no `force` parameter, no bypass, and no
 * debug branch. If you are here to add one: the payload is wrong, not the guard
 * (RULES.md AI-3).
 */

import type { ActionPlan, SSG } from '@prahari/ssg';
import type { EgressGuard, GuardFailure } from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';

export type StepResult =
  | {
      readonly ok: true;
      readonly plan: ActionPlan;
      readonly bytesSent: number;
      readonly sha256: string;
      /** The exact bytes that were sent, for the diff viewer. Memory only. */
      readonly payload: string;
    }
  | { readonly ok: false; readonly kind: 'blocked'; readonly reason: GuardFailure; readonly detail: string }
  | { readonly ok: false; readonly kind: 'server'; readonly status: number; readonly detail: string }
  | { readonly ok: false; readonly kind: 'network'; readonly detail: string };

const STEP_TIMEOUT_MS = 45_000;

/**
 * Sends one agent step. The guard runs first and its verdict is final.
 *
 * The ledger record is written in two halves and this function owns the second. The
 * guard writes `attempted` before handing over the bytes — it has to, because a record
 * written afterwards could be lost to a crash, and an unlogged egress is the one thing
 * this system exists to make impossible. `confirm()` in the `finally` below then says
 * whether those bytes actually reached a server. Without it the ledger recorded `sent`
 * for every step whose request never left the machine.
 *
 * @param guard the KAVACH egress guard; injected so the caller cannot substitute a
 *              permissive stand-in without it being visible at the call site.
 */
export async function postStep(guard: EgressGuard, ssg: SSG): Promise<StepResult> {
  // ---- The choke point. Nothing below this line runs on a failed verdict. --------
  const verdict = await guard(ssg);
  if (!verdict.ok) {
    return { ok: false, kind: 'blocked', reason: verdict.reason, detail: verdict.detail };
  }

  const url = new URL('/v1/agent/step', CONFIG.serverOrigin).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, STEP_TIMEOUT_MS);

  // The guard has written an `attempted` row. Exactly one of `sent` or `failed` must
  // follow it, on every path out of this function, or the ledger is left saying "we
  // do not know whether this landed" about a request whose fate we do know.
  let fate: 'sent' | 'failed' = 'failed';
  let fault: string | undefined = 'no response';

  try {
    const response = await fetch(url, {
      method: 'POST',
      // The bytes the guard hashed are the bytes we send. Re-serialising here would
      // mean the ledger's SHA-256 attests to something other than what left.
      body: verdict.bytes as unknown as BodyInit,
      headers: {
        'content-type': 'application/json',
        'x-prahari-session': ssg.session_id,
        'x-prahari-trace': ssg.trace_id,
        'x-ssg-version': ssg.ssg_version,
      },
      signal: controller.signal,
      // No cookies, no credentials, ever. There is no account to authenticate.
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });

    if (!response.ok) {
      // The bytes DID leave the machine — the server read them and objected. That is
      // an egress, and recording it as anything else would understate what was
      // disclosed. `blocked_reason` carries the status so the row is still legible.
      fate = 'sent';
      fault = 'server HTTP ' + String(response.status);
      const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      return {
        ok: false,
        kind: 'server',
        status: response.status,
        detail: body.error ?? response.statusText,
      };
    }

    fate = 'sent';
    fault = undefined;
    const plan = (await response.json()) as ActionPlan;
    return {
      ok: true,
      plan,
      bytesSent: verdict.bytes.byteLength,
      sha256: verdict.sha256,
      // Decoded from the same bytes the guard hashed, so the viewer shows exactly what
      // left rather than a re-serialisation of it.
      payload: new TextDecoder().decode(verdict.bytes),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    fault = aborted ? 'timeout' : 'unreachable';
    return {
      ok: false,
      kind: 'network',
      detail: aborted ? 'request timed out' : 'server unreachable',
    };
  } finally {
    clearTimeout(timer);
    // In `finally`, so a throw between the guard and here still resolves the record.
    await guard.confirm({
      ssg,
      sha256: verdict.sha256,
      byteLen: verdict.bytes.byteLength,
      outcome: fate,
      ...(fault !== undefined ? { detail: fault } : {}),
    });
  }
}

/** Liveness probe for the side panel's status line. */
export async function checkHealth(): Promise<{ up: boolean; detail: string }> {
  try {
    const url = new URL('/v1/health', CONFIG.serverOrigin).toString();
    const res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return { up: false, detail: 'HTTP ' + String(res.status) };
    const body = (await res.json()) as { model?: string };
    return { up: true, detail: body.model ?? 'ok' };
  } catch {
    return { up: false, detail: 'unreachable' };
  }
}

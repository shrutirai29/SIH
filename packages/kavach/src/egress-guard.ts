/**
 * THE CHOKE POINT.
 *
 * Nothing reaches the network except through here. `background/net.ts` is the only
 * module allowed to call `fetch`, and it may only send on `ok: true`. There is no
 * bypass parameter, no `force` flag, no debug branch (RULES.md P1, P2).
 *
 * The checks are deliberately redundant with the redactor. The point is that a bug in
 * KAVACH must be caught by something that is not KAVACH.
 *
 * Status: checks 1,2,3,4,6,7,8 are implemented. Check 5 (image verification) requires
 * the Tier-2 pixel pipeline that does not exist yet, so it FAILS CLOSED on any payload
 * carrying an image - see IMAGE_UNVERIFIED below. Ticket D12 completes it.
 */

// PRECOMPILED validator, not a runtime-compiled one. Ajv's normal path builds the
// validator with `new Function`, which the extension's CSP forbids — it throws
// EvalError in MV3 and takes the whole guard down with it. `pnpm gen:contract` does
// the compilation at build time from the same schema. See ADR-0003.
import { validateSsg } from '@prahari/ssg/validators';
import {
  findTokens,
  hasMalformedToken,
  type RedactionManifest,
  type SSG,
} from '@prahari/ssg';
import { containsPii, scanText, shannonEntropy } from './detectors/l1-regex/index.js';
import { Ledger, sha256Hex } from './ledger.js';

export type GuardFailure =
  | 'SCHEMA_INVALID'
  | 'PII_DETECTED'
  | 'CANARY_LEAK'
  | 'HIGH_ENTROPY_BLOB'
  | 'IMAGE_UNVERIFIED'
  | 'MANIFEST_MISMATCH'
  | 'HOST_NOT_ALLOWED'
  | 'MALFORMED_TOKEN'
  | 'LEDGER_WRITE_FAILED'
  /**
   * A check itself crashed. Fail-closed applies to the guard's own bugs: if we cannot
   * complete the checks, we have not passed them (RULES.md P6).
   */
  | 'GUARD_ERROR';

export type GuardVerdict =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly sha256: string }
  | { readonly ok: false; readonly reason: GuardFailure; readonly detail: string };

export interface GuardDeps {
  /** The single permitted destination. Compared by origin, not by prefix. */
  readonly serverOrigin: string;
  readonly ledger: Ledger;
  /** Active canary strings for this session. Empty outside canary mode. */
  readonly canaries?: readonly string[];
  /** Allows http://localhost during development; false in any shipped build. */
  readonly allowInsecureLocalhost?: boolean;
}

/** Strings above this length are entropy-swept for accidentally serialised blobs. */
const ENTROPY_MIN_LEN = 32;
const ENTROPY_THRESHOLD = 4.0;
const BLOBBY_RE = /^[A-Za-z0-9+/=_-]+$/;

/** Walks every string value in a JSON-ish structure, yielding path and value. */
function* walkStrings(node: unknown, path = '$'): Generator<{ path: string; value: string }> {
  if (typeof node === 'string') {
    yield { path, value: node };
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* walkStrings(node[i], path + '[' + String(i) + ']');
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* walkStrings(v, path + '.' + k);
  }
}

function manifestTotal(m: RedactionManifest): number {
  return Object.values(m.counts).reduce((a, b) => a + b, 0);
}

/**
 * Sentinel emitted for classes that are never vaulted and never reversible
 * (RULES.md P4). It stands for "something was here", not for a recoverable value, so
 * several distinct credentials collapse onto this one token.
 */
const IRREVERSIBLE_SENTINEL = 'REDACTED';

/**
 * Check 6: the manifest must actually describe the payload.
 *
 * Two directions, both of which have caught real bugs in this class of system:
 *  - a token whose class the manifest never declares means a redaction happened that
 *    no detector took responsibility for (or a token was forged into page text);
 *  - more distinct tokens than declared items means the manifest under-reports, which
 *    is exactly what a compromised or buggy redactor would produce.
 *
 * ## This check is only as good as where the manifest comes from
 *
 * It compares the payload against the manifest, so it can only detect a forgery when
 * the manifest is derived from something the page cannot influence. For a while it was
 * not: `countDistinctTokens` built the manifest by scanning the payload for tokens, so
 * a `⟦AADHAAR_1⟧` typed into a hostile page's own text was harvested, counted, and
 * then compared against itself. The check was structurally incapable of failing on the
 * exact case its second bullet describes.
 *
 * The manifest is now derived from the tokens the VAULT actually minted, which is
 * ground truth no page can reach. A forged token is then either an undeclared class or
 * one distinct token too many, and one of the two directions below fires.
 */
function checkManifestDescribesPayload(
  ssg: SSG,
  serialised: string,
): { ok: true } | { ok: false; detail: string } {
  const tokens = findTokens(serialised);
  const distinct = new Set(tokens.map((t) => t.token));
  const declaredClasses = new Set(Object.keys(ssg.redaction_manifest.counts));

  for (const t of tokens) {
    if (t.cls === IRREVERSIBLE_SENTINEL) continue;
    if (!declaredClasses.has(t.cls)) {
      return { ok: false, detail: 'payload carries an undeclared ' + t.cls + ' token' };
    }
  }

  const declaredTotal = manifestTotal(ssg.redaction_manifest);
  if (distinct.size > declaredTotal) {
    return {
      ok: false,
      detail:
        'payload carries ' + String(distinct.size) + ' distinct tokens but the manifest declares ' +
        String(declaredTotal),
    };
  }

  return { ok: true };
}

/**
 * What the network layer reports back once a cleared payload has met the wire.
 *
 * The guard cannot observe this itself - it hands over bytes and loses sight of them -
 * so closing the ledger's second half is the caller's obligation. `net.ts` does it in
 * a `finally`, so every attempt is resolved even on an exception.
 */
export interface EgressOutcome {
  readonly ssg: SSG;
  readonly sha256: string;
  readonly byteLen: number;
  /** `sent`: the server accepted the bytes. `failed`: they never got there. */
  readonly outcome: 'sent' | 'failed';
  /** Fault class for a failure. Never a message: those can carry page text (P9). */
  readonly detail?: string;
}

export interface EgressGuard {
  /**
   * Returns the bytes to send, or the reason nothing will be sent.
   *
   * Never throws. A guard that throws is worse than one that refuses: the caller sees
   * an unhandled rejection, the loop stalls with no explanation, and the user cannot
   * tell a crash from a hang. Every exit is a verdict.
   */
  (ssg: SSG, image?: Blob): Promise<GuardVerdict>;
  /**
   * Closes the ledger record the guard opened. Call exactly once per `ok: true`
   * verdict, whatever the request did.
   */
  confirm(result: EgressOutcome): Promise<void>;
}

export function createEgressGuard(deps: GuardDeps): EgressGuard {
  const canaries = deps.canaries ?? [];

  const guard = async function guard(ssg: SSG, image?: Blob): Promise<GuardVerdict> {
    try {
      return await runChecks(ssg, image);
    } catch (err) {
      // P9: name only. A thrown error can carry page text in its message.
      const name = err instanceof Error ? err.name : 'Error';
      try {
        await deps.ledger.append({
          session_id: ssg.session_id,
          trace_id: ssg.trace_id,
          tier: ssg.tier,
          purpose: ssg.purpose,
          origin_class: ssg.page.origin_class,
          payload_sha256: '',
          byte_len: 0,
          manifest: ssg.redaction_manifest,
          outcome: 'blocked',
          blocked_reason: 'GUARD_ERROR',
        });
      } catch {
        // Nothing more we can do; the verdict below still refuses the send.
      }
      return { ok: false, reason: 'GUARD_ERROR', detail: 'a guard check crashed: ' + name };
    }
  };

  /**
   * The second half of the pair opened by check 8.
   *
   * A failed write here leaves an `attempted` row with no resolution, which reads
   * correctly as "we do not know whether this one landed" - the honest state. It must
   * never throw into the caller's error path, because that would turn a bookkeeping
   * problem into a step failure.
   */
  guard.confirm = async function confirm(result: EgressOutcome): Promise<void> {
    try {
      await deps.ledger.append({
        session_id: result.ssg.session_id,
        trace_id: result.ssg.trace_id,
        tier: result.ssg.tier,
        purpose: result.ssg.purpose,
        origin_class: result.ssg.page.origin_class,
        payload_sha256: result.sha256,
        byte_len: result.byteLen,
        manifest: result.ssg.redaction_manifest,
        outcome: result.outcome,
        ...(result.detail !== undefined ? { blocked_reason: result.detail } : {}),
      });
    } catch {
      // See above: an unresolved `attempted` row is the correct reading of this.
    }
  };

  return guard;

  async function runChecks(ssg: SSG, image?: Blob): Promise<GuardVerdict> {
    const fail = async (reason: GuardFailure, detail: string): Promise<GuardVerdict> => {
      try {
        await deps.ledger.append({
          session_id: ssg.session_id,
          trace_id: ssg.trace_id,
          tier: ssg.tier,
          purpose: ssg.purpose,
          origin_class: ssg.page.origin_class,
          payload_sha256: '',
          byte_len: 0,
          manifest: ssg.redaction_manifest,
          outcome: 'blocked',
          blocked_reason: reason,
        });
      } catch {
        // A failed ledger write must not turn a block into a send.
      }
      return { ok: false, reason, detail };
    };

    // --- 1. SCHEMA -------------------------------------------------------------
    if (!validateSsg(ssg)) {
      const first = validateSsg.errors?.[0];
      // P9: report the schema path only. Never the offending value.
      const where = first?.instancePath ?? '$';
      const what = first?.message ?? 'invalid';
      return fail('SCHEMA_INVALID', where + ' ' + what);
    }

    const serialised = JSON.stringify(ssg);

    // --- 2. TEXT SWEEP ---------------------------------------------------------
    // Re-run the detector pack over the SERIALISED bytes. If KAVACH reintroduced a
    // value after redaction, this is what catches it.
    if (containsPii(serialised)) {
      const hit = scanText(serialised)[0];
      return fail('PII_DETECTED', 'class=' + (hit?.cls ?? 'unknown'));
    }

    // --- 2b. TOKEN WELL-FORMEDNESS --------------------------------------------
    // A half-written token means the redactor's offset arithmetic is wrong, which is
    // the same bug class as a leak.
    if (hasMalformedToken(serialised)) {
      return fail('MALFORMED_TOKEN', 'unbalanced or malformed placeholder in payload');
    }

    // --- 3. CANARY -------------------------------------------------------------
    for (const canary of canaries) {
      if (canary.length > 0 && serialised.includes(canary)) {
        return fail('CANARY_LEAK', 'a planted canary string reached the payload');
      }
    }

    // --- 4. ENTROPY ------------------------------------------------------------
    for (const { path, value } of walkStrings(ssg)) {
      if (value.length < ENTROPY_MIN_LEN) continue;
      if (!BLOBBY_RE.test(value)) continue;
      if (shannonEntropy(value) > ENTROPY_THRESHOLD) {
        return fail('HIGH_ENTROPY_BLOB', path + ' looks like an encoded blob');
      }
    }

    // --- 5. IMAGE VERIFY -------------------------------------------------------
    // P6: "not implemented" is not the same as "passed". Tier 2 cannot ship until the
    // decode-and-sample check exists (ticket D12).
    if (image !== undefined) {
      return fail('IMAGE_UNVERIFIED', 'tier-2 image verification is not implemented yet');
    }
    if (ssg.attachment !== undefined) {
      return fail('IMAGE_UNVERIFIED', 'payload declares an attachment but none was verified');
    }

    // --- 6. MANIFEST -----------------------------------------------------------
    const manifestCheck = checkManifestDescribesPayload(ssg, serialised);
    if (!manifestCheck.ok) {
      return fail('MANIFEST_MISMATCH', manifestCheck.detail);
    }

    // --- 7. ALLOWLIST ----------------------------------------------------------
    let target: URL;
    try {
      target = new URL(deps.serverOrigin);
    } catch {
      return fail('HOST_NOT_ALLOWED', 'configured server origin is not a URL');
    }
    const isLocalhost = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
    const secure =
      target.protocol === 'https:' || (isLocalhost && deps.allowInsecureLocalhost === true);
    if (!secure) {
      return fail('HOST_NOT_ALLOWED', 'server origin must be https');
    }

    // --- 8. LEDGER -------------------------------------------------------------
    // Recorded as `attempted`, not `sent`: at this instant nothing has left. The
    // record goes down FIRST because a crash between here and the wire must not be
    // able to produce an unlogged egress - and it is closed by `confirm()` once the
    // request resolves, so the ledger never claims a send that did not happen.
    const bytes = new TextEncoder().encode(serialised);
    const digest = await sha256Hex(bytes);
    try {
      await deps.ledger.append({
        session_id: ssg.session_id,
        trace_id: ssg.trace_id,
        tier: ssg.tier,
        purpose: ssg.purpose,
        origin_class: ssg.page.origin_class,
        payload_sha256: digest,
        byte_len: bytes.byteLength,
        manifest: ssg.redaction_manifest,
        outcome: 'attempted',
      });
    } catch (err) {
      // No ledger record means no send. An unlogged egress is exactly what this
      // system exists to make impossible.
      return {
        ok: false,
        reason: 'LEDGER_WRITE_FAILED',
        detail: err instanceof Error ? err.name : 'unknown',
      };
    }

    return { ok: true, bytes, sha256: digest };
  }
}


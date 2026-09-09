/**
 * The agent state machine.
 *
 * observe -> sanitize (in the content script) -> guard -> send -> plan -> act -> verify
 *
 * The loop owns termination: a hard step cap, a kill switch, and a stop on the first
 * blocked egress. It never retries a blocked send - a block means the payload was
 * wrong, and sending it again would only be wrong again.
 */

import type { Action, ActionPlan, HistoryItem, RedactedText, SSG } from '@prahari/ssg';
import {
  Ledger,
  MemoryLedgerStore,
  createEgressGuard,
  type EgressGuard,
} from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';
import type {
  ActionResult,
  AgentState,
  CanaryAuditResult,
  ExtractResult,
} from '../shared/messages.js';
import {
  browser,
  bytesToBase64,
  captureActiveTab,
  createInferenceHost,
  redactCapturedTab,
  type CapturedTab,
  type InferenceHost,
  type RedactedScreenshot,
} from '../platform/index.js';
import { ExtensionLedgerStore } from './ledger-store.js';
import { TransmissionBuffer } from './transmissions.js';
import { postStep } from './net.js';

function freshState(): AgentState {
  return {
    phase: 'idle',
    goal: '',
    step: 0,
    tier: 1,
    message: 'Idle.',
    lastBytes: 0,
    totalBytes: 0,
    redactionCount: 0,
    blockedCount: 0,
    inferenceHost: 'not started',
  };
}

/** Ephemeral per-task session id. Rotates every task so tokens are unlinkable across them. */
function newSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'eph_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AgentLoopDeps {
  readonly guard?: EgressGuard;
  readonly host?: InferenceHost;
  readonly store?: ExtensionLedgerStore;
}

export class AgentLoop {
  #state: AgentState = freshState();
  #abort: AbortController | null = null;
  #listeners = new Set<(s: AgentState) => void>();

  readonly ledger: Ledger;
  /** Exact bytes of recent steps, memory only, for the diff viewer (ticket D16). */
  readonly transmissions = new TransmissionBuffer();
  readonly #store: ExtensionLedgerStore;
  readonly #guard: EgressGuard;
  readonly #host: InferenceHost;

  constructor(deps: AgentLoopDeps = {}) {
    this.#store = deps.store ?? new ExtensionLedgerStore();
    this.ledger = new Ledger(this.#store);
    this.#host = deps.host ?? createInferenceHost();
    this.#guard =
      deps.guard ??
      createEgressGuard({
        serverOrigin: CONFIG.serverOrigin,
        ledger: this.ledger,
        allowInsecureLocalhost: CONFIG.allowInsecureLocalhost,
      });
  }

  get state(): AgentState {
    return this.#state;
  }

  subscribe(fn: (s: AgentState) => void): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => this.#listeners.delete(fn);
  }

  #patch(patch: Partial<AgentState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn(this.#state);
  }

  stop(reason = 'Stopped by user.'): void {
    this.#abort?.abort();
    this.#abort = null;
    // ARCHITECTURE.md sec 10: the kept artefacts are dropped at session end.
    this.transmissions.clear();
    this.#patch({ phase: 'idle', message: reason });
  }

  async start(goal: string): Promise<AgentState> {
    if (this.#abort !== null) this.stop('Restarting.');

    const controller = new AbortController();
    this.#abort = controller;
    const sessionId = newSessionId();

    this.#patch({
      ...freshState(),
      phase: 'observing',
      goal,
      message: 'Starting.',
    });

    // Prove the inference boundary is alive before the first step. In the skeleton it
    // only pings; from Phase 2 it is where the models live.
    try {
      const pong = await this.#host.ping();
      this.#patch({ inferenceHost: pong.host });
    } catch (err) {
      this.#patch({ inferenceHost: 'unavailable: ' + errName(err) });
    }

    void this.#run(goal, sessionId, controller.signal);
    return this.#state;
  }

  async #run(goal: string, sessionId: string, signal: AbortSignal): Promise<void> {
    let needVisual = false;
    const history: HistoryItem[] = [];

    for (let step = 0; step < CONFIG.maxSteps; step++) {
      if (signal.aborted) return;

      const traceId = 't_' + String(step);

      // ---- observe + sanitize (both happen inside the tab) ----------------------
      this.#patch({ phase: 'observing', step, message: 'Reading the screen…' });
      let extract: ExtractResult;
      try {
        extract = await this.#extract(goal, step, traceId, sessionId);
      } catch (err) {
        this.#patch({ phase: 'error', message: 'Could not read the page: ' + errName(err) });
        return;
      }
      if (signal.aborted) return;

      if (history.length > 0) {
        extract.ssg.history = [...history];
      }

      let imageBlob: Blob | undefined = undefined;
      if (needVisual) {
        needVisual = false;
        this.#patch({ tier: 2, message: 'Capturing and redacting visual evidence requested by planner…' });

        let captured: CapturedTab | null = null;
        try {
          captured = await captureActiveTab();
        } catch {
          captured = null;
        }

        if (!captured) {
          this.#patch({
            phase: 'error',
            message: 'Visual capture failed when requested by planner. Stopping.',
          });
          return;
        }

        let redacted: RedactedScreenshot | null = null;
        try {
          redacted = await redactCapturedTab(captured, extract.ssg, extract.diff);
        } catch {
          redacted = null;
        }

        if (!redacted) {
          this.#patch({
            phase: 'error',
            message: 'Visual redaction failed when requested by planner. Stopping.',
          });
          return;
        }

        try {
          const arrayBuffer = await redacted.blob.arrayBuffer();
          const base64Data = bytesToBase64(new Uint8Array(arrayBuffer));
          extract.ssg.tier = 2;
          extract.ssg.attachment = {
            screenshot: {
              format: 'png',
              w: redacted.width,
              h: redacted.height,
              sha256: redacted.sha256,
              redacted: true,
              data: base64Data,
            },
          };
          imageBlob = redacted.blob;
        } catch {
          this.#patch({
            phase: 'error',
            message: 'Constructing visual attachment failed. Stopping.',
          });
          return;
        }
      } else {
        this.#patch({ tier: 1 });
      }

      const redactions = Object.values(extract.redactions).reduce((a, b) => a + b, 0);
      this.#patch({
        phase: 'sanitizing',
        redactionCount: this.#state.redactionCount + redactions,
        message: 'Redacted ' + String(redactions) + ' item(s) on this screen.',
      });

      // ---- guard + send --------------------------------------------------------
      this.#patch({ phase: 'sending', message: 'Checking the payload before it leaves…' });
      const result = await postStep(this.#guard, extract.ssg, imageBlob);
      if (signal.aborted) return;

      if (!result.ok) {
        if (result.kind === 'blocked') {
          // A refused step is the most interesting thing the viewer can show, so it
          // gets a row too - with no payload, because none was produced.
          this.transmissions.record({
            traceId,
            step,
            sentAt: Date.now(),
            payload: '',
            sha256: '',
            byteLen: 0,
            diff: extract.diff,
            blockedReason: result.reason,
          });
          // The system refusing its own request is a feature, not an error. Surface it
          // loudly and stop; a retry would send the same bad payload.
          this.#patch({
            phase: 'blocked',
            blockedCount: this.#state.blockedCount + 1,
            message:
              'Blocked our own request (' + result.reason + '). Nothing was sent. ' + result.detail,
          });
          return;
        }
        if (result.kind === 'server' && result.status === 422) {
          this.#patch({
            phase: 'blocked',
            blockedCount: this.#state.blockedCount + 1,
            message: 'The server rejected the payload as unredacted. Stopping and entering strict mode.',
          });
          return;
        }
        this.#patch({
          phase: 'error',
          message: 'Server problem: ' + ('detail' in result ? result.detail : 'unknown'),
        });
        return;
      }

      this.transmissions.record({
        traceId,
        step,
        sentAt: Date.now(),
        payload: result.payload,
        sha256: result.sha256,
        byteLen: result.bytesSent,
        diff: extract.diff,
      });

      this.#patch({
        phase: 'thinking',
        lastBytes: result.bytesSent,
        totalBytes: this.#state.totalBytes + result.bytesSent,
        message: 'Sent ' + fmtBytes(result.bytesSent) + '. Waiting for a plan…',
      });

      // ---- act -----------------------------------------------------------------
      const plan: ActionPlan = result.plan;
      needVisual = plan.need_visual === true;
      const outcome = await this.#actAll(plan.actions, step, history, signal);
      if (signal.aborted) return;

      if (plan.done || plan.actions.some((a) => a.op === 'done')) {
        this.#patch({ phase: 'done', message: 'Task complete.' });
        return;
      }
      if (outcome === 'error') {
        this.#patch({ phase: 'error', message: 'An action failed. Stopping.' });
        return;
      }
      if (outcome === 'blocked') {
        // Already surfaced with its reason by #actAll. Stop rather than retry: a
        // refused action refused for a reason, and repeating it would repeat the ask.
        return;
      }

      await sleep(CONFIG.settleMs);
    }

    this.#patch({ phase: 'done', message: 'Step limit reached.' });
  }

  async #actAll(
    actions: readonly Action[],
    step: number,
    history: HistoryItem[],
    signal: AbortSignal,
  ): Promise<ActionResult['outcome']> {
    let last: ActionResult['outcome'] = 'no_change';
    for (const action of actions) {
      if (signal.aborted) return 'blocked';
      if (action.op === 'done' || action.op === 'fail') {
        history.push({
          step,
          action: action.op,
          outcome: 'advanced',
        });
        if (history.length > 20) history.shift();
        return 'advanced';
      }

      this.#patch({ phase: 'acting', message: 'Executing: ' + action.op });
      const res = await this.#execute(action);
      last = res.outcome;

      const target =
        'target' in action && typeof (action as { target?: string }).target === 'string'
          ? (action as { target: string }).target.slice(0, 16)
          : undefined;

      history.push({
        step,
        action: action.op,
        ...(target !== undefined ? { target } : {}),
        outcome: res.outcome,
      });
      if (history.length > 20) history.shift();

      // A refused action is the system defending itself; the user must see WHY, and
      // a sink-binding refusal is the single most important thing this UI can say.
      if (res.outcome === 'blocked') {
        this.#patch({
          phase: 'blocked',
          blockedCount: this.#state.blockedCount + 1,
          message: res.detail ?? 'Action refused.',
        });
        return 'blocked';
      }
      if (res.outcome === 'error') return 'error';
    }
    return last;
  }

  async #activeTabId(): Promise<number> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const id = tab?.id;
    if (id === undefined) throw new Error('no active tab');
    return id;
  }

  async #extract(goal: string, step: number, traceId: string, sessionId: string): Promise<ExtractResult> {
    const tabId = await this.#activeTabId();
    const reply = (await browser.tabs.sendMessage(tabId, {
      kind: 'EXTRACT_SCREEN',
      goal,
      step,
      traceId,
      sessionId,
    })) as ExtractResult | undefined;
    if (reply === undefined) throw new Error('content script did not reply');
    return reply;
  }

  async #execute(action: Action): Promise<ActionResult> {
    try {
      const tabId = await this.#activeTabId();
      const reply = (await browser.tabs.sendMessage(tabId, {
        kind: 'EXECUTE_ACTION',
        action,
      })) as ActionResult | undefined;
      return reply ?? { outcome: 'error', detail: 'no reply' };
    } catch (err) {
      return { outcome: 'error', detail: errName(err) };
    }
  }

  /** Turns the on-page overlay on or off in the active tab (ticket D15). */
  async setOverlay(on: boolean): Promise<{ ok: boolean }> {
    try {
      const tabId = await this.#activeTabId();
      await browser.tabs.sendMessage(tabId, { kind: 'SET_OVERLAY', enabled: on });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * The live canary audit (ticket D17).
   *
   * Two independent questions, and the audit is only meaningful because it asks both.
   *
   *  1. **Did the redactor leak?** The tab plants canaries across twelve surfaces, runs
   *     the REAL extractor over the real page, and searches the bytes it produced.
   *     That number — `report.leaked` — is the headline, and it is a statement about
   *     the component the headline names.
   *
   *  2. **Would the guard have caught it anyway?** Answered here, by offering a
   *     canary-bearing payload to a real egress guard. This is the backstop, not the
   *     measurement: scoring the audit on this alone (as an earlier version did) meant
   *     a clean 0/60 could be reported with the redactor deleted entirely, because the
   *     probes were synthetic payloads the pipeline had never touched.
   *
   * And `observed` remains the third leg: a leak count alone can be passed by a reader
   * that looks nowhere.
   */
  async canaryAudit(): Promise<CanaryAuditResult> {
    const tabId = await this.#activeTabId();
    const report = (await browser.tabs.sendMessage(tabId, {
      kind: 'RUN_CANARY_AUDIT',
    })) as {
      total: number;
      observed: number;
      leaked: number;
      piiTotal: number;
      requiredTotal: number;
      requiredObserved: number;
      surfaces: {
        surface: string;
        planted: number;
        observed: number;
        leaked: number;
        required: boolean;
      }[];
      values: string[];
      payload: string;
      ranAt: number;
    };

    // A throwaway ledger: an audit is not an egress and must not pollute the record
    // the user is asked to trust.
    const guard = createEgressGuard({
      serverOrigin: CONFIG.serverOrigin,
      ledger: new Ledger(new MemoryLedgerStore()),
      canaries: report.values,
      allowInsecureLocalhost: CONFIG.allowInsecureLocalhost,
    });

    // The backstop. Each canary is planted into a payload and offered to the guard;
    // every one must come back refused.
    let blocked = 0;
    for (const value of report.values) {
      const verdict = await guard(canaryProbe(value));
      if (!verdict.ok && verdict.reason === 'CANARY_LEAK') blocked++;
    }

    return {
      total: report.total,
      observed: report.observed,
      leaked: report.leaked,
      piiTotal: report.piiTotal,
      requiredTotal: report.requiredTotal,
      requiredObserved: report.requiredObserved,
      guardBlocked: blocked === report.values.length,
      surfaces: report.surfaces,
      ranAt: report.ranAt,
    };
  }

  /** Used by the side panel's "Run self-test" button. */
  async selfTest(): Promise<{ passed: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    const pong = await this.#host.ping().catch((e: unknown) => ({ ok: false, host: errName(e) }));
    checks.push({
      name: 'Inference host reachable',
      ok: pong.ok,
      detail: pong.host,
    });

    const chainBad = await this.ledger.verify();
    checks.push({
      name: 'Privacy ledger hash chain intact',
      ok: chainBad === null,
      detail: chainBad === null ? 'chain verified' : 'broken at entry ' + String(chainBad),
    });

    // A deliberately dirty payload must be refused. This is the guard proving itself.
    const dirty = dirtyProbe();
    const verdict = await this.#guard(dirty);
    checks.push({
      name: 'Egress guard refuses a payload containing PII',
      ok: !verdict.ok,
      detail: verdict.ok ? 'GUARD FAILED TO BLOCK' : 'blocked: ' + verdict.reason,
    });

    return { passed: checks.every((c) => c.ok), checks };
  }
}

/**
 * A synthetic payload carrying a checksum-valid Aadhaar. Never derived from the user's
 * screen - it exists only so the guard can be exercised on demand.
 */
function dirtyProbe(): SSG {
  return {
    ssg_version: '1.0',
    session_id: 'eph_deadbeefcafe',
    trace_id: 't_0',
    step: 0,
    tier: 1,
    purpose: 'self-test',
    goal: 'self test' as RedactedText,
    viewport: { w: 800, h: 600, dpr: 1, scroll_y: 0 },
    page: { origin_class: 'test', page_type: 'form', sensitivity: 'private' },
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        bbox: [0, 0, 10, 10],
        // Verhoeff-valid, so the L1 pack must catch it.
        value: '234567890124' as RedactedText,
        actionable: ['type'],
      },
    ],
    redaction_manifest: {
      policy_id: 'self-test',
      counts: {},
      methods: {},
      detectors: [],
      coverage_confidence: 1,
    },
  };
}

/**
 * A minimal, otherwise-clean SSG carrying one canary. Offered to the guard so the
 * audit's number comes from the guard itself refusing to send it.
 */
function canaryProbe(canary: string): SSG {
  return {
    ssg_version: '1.0',
    // Must be valid hex: an invalid id fails the SCHEMA check first, and the canary
    // check never runs. The audit would then report a truthful 0/60 that proved
    // nothing whatsoever - caught by the browser test asserting guardBlocked.
    session_id: 'eph_ca4a2b3c4d5e',
    trace_id: 't_0',
    step: 0,
    tier: 1,
    purpose: 'canary-audit',
    goal: 'canary audit' as RedactedText,
    viewport: { w: 800, h: 600, dpr: 1, scroll_y: 0 },
    page: { origin_class: 'audit', page_type: 'form', sensitivity: 'private' },
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        bbox: [0, 0, 10, 10],
        value: canary as RedactedText,
        actionable: ['type'],
      },
    ],
    redaction_manifest: {
      policy_id: 'canary-audit',
      counts: {},
      methods: {},
      detectors: [],
      coverage_confidence: 1,
    },
  };
}

function errName(e: unknown): string {
  // P9: never surface a message; a thrown error can carry page text.
  return e instanceof Error ? e.name : 'Error';
}

function fmtBytes(n: number): string {
  return n < 1024 ? String(n) + ' B' : (n / 1024).toFixed(1) + ' KB';
}

/**
 * The agent state machine.
 *
 * observe -> sanitize (in the content script) -> guard -> send -> plan -> act -> verify
 *
 * The loop owns termination: a hard step cap, a kill switch, and a stop on the first
 * blocked egress. It never retries a blocked send - a block means the payload was
 * wrong, and sending it again would only be wrong again.
 */

import type { Action, ActionPlan, RedactedText, SSG } from '@prahari/ssg';
import {
  Ledger,
  MemoryLedgerStore,
  createEgressGuard,
  type EgressGuard,
} from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';
import type {
  ActionResult,
  AgentQuestion,
  AgentState,
  CanaryAuditResult,
  ExtractResult,
} from '../shared/messages.js';
import { browser, createInferenceHost, type InferenceHost } from '../platform/index.js';
import { ExtensionLedgerStore } from './ledger-store.js';
import { TransmissionBuffer } from './transmissions.js';
import { postStep } from './net.js';
import type { UserProfile } from '../shared/profile.js';

function freshState(tabId: number, taskId: string): AgentState {
  return {
    phase: 'idle',
    taskId,
    tabId,
    goal: '',
    step: 0,
    tier: 1,
    message: 'Idle.',
    lastBytes: 0,
    totalBytes: 0,
    redactionCount: 0,
    blockedCount: 0,
    inferenceHost: 'not started',
    pendingQuestion: undefined,
  };
}

/** Ephemeral per-task session id. Rotates every task so tokens are unlinkable across them. */
function newSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'eph_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AgentLoop {
  #state: AgentState;
  #abort: AbortController | null = null;
  #listeners = new Set<(s: AgentState) => void>();

  /** The browser tab this loop is permanently bound to. */
  readonly #tabId: number;

  /** Unique identifier for this task instance (rotates every new AgentLoop). */
  readonly taskId: string;

  readonly ledger: Ledger;
  /** Exact bytes of recent steps, memory only, for the diff viewer (ticket D16). */
  readonly transmissions = new TransmissionBuffer();
  readonly #store = new ExtensionLedgerStore();
  readonly #guard: EgressGuard;
  readonly #host: InferenceHost;

  /** Whether the agent is allowed to use saved profile data to fill known fields. */
  #autoFillPrefilled = true;

  /** The saved user profile (passed in at task start). */
  #userProfile: UserProfile | null = null;

  /**
   * Accumulated answers from the user for the current task.
   * key = fieldKey, value = user-supplied string.
   */
  #userAnswers: Map<string, string> = new Map();

  /**
   * Resolve function injected by #run when it is paused waiting for a user answer.
   * Cleared immediately after the answer arrives.
   */
  #answerResolve: ((value: string) => void) | null = null;

  /** Number of form fields filled in the current task. */
  #filledFieldsCount = 0;

  /** Whether the user has been given the form review lag time before submission. */
  #hasReviewedForm = false;

  constructor(tabId: number) {
    this.#tabId = tabId;
    this.taskId = newSessionId();
    this.#state = freshState(this.#tabId, this.taskId);
    this.ledger = new Ledger(this.#store);
    this.#host = createInferenceHost();
    this.#guard = createEgressGuard({
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
    // Reject any pending question so the loop does not hang.
    if (this.#answerResolve) {
      this.#answerResolve('__STOPPED__');
      this.#answerResolve = null;
    }
    // ARCHITECTURE.md sec 10: the kept artefacts are dropped at session end.
    this.transmissions.clear();
    this.#patch({ phase: 'idle', message: reason, pendingQuestion: undefined });
  }

  interrupt(reason = 'Page navigated away — task stopped.'): void {
    this.#abort?.abort();
    this.#abort = null;
    if (this.#answerResolve) {
      this.#answerResolve('__STOPPED__');
      this.#answerResolve = null;
    }
    this.transmissions.clear();
    this.#patch({ phase: 'interrupted', message: reason, pendingQuestion: undefined });
  }

  async start(
    goal: string,
    opts?: {
      autoFillPrefilled?: boolean;
      userProfile?: UserProfile;
      savedFields?: Record<string, string>;
    },
  ): Promise<AgentState> {
    if (this.#abort !== null) this.stop('Restarting.');

    this.#autoFillPrefilled = opts?.autoFillPrefilled ?? true;
    this.#userProfile = opts?.userProfile ?? null;
    this.#userAnswers = new Map();
    if (opts?.savedFields) {
      for (const [key, val] of Object.entries(opts.savedFields)) {
        if (typeof val === 'string' && val.length > 0) {
          this.#userAnswers.set(key, val);
        }
      }
    }
    this.#filledFieldsCount = 0;
    this.#hasReviewedForm = false;

    // Start a fresh session. Remove temporary payload data
    // from the previous session.
    this.transmissions.clear();

    const controller = new AbortController();
    this.#abort = controller;
    const sessionId = newSessionId();

    this.#patch({
      ...freshState(this.#tabId, this.taskId),
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
    for (let step = 0; step < CONFIG.maxSteps; step++) {
      if (signal.aborted) return;

      const traceId = 't_' + String(step);
      // ---- observe + sanitize (both happen inside the tab) ----------------------
      this.#patch({ phase: 'observing', step, message: 'Reading the screen…' });
      let extract: ExtractResult;
      try {
        extract = await this.#extract(goal, step, traceId, sessionId);
} catch (err) {
  console.error('PRAHARI extraction failed:', err);

  const details =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);

  this.#patch({
    phase: 'error',
    message: 'Could not read the page: ' + details,
  });

  return;
}
      if (signal.aborted) return;

      const redactions = Object.values(extract.redactions).reduce((a, b) => a + b, 0);
      this.#patch({
        phase: 'sanitizing',
        redactionCount: this.#state.redactionCount + redactions,
        message: 'Redacted ' + String(redactions) + ' item(s) on this screen.',
      });

      // ---- guard + send --------------------------------------------------------
      this.#patch({ phase: 'sending', message: 'Checking the payload before it leaves…' });
      const result = await postStep(this.#guard, extract.ssg);
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
      const rawPlan = result.plan as unknown as Record<string, unknown>;
      const plan: ActionPlan = (rawPlan && typeof rawPlan === 'object' && 'plan' in rawPlan && rawPlan.plan
        ? (rawPlan.plan as ActionPlan)
        : (result.plan as ActionPlan)) || { plan_id: 'p_0', trace_id: traceId, actions: [], done: true };
      const actions: readonly Action[] = Array.isArray(plan?.actions) ? plan.actions : [];

      const actRes = await this.#actAll(actions, plan, step, signal);
      if (signal.aborted) return;

      if (plan.done || actions.some((a) => a.op === 'done')) {
        const doneAction = actions.find((a) => a.op === 'done');

        this.#patch({
          phase: 'done',
          message:
            doneAction &&
            doneAction.op === 'done' &&
            doneAction.summary
              ? doneAction.summary
              : (plan as unknown as { reasoning?: string }).reasoning || 'Task complete.',
        });

        return;
      }

      const failAction = actions.find((a) => a.op === 'fail');
      if (failAction && failAction.op === 'fail') {
        this.#patch({
          phase: 'error',
          message: failAction.reason || (plan as unknown as { reasoning?: string }).reasoning || 'Task could not be completed on this page.',
        });
        return;
      }

      if (actRes.outcome === 'error') {
        this.#patch({
          phase: 'error',
          message: actRes.detail || (plan as unknown as { reasoning?: string }).reasoning || 'An action failed. Stopping.',
        });
        return;
      }

      if (actRes.outcome === 'blocked') {
        // Already surfaced with its reason by #actAll. Stop rather than retry: a
        // refused action refused for a reason, and repeating it would repeat the ask.
        return;
      }

      if (actions.length === 0) {
        this.#patch({
          phase: 'done',
          message: (plan as unknown as { reasoning?: string }).reasoning || 'No action needed on this screen.',
        });
        return;
      }

      await sleep(CONFIG.settleMs);
    }

    this.#patch({ phase: 'done', message: 'Step limit reached.' });
  }

  async #actAll(
    actions: readonly Action[],
    plan: ActionPlan,
    step: number,
    signal: AbortSignal,
  ): Promise<{ outcome: ActionResult['outcome']; detail?: string | undefined }> {
    let last: ActionResult['outcome'] = 'no_change';
    let lastDetail: string | undefined;
    for (const action of actions) {
      if (signal.aborted) return { outcome: 'blocked' };
      if (action.op === 'done' || action.op === 'fail') return { outcome: 'advanced' };

      // ── ask_user: pause and wait for side panel answer ──────────────
      if ((action as { op: string }).op === 'ask_user') {
        const askAction = action as unknown as {
          op: 'ask_user';
          target?: Action extends { target: infer T } ? T : string;
          field_key: string;
          question: string;
          options?: string[];
        };

        const q: AgentQuestion = {
          fieldKey: askAction.field_key,
          question: askAction.question,
          options: askAction.options,
        };

        // Surface question to the side panel via state update.
        this.#patch({
          phase: 'asking',
          message: askAction.question,
          pendingQuestion: q,
        });

        // Block until the user supplies an answer (or the task is stopped).
        const answer = await new Promise<string>((resolve) => {
          this.#answerResolve = resolve;
        });

        this.#answerResolve = null;

        if (answer === '__STOPPED__' || signal.aborted) return { outcome: 'blocked' };

        // If target element is known, type the user's answer into it immediately
        if (askAction.target && answer) {
          this.#filledFieldsCount++;
          this.#patch({ phase: 'acting', message: `Filling: ${answer}`, pendingQuestion: undefined });
          await this.#execute({
            op: 'type',
            target: askAction.target,
            value: answer,
            clear_first: true,
            risk: 'safe',
          } as Action);
        } else {
          this.#patch({ phase: 'acting', message: 'Got answer, continuing…', pendingQuestion: undefined });
        }

        // Store the answer so subsequent steps can reference it.
        this.#userAnswers.set(askAction.field_key, answer);
        last = 'advanced';
        continue;
      }

      if (action.op === 'type') {
        this.#filledFieldsCount++;
      }

      // ── Review Lag Time: If clicking a submit/search/action button after fields are filled ──
      const isSubmitAction =
        action.op === 'click' &&
        !this.#hasReviewedForm &&
        (this.#filledFieldsCount > 0 || step >= 1) &&
        (
          Boolean(action.reason && /submit|search|apply|proceed|book|confirm|send|inquiry/i.test(action.reason)) ||
          Boolean((plan as unknown as { reasoning?: string }).reasoning && /submit|search|apply|proceed|book|confirm|send|populated|fields populated/i.test((plan as unknown as { reasoning?: string }).reasoning || '')) ||
          this.#filledFieldsCount > 0
        );

      if (isSubmitAction) {
        this.#hasReviewedForm = true;
        const reviewSeconds = 7;
        for (let remaining = reviewSeconds; remaining > 0; remaining--) {
          if (signal.aborted) return { outcome: 'blocked' };
          this.#patch({
            phase: 'acting',
            message: `Form filled! Please review the details. Submitting in ${remaining}s… (Click Stop to keep without submitting)`,
          });
          await sleep(1000);
          if (signal.aborted) return { outcome: 'blocked' };
        }
      }

      this.#patch({ phase: 'acting', message: 'Executing: ' + action.op });
      const res = await this.#execute(action);
      last = res.outcome;
      lastDetail = res.detail;

      // A refused action is the system defending itself; the user must see WHY, and
      // a sink-binding refusal is the single most important thing this UI can say.
      if (res.outcome === 'blocked') {
        this.#patch({
          phase: 'blocked',
          blockedCount: this.#state.blockedCount + 1,
          message: res.detail ?? 'Action refused.',
        });
        return { outcome: 'blocked', detail: res.detail };
      }
      if (res.outcome === 'error') return { outcome: 'error', detail: res.detail };
    }
    return { outcome: last, detail: lastDetail };
  }


  async #ensureContentScript(): Promise<void> {
    try {
      if (browser.scripting?.executeScript) {
        await browser.scripting.executeScript({
          target: { tabId: this.#tabId },
          files: ['content.js'],
        });
        await sleep(350);
      }
    } catch (err) {
      console.warn('PRAHARI: Failed to dynamically inject content.js into tab', this.#tabId, err);
    }
  }

  async #extract(goal: string, step: number, traceId: string, sessionId: string): Promise<ExtractResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reply = (await browser.tabs.sendMessage(this.#tabId, {
          kind: 'EXTRACT_SCREEN',
          goal,
          step,
          traceId,
          sessionId,
          // Context forwarded to the server planner via SSG extension fields.
          autoFillPrefilled: this.#autoFillPrefilled,
          userProfile: this.#userProfile ?? undefined,
          userAnswers: Object.fromEntries(this.#userAnswers),
        })) as ExtractResult | undefined;
        if (reply !== undefined) return reply;
      } catch (err) {
        if (attempt === 0) {
          // Content script not active on this tab yet (e.g. extension reloaded or page pre-existed). Inject now.
          await this.#ensureContentScript();
        } else {
          await sleep(200);
        }
      }
    }
    throw new Error('Could not connect to webpage content script. Please refresh (F5) the target tab.');
  }

  async #execute(action: Action): Promise<ActionResult> {
    try {
      const reply = (await browser.tabs.sendMessage(this.#tabId, {
        kind: 'EXECUTE_ACTION',
        action,
      })) as ActionResult | undefined;
      return reply ?? { outcome: 'error', detail: 'no reply' };
    } catch (err) {
      return { outcome: 'error', detail: errName(err) };
    }
  }

  /**
   * Called by the background message handler when the side panel sends an
   * ANSWER_QUESTION message. Resolves the pending Promise and unblocks #run.
   */
  provideAnswer(fieldKey: string, value: string): void {
    if (this.#answerResolve) {
      // Also persist so subsequent steps can reference it.
      this.#userAnswers.set(fieldKey, value);
      this.#answerResolve(value);
      this.#answerResolve = null;
    }
  }

  /** Turns the on-page overlay on or off in this loop's tab (ticket D15). */
  async setOverlay(on: boolean): Promise<{ ok: boolean }> {
    try {
      await browser.tabs.sendMessage(this.#tabId, { kind: 'SET_OVERLAY', enabled: on });
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
    const report = (await browser.tabs.sendMessage(this.#tabId, {
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

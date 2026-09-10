/**
 * The agent state machine.
 *
 * observe -> sanitize (in the content script) -> guard -> send -> plan -> act -> verify
 *
 * The loop owns termination: a hard step cap, a kill switch, and a stop on the first
 * blocked egress. It never retries a blocked send - a block means the payload was
 * wrong, and sending it again would only be wrong again.
 */

import type { Action, ActionOp, ActionPlan, HistoryItem, Outcome, RedactedText, Risk, SSG } from '@prahari/ssg';
import {
  Ledger,
  MemoryLedgerStore,
  createEgressGuard,
  normalizeReasonCode,
  type EgressGuard,
  type SanitizedReasonCode,
} from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';
import type {
  ActionResult,
  AgentQuestion,
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
import type { UserProfile } from '../shared/profile.js';

function freshState(tabId = 0, taskId = newSessionId()): AgentState {
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

export interface AgentLoopDeps {
  readonly guard?: EgressGuard;
  readonly host?: InferenceHost;
  readonly store?: ExtensionLedgerStore;
  readonly tabId?: number;
  readonly taskId?: string;
}

export class AgentLoop {
  #tabId: number | undefined;
  taskId: string;
  #state: AgentState;
  #abort: AbortController | null = null;
  #listeners = new Set<(s: AgentState) => void>();

  readonly ledger: Ledger;
  /** Exact bytes of recent steps, memory only, for the diff viewer (ticket D16). */
  readonly transmissions = new TransmissionBuffer();
  readonly #store: ExtensionLedgerStore;
  readonly #guard: EgressGuard;
  readonly #host: InferenceHost;

  #autoFillPrefilled = false;
  #userProfile: UserProfile | null = null;
  #userAnswers: Map<string, string> = new Map();
  #answerResolve: ((value: string) => void) | null = null;

  constructor(depsOrTabId: AgentLoopDeps | number = {}) {
    const deps: AgentLoopDeps = typeof depsOrTabId === 'number' ? { tabId: depsOrTabId } : depsOrTabId;
    this.#tabId = deps.tabId;
    this.taskId = deps.taskId ?? newSessionId();
    this.#state = freshState(this.#tabId ?? 0, this.taskId);
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

  /**
   * Called when a user provides an answer to a pending question.
   */
  provideAnswer(fieldKey: string, value: string): void {
    this.#userAnswers.set(fieldKey, value);
    if (this.#answerResolve) {
      this.#answerResolve(value);
      this.#answerResolve = null;
    }
  }

  async start(
    goal: string,
    opts?: {
      autoFillPrefilled?: boolean | undefined;
      userProfile?: UserProfile | undefined;
      savedFields?: Record<string, string> | undefined;
    },
  ): Promise<AgentState> {
    if (this.#abort !== null) this.stop('Restarting.');

    // Start a fresh session. Remove temporary payload data from the previous session.
    this.transmissions.clear();

    const controller = new AbortController();
    this.#abort = controller;
    const sessionId = newSessionId();
    this.taskId = sessionId;

    this.#autoFillPrefilled = opts?.autoFillPrefilled ?? false;
    this.#userProfile = opts?.userProfile ?? null;
    this.#userAnswers.clear();
    if (opts?.savedFields) {
      for (const [k, v] of Object.entries(opts.savedFields)) {
        this.#userAnswers.set(k, v);
      }
    }

    this.#patch({
      ...freshState(this.#tabId ?? 0, this.taskId),
      phase: 'observing',
      goal,
      message: 'Starting.',
    });

    // Prove the inference boundary is alive before the first step.
    try {
      const pong = await this.#host.ping();
      this.#patch({ inferenceHost: pong.host });
    } catch (err) {
      this.#patch({ inferenceHost: 'unavailable: ' + errName(err) });
    }

    void this.#run(goal, sessionId, controller.signal);
    return this.#state;
  }

  #isTerminal(): boolean {
    const p = this.#state.phase;
    return p === 'done' || p === 'blocked' || p === 'error';
  }

  async #run(goal: string, sessionId: string, signal: AbortSignal): Promise<void> {
    let needVisual = false;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_RECOVERIES = 3;
    const history: HistoryItem[] = [];

    for (let step = 0; step < CONFIG.maxSteps; step++) {
      if (signal.aborted || this.#isTerminal()) return;

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
      if (signal.aborted || this.#isTerminal()) return;

      // ---- history integration from LEKHA (durable, privacy-safe context for MANTRI)
      try {
        const sanitizedHistory = await this.ledger.getSanitizedHistory({
          sessionId,
          maxItems: 20,
        });
        const actionHistory = sanitizedHistory.filter(
          (item) => item.event_type === 'action' || item.event_type === 'lifecycle',
        );
        if (actionHistory.length > 0) {
          extract.ssg.history = actionHistory.map((item) => ({
            step: item.step ?? 0,
            action:
              item.action_op ??
              (item.reason_code ? String(item.reason_code).toLowerCase() : item.event_type),
            ...(item.target_id !== undefined ? { target: item.target_id } : {}),
            outcome: item.action_outcome ?? 'no_change',
            ...(item.reason_code !== undefined ? { reason_code: item.reason_code } : {}),
          }));
        } else if (history.length > 0) {
          extract.ssg.history = [...history];
        }
      } catch (err) {
        console.warn('LEKHA getSanitizedHistory failed, falling back to in-memory history:', err);
        if (history.length > 0) {
          extract.ssg.history = [...history];
        }
      }

      let imageBlob: Blob | undefined = undefined;
      if (needVisual) {
        needVisual = false;
        this.#patch({ tier: 2, message: 'Capturing and redacting visual evidence requested by planner…' });

        const tabId = await this.#activeTabId();
        let targetWindowId: number | undefined;
        try {
          const tab = await browser.tabs.get(tabId);
          targetWindowId = tab?.windowId;
        } catch {
          targetWindowId = undefined;
        }

        let captured: CapturedTab | null = null;
        try {
          captured = await captureActiveTab(targetWindowId !== undefined ? { windowId: targetWindowId } : {});
        } catch (err) {
          console.warn('[PRAHARI Capture] captureActiveTab failed:', err);
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
      if (signal.aborted || this.#isTerminal()) return;

      if (!result.ok) {
        if (result.kind === 'blocked') {
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
      const outcome = await this.#actAll(plan.actions, step, history, signal, sessionId, traceId);
      if (signal.aborted || this.#isTerminal()) return;

      if (outcome === 'blocked') {
        // Security block or awaiting user — stop immediately, do NOT retry
        return;
      }

      if (plan.done || plan.actions.some((a) => a.op === 'done')) {
        const doneAction = plan.actions.find((a) => a.op === 'done');
        await this.#logLifecycle({
          sessionId,
          traceId,
          step,
          reason_code: 'TASK_COMPLETE',
        });
        this.#patch({
          phase: 'done',
          message:
            doneAction &&
            doneAction.op === 'done' &&
            doneAction.summary
              ? doneAction.summary
              : 'Task complete.',
        });

        return;
      }

      if (outcome === 'error' || outcome === 'no_change') {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_RECOVERIES) {
          await this.#logLifecycle({
            sessionId,
            traceId,
            step,
            reason_code: 'RECOVERY_EXHAUSTED',
          });
          this.#patch({
            phase: 'error',
            message: 'Exceeded recovery budget (' + String(MAX_CONSECUTIVE_RECOVERIES) + ' consecutive failures). Stopping.',
          });
          return;
        }
        await this.#logLifecycle({
          sessionId,
          traceId,
          step,
          reason_code: 'RECOVERY_STARTED',
        });
        this.#patch({
          message: 'Action had ' + outcome + ', replanning (recovery attempt ' + String(consecutiveFailures) + '/' + String(MAX_CONSECUTIVE_RECOVERIES) + ')…',
        });
      } else if (outcome === 'advanced') {
        consecutiveFailures = 0;
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
    sessionId: string,
    traceId: string,
  ): Promise<ActionResult['outcome']> {
    let last: ActionResult['outcome'] = 'no_change';
    for (const action of actions) {
      if (signal.aborted || this.#isTerminal()) return 'blocked';

      if (action.op === 'done') {
        history.push({
          step,
          action: 'done',
          outcome: 'advanced',
          reason_code: 'TASK_COMPLETE',
        });
        if (history.length > 20) history.shift();
        await this.#logAction({
          sessionId,
          traceId,
          step,
          action_op: 'done',
          action_outcome: 'advanced',
          reason_code: 'TASK_COMPLETE',
        });
        return 'advanced';
      }

      if (action.op === 'fail') {
        const reason_code =
          normalizeReasonCode(action.reason, undefined, 'error', 'action') ?? 'TASK_FAILED';
        history.push({
          step,
          action: 'fail',
          outcome: 'error',
          reason_code,
        });
        if (history.length > 20) history.shift();
        await this.#logAction({
          sessionId,
          traceId,
          step,
          action_op: 'fail',
          action_outcome: 'error',
          reason_code,
        });
        this.#patch({
          phase: 'error',
          message: action.reason ?? 'Agent reported task failure.',
        });
        return 'error';
      }

      if (action.op === 'ask_user') {
        history.push({
          step,
          action: 'ask_user',
          outcome: 'no_change',
          reason_code: 'USER_DECLINED',
        });
        if (history.length > 20) history.shift();
        await this.#logAction({
          sessionId,
          traceId,
          step,
          action_op: 'ask_user',
          action_outcome: 'no_change',
          reason_code: 'USER_DECLINED',
        });

        const q: AgentQuestion = {
          fieldKey: (action as { field_key?: string }).field_key ?? 'user_input',
          question: action.question,
          options: (action as { options?: string[] }).options,
        };
        this.#patch({
          phase: 'blocked',
          message: 'Awaiting user response: ' + action.question,
          pendingQuestion: q,
        });
        return 'blocked';
      }

      this.#patch({ phase: 'acting', message: 'Executing: ' + action.op });
      const res = await this.#execute(action);
      last = res.outcome;

      const target =
        'target' in action && typeof (action as { target?: string }).target === 'string'
          ? (action as { target: string }).target.slice(0, 16)
          : undefined;

      const risk: Risk = 'risk' in action && action.risk !== undefined ? action.risk : 'safe';
      const reason_code = normalizeReasonCode(undefined, res.detail, res.outcome, 'action');

      history.push({
        step,
        action: action.op,
        ...(target !== undefined ? { target } : {}),
        outcome: res.outcome,
        ...(reason_code !== undefined ? { reason_code } : {}),
      });
      if (history.length > 20) history.shift();

      await this.#logAction({
        sessionId,
        traceId,
        step,
        action_op: action.op,
        ...(target !== undefined ? { target_id: target } : {}),
        action_outcome: res.outcome,
        ...(risk !== undefined ? { risk } : {}),
        ...(reason_code !== undefined ? { reason_code } : {}),
      });

      // A refused action is the system defending itself; the user must see WHY
      if (res.outcome === 'blocked') {
        this.#patch({
          phase: 'blocked',
          blockedCount: this.#state.blockedCount + 1,
          message: res.detail ?? 'Action refused.',
        });
        return 'blocked';
      }

      // If an intermediate action in a multi-action plan fails or yields no change,
      // abort remaining actions from this plan to allow re-observation and bounded recovery.
      if (res.outcome === 'error') {
        return 'error';
      }

      if (res.outcome === 'no_change') {
        return 'no_change';
      }
    }
    return last;
  }

  async #activeTabId(): Promise<number> {
    const isNonWeb = (t?: { id?: number; url?: string }): boolean => {
      if (!t || t.id === undefined) return true;
      if (!t.url) return false;
      const u = t.url;
      return (
        u.startsWith('chrome-extension://') ||
        u.startsWith('moz-extension://') ||
        u.startsWith('chrome://') ||
        u.startsWith('about:') ||
        u.startsWith('edge://')
      );
    };

    if (this.#tabId !== undefined && this.#tabId > 0) {
      try {
        const tab = await browser.tabs.get(this.#tabId);
        if (!isNonWeb(tab)) return this.#tabId;
      } catch {
        // ignore
      }
    }

    // 1. Current window active tab (fast path for normal extension usage)
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined && !isNonWeb(tab)) {
        this.#tabId = tab.id;
        return tab.id;
      }
    } catch {
      // ignore
    }

    // 2. Active tab across any window that is a real webpage
    try {
      const activeTabs = await browser.tabs.query({ active: true });
      const webActive = activeTabs.find((t) => !isNonWeb(t));
      if (webActive?.id !== undefined) {
        this.#tabId = webActive.id;
        return webActive.id;
      }
    } catch {
      // ignore
    }

    // 3. Fallback: search all tabs across windows for any web tab
    try {
      const allTabs = await browser.tabs.query({});
      const webTab = allTabs.find((t) => !isNonWeb(t));
      if (webTab?.id !== undefined) {
        this.#tabId = webTab.id;
        return webTab.id;
      }
    } catch {
      // ignore
    }

    // 4. Ultimate fallback: active tab in current window even if URL not matched
    try {
      const [fallback] = await browser.tabs.query({ active: true, currentWindow: true });
      if (fallback?.id !== undefined) return fallback.id;
    } catch {
      // ignore
    }

    throw new Error('no active tab');
  }

  async #extract(goal: string, step: number, traceId: string, sessionId: string): Promise<ExtractResult> {
    const tabId = await this.#activeTabId();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reply = (await browser.tabs.sendMessage(tabId, {
          kind: 'EXTRACT_SCREEN',
          goal,
          step,
          traceId,
          sessionId,
          autoFillPrefilled: this.#autoFillPrefilled,
          userProfile: this.#userProfile ?? undefined,
          userAnswers: Object.fromEntries(this.#userAnswers),
        })) as ExtractResult | undefined;
        if (reply !== undefined) return reply;
      } catch {
        if (attempt === 0 && browser.scripting?.executeScript) {
          try {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ['content.js'],
            });
            await sleep(200);
          } catch {
            // ignore
          }
        } else {
          await sleep(100);
        }
      }
    }
    throw new Error('content script did not reply');
  }

  async #execute(action: Action): Promise<ActionResult> {
    if (this.#isTerminal()) {
      return { outcome: 'error', detail: 'Agent is in terminal state' };
    }
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

  async #logAction(input: {
    sessionId: string;
    traceId: string;
    step: number;
    action_op: ActionOp;
    target_id?: string;
    action_outcome: Outcome;
    risk?: Risk;
    reason_code?: SanitizedReasonCode;
  }): Promise<void> {
    try {
      await this.ledger.append({
        event_type: 'action',
        session_id: input.sessionId,
        trace_id: input.traceId,
        step: input.step,
        action_op: input.action_op,
        ...(input.target_id !== undefined ? { target_id: input.target_id } : {}),
        action_outcome: input.action_outcome,
        ...(input.risk !== undefined ? { risk: input.risk } : {}),
        ...(input.reason_code !== undefined ? { reason_code: input.reason_code } : {}),
      });
    } catch (err) {
      console.warn('LEKHA action logging failed:', err);
    }
  }

  async #logLifecycle(input: {
    sessionId: string;
    traceId: string;
    step: number;
    reason_code: SanitizedReasonCode;
  }): Promise<void> {
    try {
      await this.ledger.append({
        event_type: 'lifecycle',
        session_id: input.sessionId,
        trace_id: input.traceId,
        step: input.step,
        reason_code: input.reason_code,
      });
    } catch (err) {
      console.warn('LEKHA lifecycle logging failed:', err);
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
   */
  async canaryAudit(): Promise<CanaryAuditResult> {
    const tabId = await this.#activeTabId();
    let report: {
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
    } | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        report = (await browser.tabs.sendMessage(tabId, {
          kind: 'RUN_CANARY_AUDIT',
        })) as typeof report;
        if (report !== undefined) break;
      } catch {
        if (attempt === 0 && browser.scripting?.executeScript) {
          try {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ['content.js'],
            });
            await sleep(200);
          } catch {
            // ignore
          }
        } else {
          await sleep(100);
        }
      }
    }

    if (!report) {
      throw new Error('Could not run canary audit: content script not responding on tab ' + tabId);
    }

    const guard = createEgressGuard({
      serverOrigin: CONFIG.serverOrigin,
      ledger: new Ledger(new MemoryLedgerStore()),
      canaries: report.values,
      allowInsecureLocalhost: CONFIG.allowInsecureLocalhost,
    });

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

    const dirty = dirtyProbe();
    const verdict = await this.#guard(dirty);
    checks.push({
      name: 'Egress guard refuses a payload containing PII',
      ok: !verdict.ok,
      detail: verdict.ok ? 'GUARD FAILED TO BLOCK' : 'blocked: ' + verdict.reason,
    });

    return { passed: checks.every((c) => c.ok), checks };
  }

  /** Clears the privacy ledger storage, resetting to an empty genesis state. */
  async clearLedger(): Promise<{ ok: boolean }> {
    await this.ledger.clear();
    return { ok: true };
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
  return e instanceof Error ? e.name : 'Error';
}

function fmtBytes(n: number): string {
  return n < 1024 ? String(n) + ' B' : (n / 1024).toFixed(1) + ' KB';
}

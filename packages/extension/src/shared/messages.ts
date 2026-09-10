/**
 * The typed message bus across all four extension contexts (ticket A3).
 *
 * Everything is request/response with a discriminated `kind`, so adding a message
 * without handling it is a compile error rather than a silent no-op at runtime.
 *
 * RULES.md P3: no vault value, no raw element value, and no screenshot ever travels
 * through here. Content scripts send text that KAVACH has already tokenised.
 */

import type { Action, SSG } from '@prahari/ssg';
import type { DiffRow, LedgerEntry } from '@prahari/kavach';

/* ------------------------------------------------------- side panel -> background */

export interface StartTask {
  kind: 'START_TASK';
  goal: string;
  /** The tab the task should run on. Required when sent from the side panel. */
  tabId: number;
  /** When true, the agent may use saved profile data to fill known fields. */
  autoFillPrefilled?: boolean | undefined;
  userProfile?: unknown;
}

/** Side panel sends this when the user has answered a clarifying question. */
export interface AnswerQuestion {
  kind: 'ANSWER_QUESTION';
  tabId: number;
  /** The field/key the question was about. */
  fieldKey: string;
  /** The user-supplied value. */
  value: string;
}

/**
 * Side panel sends this when the user wants to save a field answer permanently
 * so it is auto-filled in future tasks without asking again.
 */
export interface SaveField {
  kind: 'SAVE_FIELD';
  /** A stable key identifying the field (e.g. "gender", "state", "field_2"). */
  fieldKey: string;
  /** Human-readable label to show in the saved fields list (e.g. "Gender"). */
  label: string;
  /** The value to save. */
  value: string;
}
export interface StopTask {
  kind: 'STOP_TASK';
  tabId: number;
}
export interface GetState {
  kind: 'GET_STATE';
  tabId: number;
}
export interface GetLedger {
  kind: 'GET_LEDGER';
  tabId: number;
}
export interface SelfTest {
  kind: 'SELF_TEST';
  tabId: number;
}
/** Turns the on-page redaction overlay on or off (ticket D15). */
export interface SetOverlay {
  kind: 'SET_OVERLAY';
  enabled: boolean;
  tabId: number;
}
/** Runs the live canary audit against the current page (ticket D17). */
export interface RunCanaryAudit {
  kind: 'RUN_CANARY_AUDIT';
  tabId: number;
}
/** Fetches the exact bytes of one past step, for the diff viewer (ticket D16). */
export interface GetTransmission {
  kind: 'GET_TRANSMISSION';
  traceId: string;
  tabId: number;
}

/* --------------------------------------------------- background -> content script */

export interface ExtractScreen {
  kind: 'EXTRACT_SCREEN';
  goal: string;
  step: number;
  traceId: string;
  sessionId: string;
  autoFillPrefilled?: boolean | undefined;
  userProfile?: unknown;
  userAnswers?: Record<string, string> | undefined;
}
export interface ExecuteAction {
  kind: 'EXECUTE_ACTION';
  action: Action;
}

/* ------------------------------------------------------ background -> offscreen */

export interface HostPing {
  kind: 'HOST_PING';
}

export interface DetectFaces {
  kind: 'DETECT_FACES';
  image: ImageData;
}

/* --------------------------------------------------------- mascot overlay messages */

export interface ToggleMascot {
  kind: 'TOGGLE_MASCOT';
}

export interface SetMascotVisible {
  kind: 'SET_MASCOT_VISIBLE';
  visible: boolean;
}

export interface SetMascotTheme {
  kind: 'SET_MASCOT_THEME';
  themeIndex?: number | undefined;
  themeName?: string | undefined;
  tabNumber?: number | undefined;
}

/**
 * Sent to the currently-focused tab when a *different* tab's task reaches a
 * terminal phase. The receiving content script shows a cross-tab toast.
 */
export interface TaskNotify {
  kind: 'TASK_NOTIFY';
  tabId: number;
  tabTitle: string;
  phase: AgentPhase;
  message: string;
}

/**
 * Content-script → background: bring a specific tab to the foreground.
 * Triggered by the "Switch to tab" button in the cross-tab toast.
 */
export interface FocusTab {
  kind: 'FOCUS_TAB';
  tabId: number;
}

export type MascotMood = 'idle' | 'working' | 'thinking' | 'success' | 'error';

export interface MascotTaskItem {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress?: number | undefined;
  detail?: string | undefined;
  timestamp?: number | undefined;
}

export type Request =
  | StartTask
  | StopTask
  | GetState
  | GetLedger
  | SelfTest
  | GetTransmission
  | SetOverlay
  | RunCanaryAudit
  | ExtractScreen
  | ExecuteAction
  | HostPing
  | DetectFaces
  | ToggleMascot
  | SetMascotVisible
  | SetMascotTheme
  | TaskNotify
  | FocusTab
  | AnswerQuestion
  | SaveField;

/* ------------------------------------------------------------------- responses */

export type AgentPhase =
  | 'idle'
  | 'observing'
  | 'sanitizing'
  | 'sending'
  | 'thinking'
  | 'acting'
  | 'asking'
  | 'done'
  | 'blocked'
  | 'error'
  | 'interrupted';

/** A clarifying question the agent needs the user to answer before it can proceed. */
export interface AgentQuestion {
  /** Identifies the field/slot this question is about (e.g. "address", "subject"). */
  fieldKey: string;
  /** Human-readable question shown to the user. */
  question: string;
  /** Optional hint labels for quick-pick buttons. */
  options?: string[] | undefined;
}

export interface AgentState {
  phase: AgentPhase;
  /** Unique identifier for this task instance. Rotates on every new task. */
  taskId: string;
  /** The browser tab this task is bound to. */
  tabId: number;
  /** Sequential human-friendly tab number (1, 2, 3...). */
  tabNumber?: number | undefined;
  goal: string;
  /** Set when phase === 'asking'. The agent is waiting for a user answer. */
  pendingQuestion?: AgentQuestion | undefined;
  step: number;
  tier: 0 | 1 | 2;
  /** Human-readable line for the status area. Never contains page values. */
  message: string;
  lastBytes: number;
  totalBytes: number;
  redactionCount: number;
  blockedCount: number;
  inferenceHost: string;
}

export interface ExtractResult {
  /** Already tokenised by the content-script redactor. */
  ssg: SSG;
  /** Counts only. The values behind the tokens never leave the tab. */
  redactions: Record<string, number>;
  /**
   * Per-redaction rows for the diff viewer. Masked, never the real value: the vault
   * stays in the tab and nothing recoverable crosses this boundary (RULES.md P3).
   */
  diff: DiffRow[];
}

export interface TransmissionView {
  traceId: string;
  step: number;
  sentAt: number;
  /** The exact bytes handed to fetch. */
  payload: string;
  sha256: string;
  byteLen: number;
  diff: DiffRow[];
  blockedReason?: string;
}

export interface SurfaceResult {
  surface: string;
  planted: number;
  observed: number;
  leaked: number;
  /** True when today's harvester is expected to read this surface at all. */
  required: boolean;
}

export interface CanaryAuditResult {
  total: number;
  /** How many canaries the harvester actually saw. A leak count alone can be passed
   *  by a reader that looks nowhere, so this half matters just as much. */
  observed: number;
  /** PII canaries that survived into the payload the REAL extractor produced.
   *  Must be zero: unlike the conspicuous canaries, these ARE personal data, so one
   *  arriving at the server is a redaction failure rather than correct Tier-1 text. */
  leaked: number;
  piiTotal: number;
  /** Canaries on surfaces the harvester must read today; `observed` over all twelve
   *  includes ones we honestly cannot see yet (canvas pixels, CSS content, iframes),
   *  so this is the fraction that is actually a pass/fail. */
  requiredTotal: number;
  requiredObserved: number;
  /** True when the guard independently refused every payload carrying a canary. */
  guardBlocked: boolean;
  surfaces: SurfaceResult[];
  ranAt: number;
}

export interface ActionResult {
  outcome: 'advanced' | 'no_change' | 'error' | 'blocked';
  detail?: string;

  /** Data extracted from the current page. */
  data?: Record<string, unknown>;

  /** Question that requires user interaction. */
  question?: string;
  options?: string[];
}

export interface SelfTestResult {
  passed: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export type ResponseFor<R extends Request> = R extends StartTask | StopTask | GetState
  ? AgentState
  : R extends GetLedger
    ? LedgerEntry[]
    : R extends RunCanaryAudit
      ? CanaryAuditResult
      : R extends GetTransmission
        ? TransmissionView | null
        : R extends SelfTest
          ? SelfTestResult
          : R extends ExtractScreen
            ? ExtractResult
            : R extends ExecuteAction
              ? ActionResult
              : R extends HostPing
                ? { ok: true; host: string }
                : R extends DetectFaces
                  ? { faces: readonly [number, number, number, number][] }
                  : never;

/** Port name used for the side panel's live state subscription. */
export const PANEL_PORT = 'prahari-panel';

export interface PanelPush {
  kind: 'STATE_UPDATE';
  state: AgentState;
}

/** Sent by background to the side panel when the agent needs a user answer. */
export interface QuestionPush {
  kind: 'AGENT_QUESTION';
  tabId: number;
  question: AgentQuestion;
}

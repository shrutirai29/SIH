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
}
export interface StopTask {
  kind: 'STOP_TASK';
}
export interface GetState {
  kind: 'GET_STATE';
}
export interface GetLedger {
  kind: 'GET_LEDGER';
}
export interface SelfTest {
  kind: 'SELF_TEST';
}
/** Turns the on-page redaction overlay on or off (ticket D15). */
export interface SetOverlay {
  kind: 'SET_OVERLAY';
  enabled: boolean;
}
/** Runs the live canary audit against the current page (ticket D17). */
export interface RunCanaryAudit {
  kind: 'RUN_CANARY_AUDIT';
}
/** Fetches the exact bytes of one past step, for the diff viewer (ticket D16). */
export interface GetTransmission {
  kind: 'GET_TRANSMISSION';
  traceId: string;
}

/* --------------------------------------------------- background -> content script */

export interface ExtractScreen {
  kind: 'EXTRACT_SCREEN';
  goal: string;
  step: number;
  traceId: string;
  sessionId: string;
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
  | DetectFaces;

/* ------------------------------------------------------------------- responses */

export type AgentPhase =
  | 'idle'
  | 'observing'
  | 'sanitizing'
  | 'sending'
  | 'thinking'
  | 'acting'
  | 'done'
  | 'blocked'
  | 'error';

export interface AgentState {
  phase: AgentPhase;
  goal: string;
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

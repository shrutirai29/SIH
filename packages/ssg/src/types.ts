/**
 * TypeScript view of the SETU wire contract.
 *
 * NOTE (ticket C1 / RULES.md sec 7): the JSON Schema under `schema/` is the single
 * source of truth. These types are hand-written for the walking skeleton and MUST be
 * replaced by `json-schema-to-typescript` output before Phase 3. The contract CI job
 * that diffs generated output does not exist yet.
 */

export type Tier = 0 | 1 | 2;
export type Risk = 'safe' | 'medium' | 'high';
export type RedactionMethod = 'placeholder' | 'blackout' | 'blur' | 'pixelate' | 'drop';
export type Sensitivity = 'public' | 'semi_private' | 'private' | 'credential';
export type PageType =
  | 'form' | 'article' | 'list' | 'canvas_app'
  | 'media' | 'pdf' | 'chat' | 'dashboard' | 'unknown';
export type Actionable = 'click' | 'type' | 'select' | 'clear' | 'hover' | 'focus' | 'scroll';
export type Outcome = 'advanced' | 'no_change' | 'error' | 'blocked';

/** [x, y, w, h] in CSS pixels, viewport-relative. */
export type Bbox = readonly [number, number, number, number];

/**
 * Text that has been through KAVACH. The brand makes the privacy invariant a
 * compile-time property: the SSG builder accepts nothing else (RULES.md AI-12).
 */
export type RedactedText = string & { readonly __redacted: unique symbol };

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
  scroll_y: number;
  doc_h?: number;
}

export interface Page {
  origin_class: string;
  path_shape?: string;
  title?: RedactedText;
  lang?: string;
  page_type: PageType;
  sensitivity: Sensitivity;
}

export interface Redaction {
  applied: boolean;
  class?: string;
  method?: RedactionMethod;
}

export interface Element {
  id: string;
  role: string;
  tag?: string;
  input_type?: string;
  bbox: Bbox;
  z?: number;
  visible?: boolean;
  name?: RedactedText;
  value?: RedactedText;
  placeholder?: RedactedText;
  state?: Record<string, boolean>;
  redaction?: Redaction;
  actionable: Actionable[];
  client_risk?: Risk;
  risk_reason?: string;
}

export interface TextBlock {
  id: string;
  bbox: Bbox;
  source: 'dom' | 'ocr';
  text: RedactedText;
  ocr_conf?: number;
}

export interface VisualRegion {
  id: string;
  bbox: Bbox;
  kind: 'img' | 'video' | 'canvas' | 'iframe' | 'svg' | 'unknown';
  caption?: RedactedText;
  redaction?: Redaction;
}

export interface HistoryItem {
  step: number;
  action: string;
  target?: string;
  outcome: Outcome;
}

export interface RedactionManifest {
  policy_id: string;
  counts: Record<string, number>;
  methods: Partial<Record<RedactionMethod, number>>;
  detectors: string[];
  coverage_confidence: number;
  unexplained_pixel_ratio?: number;
  marker_convention?: string;
}

export interface Attachment {
  screenshot: {
    format: 'jpeg' | 'png';
    w: number;
    h: number;
    q?: number;
    sha256: string;
    redacted: true;
    data?: string;
  };
}

export interface SSG {
  ssg_version: '1.0';
  session_id: string;
  trace_id: string;
  step: number;
  tier: Tier;
  purpose: string;
  goal: RedactedText;
  viewport: Viewport;
  page: Page;
  elements: Element[];
  text_blocks?: TextBlock[];
  visual_regions?: VisualRegion[];
  history?: HistoryItem[];
  redaction_manifest: RedactionManifest;
  attachment?: Attachment;
}

/* ---------------------------------------------------------------- Action Plan */

export type Target = string | { point: readonly [number, number] };

export type Action =
  | { op: 'click'; target: Target; risk?: Risk; reason?: string }
  | { op: 'type'; target: Target; value?: string; value_ref?: string; clear_first?: boolean; risk?: Risk }
  | { op: 'select'; target: Target; option: string; risk?: Risk }
  | { op: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' | 'to_element'; amount?: number; target?: Target; risk?: Risk }
  | { op: 'key'; combo: string; risk?: Risk }
  | { op: 'navigate'; url: string; risk?: 'high' }
  | { op: 'wait'; ms?: number }
  | { op: 'extract'; targets: Target[]; fields?: string[] }
  | { op: 'ask_user'; question: string; options?: string[] }
  | { op: 'done'; summary?: string }
  | { op: 'fail'; reason?: string };

export type ActionOp = Action['op'];

export interface ActionPlan {
  plan_id: string;
  trace_id: string;

  /**
   * Internal explanation of why the agent chose its actions.
   * This is optional and is not necessarily shown directly to the user.
   */
  reasoning?: string;

  /**
   * A user-facing response generated from the current page and task.
   *
   * This allows the agent to answer questions, summarize, analyze, explain,
   * or report results even when no browser action is required.
   */
  response?: string;

  actions: Action[];

  expect?: {
    page_change?: boolean;
    assert_role?: string;
    assert_text_absent?: string;
  };

  next_tier_hint?: Tier;
  need_visual?: boolean;
  done: boolean;
  confidence?: number;
}

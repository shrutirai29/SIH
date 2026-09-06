/**
 * DOM + accessibility extraction (ticket B1).
 *
 * Walks the live page, harvests every text surface a value can hide in, and hands each
 * one to KAVACH before it is ever placed in the SSG. Redaction happens here, in the
 * tab, so a raw value never crosses a message boundary.
 *
 * Still missing until Phase 2: frame stitching (B4), shadow-root traversal (B5),
 * occlusion sampling (B2), and IDs that survive a React re-render (B3).
 */

import { findTokens, formatToken, neutralizeTokens } from '@prahari/ssg';
import type { Actionable, Bbox, Element as SsgElement, RedactedText, Risk, SSG } from '@prahari/ssg';
import {
  classifyField,
  coverageConfidence,
  redactKnownField,
  redactText,
  maskForDisplay,
  type DiffRow,
  type FieldDescriptor,
  type FusedDetection,
} from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';
import { createEphemeralSession, getSession, type KavachSession } from './session.js';
import { isOverlayNode, setMarks } from './overlay.js';

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
  '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]',
  '[role=radio]', '[role=combobox]', '[role=tab]', '[contenteditable=true]',
].join(',');

/** The shared symbol standing in for any credential; never resolvable. */
const IRREVERSIBLE_TOKEN = formatToken('REDACTED', 0);

/** Live map from SSG id to element, so the executor can resolve a target. */
export const elementRegistry = new Map<string, WeakRef<Element>>();

function isVisible(el: Element, rect: DOMRect): boolean {
  if (rect.width === 0 || rect.height === 0) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (Number.parseFloat(style.opacity) < 0.05) return false;
  const margin = window.innerHeight * 1.5;
  return rect.bottom > -margin && rect.top < window.innerHeight + margin;
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.length > 0) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return 'generic';
}

function labelTextFor(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      return [...labels].map((l) => l.textContent?.trim() ?? '').join(' ').trim();
    }
  }
  return '';
}

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join(' ');
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel.trim();

  const label = labelTextFor(el);
  if (label.length > 0) return label;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim();
    if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button')) {
      if (el.value.length > 0) return el.value;
    }
  }

  if (el instanceof HTMLImageElement && el.alt.length > 0) return el.alt;

  const title = el.getAttribute('title');
  if (title !== null && title.trim().length > 0) return title.trim();

  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Every text surface attached to an element.
 *
 * This list is the difference between a redactor that works and one that leaks: a
 * `data-user-email` attribute is invisible to `textContent` and perfectly legible to
 * anyone reading the serialised DOM (PIPELINE.md §5.1 step 5). The canary suite plants
 * a string in each of these surfaces and fails if any is not read.
 */
export function harvestSurfaces(el: Element): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined): void => {
    if (s !== null && s !== undefined && s.trim().length > 0) out.push(s);
  };

  push(el.getAttribute('alt'));
  push(el.getAttribute('title'));
  push(el.getAttribute('aria-label'));
  push(el.getAttribute('placeholder'));
  push(el.getAttribute('aria-description'));

  // data-* attributes: a favourite hiding place for user ids and emails.
  if (el instanceof HTMLElement) {
    for (const key of Object.keys(el.dataset)) push(el.dataset[key]);
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    push(el.value);
    push(el.defaultValue);
  }

  if (el instanceof HTMLSelectElement) {
    for (const option of el.options) {
      push(option.text);
      push(option.value);
    }
  }

  return out;
}

function actionsFor(el: Element, role: string): Actionable[] {
  const out: Actionable[] = [];
  const editable =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement &&
      !['checkbox', 'radio', 'submit', 'button', 'reset'].includes(el.type)) ||
    el.getAttribute('contenteditable') === 'true';

  if (editable) out.push('type', 'clear');
  if (role === 'combobox' && el instanceof HTMLSelectElement) out.push('select');
  out.push('click', 'focus');
  return out;
}

/**
 * Risk derived from the element itself, CLIENT-SIDE (RULES.md S2). The server may
 * raise it and may never lower it.
 */
function deriveRisk(el: Element, name: string): { risk: Risk; reason: string } | null {
  const text = name.toLowerCase();

  if (el instanceof HTMLInputElement && el.type === 'password') {
    return { risk: 'high', reason: 'credential_field' };
  }

  const isSubmit =
    (el instanceof HTMLInputElement && el.type === 'submit') ||
    (el instanceof HTMLButtonElement && (el.type === 'submit' || el.form !== null));

  if (isSubmit || /submit|pay|confirm|delete|remove|transfer|send|apply now|place order/.test(text)) {
    return { risk: 'high', reason: 'form_submit|origin=' + originClass() };
  }

  if (el instanceof HTMLAnchorElement && el.href.length > 0) {
    try {
      if (new URL(el.href).origin !== location.origin) {
        return { risk: 'medium', reason: 'cross_origin_link' };
      }
    } catch {
      /* a malformed href is not risky by itself */
    }
  }

  return null;
}

/**
 * Generalised origin. The raw URL carries session tokens, order ids and often the
 * user's own identifiers, so it never leaves.
 */
export function originClass(): string {
  // Non-web schemes have no meaningful hostname. `file:` is the important one: its
  // path is the user's home directory, which on most machines contains their real
  // name. Returning '' here (as an earlier version did) let the path through as the
  // only identifying field, which is worse than useless.
  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    return location.protocol.replace(':', '');
  }
  const host = location.hostname;
  if (host.endsWith('.gov.in') || host.endsWith('.nic.in')) return 'gov.in';
  return host.split('.').slice(-2).join('.') || host;
}

/**
 * Structure of the path with identifiers stripped.
 *
 * For anything that is not http(s) the path is withheld entirely. A `file:` path is
 * `/C:/Users/<the user's actual name>/...` — a person's name, transmitted verbatim,
 * which is exactly what this system exists to prevent. Found by the browser test
 * (TODO.md bug #7); no node test could have seen it, because none of them run on a
 * real `file:` URL.
 */
function pathShape(): string {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') {
    return '/(local)';
  }
  return location.pathname
    .split('/')
    .map((seg) => {
      if (seg.length === 0) return seg;
      // Anything that looks like an identifier rather than a route name: digits, hex
      // ids, uuids, or a long opaque token.
      if (/^\d+$/.test(seg)) return '*';
      if (/^[0-9a-f-]{6,}$/i.test(seg)) return '*';
      if (seg.length > 32) return '*';
      return seg;
    })
    .join('/')
    .slice(0, 128);
}

function classifyPage(fieldCount: number): SSG['page']['page_type'] {
  if (document.querySelector('canvas') !== null && fieldCount === 0) return 'canvas_app';
  if (fieldCount >= 3) return 'form';
  if (document.querySelector('article') !== null) return 'article';
  return 'unknown';
}

function descriptorFor(el: Element): FieldDescriptor {
  const input = el instanceof HTMLInputElement ? el : null;
  const d: FieldDescriptor = {
    type: input !== null ? input.type.toLowerCase() : el.tagName.toLowerCase(),
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.id,
    placeholder: el.getAttribute('placeholder') ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    label: labelTextFor(el),
    inputMode: el.getAttribute('inputmode') ?? '',
  };
  return d;
}

export interface ExtractOptions {
  goal: string;
  step: number;
  traceId: string;
  sessionId: string;
  /**
   * Runs the pipeline against a throwaway vault and leaves the shared per-tab state
   * alone: no session wipe, no element registry rewrite, no overlay repaint.
   *
   * The canary audit needs this. It has to run the REAL extractor over the planted
   * page — measuring anything else measures the wrong component — but it must not
   * destroy the vault of a task that is mid-flight, or repoint the element ids the
   * executor is about to resolve.
   */
  ephemeral?: boolean;
}

export interface ExtractOutput {
  ssg: SSG;
  redactions: Record<string, number>;
  /**
   * One row per redaction for the diff viewer (ticket D16). Previews are masked, so
   * this carries nothing recoverable across the message boundary (RULES.md P3).
   */
  diff: DiffRow[];
}

export async function extractScreen(opts: ExtractOptions): Promise<ExtractOutput> {
  const ephemeral = opts.ephemeral === true;
  const session = ephemeral
    ? await createEphemeralSession(opts.step)
    : await getSession(opts.sessionId, opts.step);
  if (!ephemeral) elementRegistry.clear();

  const elements: SsgElement[] = [];
  const allCounts: Record<string, number>[] = [];
  const diff: DiffRow[] = [];
  const seenRows = new Set<string>();
  let fieldCount = 0;

  /**
   * Records one row of the diff.
   *
   * `raw` is the real on-screen value and is masked here, in the tab, before it can go
   * anywhere. Nothing recoverable is placed on `diff` (RULES.md P3).
   *
   * `label` must already be REDACTED, and the caller is what guarantees it. An earlier
   * version passed the raw accessible name — so on a page whose label is itself
   * identifying (`aria-label="Delete payment method ending 4242"`,
   * `title="Email asha@example.com"`, a row button naming an account number) the real
   * string crossed the message boundary into the side panel and rendered there, beside
   * a carefully masked preview of the same data. The demo portal's labels are generic
   * ("Full name", "Aadhaar number"), which is exactly why no test noticed.
   */
  const note = (
    elementId: string,
    label: string,
    raw: string,
    detections: readonly FusedDetection[],
    tokenText: string,
  ): void => {
    for (const d of detections) {
      const token = findTokens(tokenText)[0]?.token ?? tokenText;
      // One row per (element, class, token): the same value scanned on several
      // surfaces must not appear three times in the viewer.
      const key = elementId + ' ' + d.cls + ' ' + token;
      if (seenRows.has(key)) continue;
      seenRows.add(key);

      diff.push({
        elementId,
        label: label.slice(0, 60),
        cls: d.cls,
        preview: maskForDisplay(raw, d.cls),
        token,
        sources: [...d.sources],
        confidence: Number(d.confidence.toFixed(2)),
        reversible: token !== IRREVERSIBLE_TOKEN,
      });
    }
  };

  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (elements.length >= CONFIG.maxElements) break;

    // Our own overlay must never become an element the agent believes it can click.
    if (isOverlayNode(el)) continue;

    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;

    const id = 'e' + String(elements.length + 1);
    const role = roleOf(el);
    const redactOpts = {
      vault: session.vault,
      policy: session.policy,
      originElementId: id,
      originOrigin: session.origin,
    };

    const rawName = accessibleName(el);
    const name = await redactText(rawName, redactOpts);
    allCounts.push(name.counts);
    note(id, name.text, rawName, name.detections, name.text);

    const entry: SsgElement = {
      id,
      // `role` is `getAttribute('role')` — page-controlled, and it lands in the SSG
      // without passing through the redactor, so it is a forged-token route of its own.
      role: neutralizeTokens(role),
      tag: el.tagName.toLowerCase(),
      bbox: [
        Math.round(rect.x), Math.round(rect.y),
        Math.round(rect.width), Math.round(rect.height),
      ] as Bbox,
      visible: true,
      actionable: actionsFor(el, role),
    };

    if (name.text.length > 0) entry.name = name.text as RedactedText;

    let redacted = name.applied;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      fieldCount++;
      if (el instanceof HTMLInputElement) entry.input_type = el.type.toLowerCase();

      const value = el.value;
      if (value.length > 0) {
        // L0 first: when the DOM declares the class, there is nothing to infer.
        const l0 = classifyField(descriptorFor(el));
        const result =
          l0 !== null
            ? await redactKnownField(value, l0.cls, redactOpts)
            : await redactText(value, redactOpts);

        entry.value = result.text as RedactedText;
        allCounts.push(result.counts);
        note(id, name.text, value, result.detections, result.text);
        if (result.applied) {
          redacted = true;
          const cls = result.detections[0]?.cls;
          entry.redaction = {
            applied: true,
            method: 'placeholder',
            ...(cls !== undefined ? { class: cls } : {}),
          };
        }
      }

      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.length > 0) {
        const p = await redactText(placeholder, redactOpts);
        entry.placeholder = p.text as RedactedText;
        allCounts.push(p.counts);
        if (p.applied) redacted = true;
      }

      entry.state = {
        focused: document.activeElement === el,
        disabled: el.disabled,
        required: el.required,
      };
    }

    // Every other surface (alt, title, data-*, option text) is harvested and scanned.
    // Its text does not go into the SSG, but a value found here still gets vaulted, so
    // the counts are honest and nothing hides in an attribute we did not read.
    for (const surface of harvestSurfaces(el)) {
      const r = await redactText(surface, redactOpts);
      allCounts.push(r.counts);
      if (r.applied) redacted = true;
    }

    if (redacted && entry.redaction === undefined) {
      entry.redaction = { applied: true, method: 'placeholder' };
    }

    const risk = deriveRisk(el, rawName);
    if (risk !== null) {
      entry.client_risk = risk.risk;
      entry.risk_reason = risk.reason;
    }

    elements.push(entry);
    // An ephemeral pass leaves the registry alone: repointing `e17` at a canary input
    // would make the executor's next resolve land somewhere the plan never meant.
    if (!ephemeral) elementRegistry.set(id, new WeakRef(el));
  }

  const textBlocks = await collectTextBlocks(session, allCounts);
  const title = await redactText(document.title, {
    vault: session.vault,
    policy: session.policy,
    originElementId: 'page-title',
    originOrigin: session.origin,
  });
  allCounts.push(title.counts);

  // The goal is typed by the USER, and users paste their own identifiers into goal
  // boxes ("apply with aadhaar 2345 6789 0124"). Without this it reached the payload
  // verbatim, the egress guard's text sweep refused the step — correctly, and fail-
  // closed — and the user saw `PII_DETECTED` with nothing connecting it to what they
  // had typed. Redacting it turns a dead end into the feature working: the planner
  // gets `⟦AADHAAR_1⟧` and can ask for it back by reference.
  const goal = await redactText(opts.goal.slice(0, 512), {
    vault: session.vault,
    policy: session.policy,
    originElementId: 'page-goal',
    originOrigin: session.origin,
  });

  // Counts are derived from the DISTINCT tokens the VAULT MINTED, not by summing what
  // each redactText call reported. The same value is scanned several times per element
  // (value, defaultValue, aria-label, data-*), and summing made the manifest claim
  // three Aadhaar numbers where the screen held one. The manifest is what the server
  // reasons about, so an inflated count is a lie it will act on. (TODO.md bug #8)
  //
  // Deriving it from the VAULT rather than from the payload also restores the egress
  // guard's check 6. Scanning the payload for tokens made the manifest a description
  // of whatever the payload happened to contain — including a token a hostile page had
  // written into its own text, which was then dutifully declared, and check 6 compared
  // the payload against itself. The vault is the one source no page can reach.
  const counts = countMintedTokens(session, elements, textBlocks, title.text);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  void allCounts;

  const ssg: SSG = {
    ssg_version: '1.0',
    session_id: opts.sessionId,
    trace_id: opts.traceId,
    step: opts.step,
    tier: 1,
    purpose: 'assist-user-task',
    goal: goal.text as RedactedText,
    viewport: {
      w: Math.round(window.innerWidth),
      h: Math.round(window.innerHeight),
      dpr: window.devicePixelRatio,
      scroll_y: Math.round(window.scrollY),
      doc_h: Math.round(document.documentElement.scrollHeight),
    },
    page: {
      origin_class: originClass(),
      path_shape: pathShape(),
      title: title.text.slice(0, 200) as RedactedText,
      lang: neutralizeTokens(document.documentElement.lang.slice(0, 12)) || 'en',
      page_type: classifyPage(fieldCount),
      sensitivity:
        document.querySelector('input[type=password]') !== null ? 'credential' : 'semi_private',
    },
    elements,
    redaction_manifest: {
      policy_id: 'in-default-v1',
      counts,
      methods: { placeholder: total },
      detectors: ['dom-rules@0.2', 'regex-in@0.2'],
      // Honest: with no NER and no vision running, contextual and visual PII are not
      // covered, and the server is told so rather than left to assume.
      coverage_confidence: coverageConfidence({
        detections: [],
        unexplainedPixelRatio: 0,
        timedOutDetectors: [],
        activeLayers: ['l0-dom', 'l1-regex'],
      }),
      unexplained_pixel_ratio: 0,
      marker_convention: 'text-only (tier 1)',
    },
  };

  if (textBlocks.length > 0) ssg.text_blocks = textBlocks;

  // The overlay redraws from this on every step, so what the user sees on the page
  // and what the diff viewer reports come from one source (ticket D15). An ephemeral
  // pass must not touch it: the audit's planted canaries are not the user's data and
  // boxing them would be a lie drawn on their screen.
  if (!ephemeral) {
    setMarks(
      diff.map((d) => ({ elementId: d.elementId, cls: d.cls, reversible: d.reversible })),
    );
  }

  return { ssg, redactions: counts, diff };
}

/**
 * Groups by class the distinct tokens that are BOTH present in the payload and were
 * genuinely minted by this session's vault.
 *
 * The two conditions do different work. "Present in the payload" keeps the manifest
 * from over-declaring: the vault mints a token for every value it finds on every
 * surface, including `data-*` attributes whose text never reaches the SSG. "Minted by
 * the vault" keeps it from declaring a forgery: a `⟦AADHAAR_1⟧` the page wrote itself
 * is not in the issued set, so it goes undeclared and the egress guard's check 6
 * refuses the payload instead of waving through a token nothing can resolve.
 *
 * The credential sentinel is counted by how many credential fields were masked rather
 * than by distinct token, because several credentials deliberately share one symbol —
 * the server still needs to know there are two of them.
 */
function countMintedTokens(
  session: KavachSession,
  elements: readonly SsgElement[],
  textBlocks: NonNullable<SSG['text_blocks']>,
  title: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const issued = new Set(session.vault.describe().map((d) => d.token));

  const scan = (text: string | undefined): void => {
    if (text === undefined) return;
    for (const t of findTokens(text)) {
      if (t.cls === 'REDACTED') continue;
      if (!issued.has(t.token)) continue;
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      counts[t.cls] = (counts[t.cls] ?? 0) + 1;
    }
  };

  for (const el of elements) {
    scan(el.name);
    scan(el.value);
    scan(el.placeholder);
    // A credential field masks a real value even though its token is shared.
    const cls = el.redaction?.class;
    if (cls !== undefined && el.value === IRREVERSIBLE_TOKEN) {
      counts[cls] = (counts[cls] ?? 0) + 1;
    }
  }
  for (const b of textBlocks) scan(b.text);
  scan(title);

  return counts;
}

async function collectTextBlocks(
  session: KavachSession,
  allCounts: Record<string, number>[],
): Promise<NonNullable<SSG['text_blocks']>> {
  const out: NonNullable<SSG['text_blocks']> = [];
  let n = 0;

  for (const el of document.querySelectorAll('h1, h2, h3, legend, label, p')) {
    if (out.length >= 12) break;
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;

    const raw = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length < 3 || raw.length > 400) continue;

    n++;
    const id = 't' + String(n);
    const redacted = await redactText(raw, {
      vault: session.vault,
      policy: session.policy,
      originElementId: id,
      originOrigin: session.origin,
    });
    allCounts.push(redacted.counts);

    out.push({
      id,
      bbox: [
        Math.round(rect.x), Math.round(rect.y),
        Math.round(rect.width), Math.round(rect.height),
      ] as Bbox,
      source: 'dom',
      text: redacted.text.slice(0, 400) as RedactedText,
    });
  }
  return out;
}

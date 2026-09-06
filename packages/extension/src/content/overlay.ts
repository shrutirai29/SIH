/**
 * The glass-box overlay (ticket D15).
 *
 * Draws a box over every element KAVACH redacted, on the live page, as it happens.
 * Its job is to make the invisible visible: the diff viewer shows what left *after the
 * fact*, and this shows the detector working *in the moment*, on the user's own screen.
 *
 * ## Marker convention
 *
 * Follows CONTEXT.md §5.4 — fill `#2B3A4A` at 92%, a 2px `#6EA8FE` border, and a class
 * glyph — because the same convention is declared to the server in its system prompt.
 * Keeping the on-screen marker and the transmitted marker identical means what the user
 * sees is what the model sees. Credentials are drawn in red instead: they are the one
 * class the client itself cannot resolve, and that difference should be legible.
 *
 * ## Not interfering with the page
 *
 * The overlay lives in an open shadow root on a single fixed-position host with
 * `pointer-events: none`, so it cannot receive clicks, cannot be styled by the page,
 * and cannot appear in the page's own layout. It is also skipped by extraction: a
 * redaction marker must never become an element the agent tries to click.
 */

import { groupOf } from '@prahari/kavach';
import { elementRegistry } from './extract.js';

const HOST_ID = 'prahari-glassbox';

/** Colour per sensitivity group. Credentials read differently on purpose. */
const GROUP_STYLE: Record<string, { stroke: string; fill: string; glyph: string }> = {
  credential: { stroke: '#ff6b6b', fill: 'rgba(179, 38, 30, 0.16)', glyph: '⊘' },
  gov_id: { stroke: '#6ea8fe', fill: 'rgba(43, 58, 74, 0.20)', glyph: '🪪' },
  financial: { stroke: '#ffc46b', fill: 'rgba(154, 103, 0, 0.16)', glyph: '₹' },
  health: { stroke: '#8fd694', fill: 'rgba(22, 122, 74, 0.16)', glyph: '✚' },
  biometric: { stroke: '#c58fe8', fill: 'rgba(120, 60, 160, 0.18)', glyph: '☺' },
  contact: { stroke: '#6ea8fe', fill: 'rgba(43, 58, 74, 0.16)', glyph: '✉' },
  identity: { stroke: '#9db4cf', fill: 'rgba(43, 58, 74, 0.14)', glyph: '👤' },
  other: { stroke: '#9db4cf', fill: 'rgba(43, 58, 74, 0.14)', glyph: '•' },
};

export interface OverlayMark {
  readonly elementId: string;
  readonly cls: string;
  /** False for credentials: nothing, including this machine, can resolve them. */
  readonly reversible: boolean;
}

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let marks: OverlayMark[] = [];
let enabled = false;
let rafPending = false;

function ensureHost(): ShadowRoot {
  if (root !== null) return root;

  host = document.createElement('div');
  host.id = HOST_ID;
  // `data-prahari` marks this as ours so extraction skips it: an overlay box must
  // never become an element the agent believes it can click.
  host.setAttribute('data-prahari-ui', 'overlay');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    // Above almost everything, but below a browser-native dialog.
    'z-index:2147483646',
    'contain:layout style size',
  ].join(';');

  root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '.box{position:fixed;box-sizing:border-box;border-radius:3px;' +
    'transition:opacity .12s ease;pointer-events:none}' +
    '.tag{position:fixed;font:600 10px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'padding:1px 5px;border-radius:3px;color:#fff;white-space:nowrap;' +
    'pointer-events:none;transform:translateY(-100%)}' +
    '</style><div id="layer"></div>';

  document.documentElement.appendChild(host);
  return root;
}

/** Recomputes box positions from live geometry, so scrolling keeps them attached. */
function paint(): void {
  if (!enabled || root === null) return;
  const layer = root.getElementById('layer');
  if (layer === null) return;

  layer.textContent = '';

  for (const mark of marks) {
    const el = elementRegistry.get(mark.elementId)?.deref();
    if (el === undefined || !el.isConnected) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Off-screen boxes are skipped rather than drawn at the edge, which would
    // otherwise pile markers up in the corners on a long page.
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const style = GROUP_STYLE[groupOf(mark.cls)] ?? GROUP_STYLE['other']!;
    const stroke = mark.reversible ? style.stroke : GROUP_STYLE['credential']!.stroke;
    const fill = mark.reversible ? style.fill : GROUP_STYLE['credential']!.fill;

    const box = document.createElement('div');
    box.className = 'box';
    box.style.cssText =
      'left:' + String(rect.left) + 'px;top:' + String(rect.top) + 'px;' +
      'width:' + String(rect.width) + 'px;height:' + String(rect.height) + 'px;' +
      'border:2px solid ' + stroke + ';background:' + fill;
    layer.appendChild(box);

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.style.cssText =
      'left:' + String(rect.left) + 'px;top:' + String(Math.max(rect.top - 2, 12)) + 'px;' +
      'background:' + stroke + ';color:#101820';
    tag.textContent = style.glyph + ' ' + mark.cls + (mark.reversible ? '' : ' · not stored');
    layer.appendChild(tag);
  }
}

function schedulePaint(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    paint();
  });
}

const onViewportChange = (): void => {
  schedulePaint();
};

/** Replaces the current marks. Called after every extraction. */
export function setMarks(next: readonly OverlayMark[]): void {
  marks = [...next];
  schedulePaint();
}

export function setOverlayEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;

  if (!on) {
    host?.remove();
    host = null;
    root = null;
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    return;
  }

  ensureHost();
  // `capture: true` so scrolling inside any container repositions the boxes, not just
  // the document. A box that lags behind its field is worse than no box.
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  schedulePaint();
}

export function isOverlayEnabled(): boolean {
  return enabled;
}

/** True when the node is part of our own UI and must be skipped by extraction. */
export function isOverlayNode(el: Element): boolean {
  return el.id === HOST_ID || el.closest('[data-prahari-ui]') !== null;
}

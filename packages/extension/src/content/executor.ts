import type { Action, Risk, Target } from '@prahari/ssg';
import { isToken } from '@prahari/ssg';
import type { SinkViolation } from '@prahari/kavach';
import type { ActionResult } from '../shared/messages.js';
import { elementRegistry } from './extract.js';
import { currentVault } from './session.js';

const RISK_ORDER: Record<Risk, number> = { safe: 0, medium: 1, high: 2 };

function resolve(target: Target | undefined): Element | null {
  if (target === undefined) return null;
  if (typeof target !== 'string') {
    // Coordinate fallback, for canvas surfaces the DOM cannot describe.
    const [x, y] = target.point;
    return document.elementFromPoint(x, y);
  }
  const ref = elementRegistry.get(target);
  const el = ref?.deref() ?? null;
  if (el !== null && el.isConnected) return el;

  // Fallback 1: Query DOM by data-prahari-id attribute
  const byAttr = document.querySelector(`[data-prahari-id="${target}"]`);
  if (byAttr !== null && byAttr.isConnected) return byAttr;

  // Fallback 2: Query DOM by id attribute
  const byId = document.getElementById(target);
  if (byId !== null && byId.isConnected) return byId;

  return null;
}

/** Risk from the live element, computed fresh at execution time. */
function liveRisk(el: Element | null, action: Action): Risk {
  if (el === null) return 'safe';

  if (el instanceof HTMLInputElement && el.type === 'password') return 'high';

  if (action.op === 'click') {
    const isSubmit =
      (el instanceof HTMLInputElement && el.type === 'submit') ||
      (el instanceof HTMLButtonElement && (el.type === 'submit' || el.form !== null));
    const text = (el.textContent ?? '').toLowerCase();
    if (isSubmit) return 'high';
    if (/submit|pay|confirm|delete|remove|transfer|place order/.test(text)) return 'high';
    if (el instanceof HTMLAnchorElement && el.href.length > 0) {
      try {
        if (new URL(el.href).origin !== location.origin) return 'medium';
      } catch {
        /* malformed href is not risky by itself */
      }
    }
    return 'medium';
  }

  if (action.op === 'type') return 'medium';
  if (action.op === 'navigate') return 'high';
  return 'safe';
}

/**
 * Asynchronous non-blocking DOM confirmation modal.
 * Replaces synchronous `window.confirm` which gets auto-cancelled by browsers on tab switches.
 */
function showDOMConfirmModal(options: {
  title: string;
  details: { label: string; value: string }[];
  note?: string;
  confirmText: string;
  cancelText: string;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Fallback for headless node/vitest test environments without full document.body
    if (typeof document === 'undefined' || !document.body) {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const text =
          `${options.title}\n\n` +
          options.details.map((d) => `${d.label}: ${d.value}`).join('\n') +
          (options.note ? `\n\n${options.note}` : '');
        resolve(window.confirm(text));
        return;
      }
      resolve(true);
      return;
    }

    // Remove any existing leftover PRAHARI confirmation overlay
    const existing = document.getElementById('prahari-confirm-overlay');
    if (existing) existing.remove();

    // Backdrop overlay
    const overlay = document.createElement('div');
    overlay.id = 'prahari-confirm-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(15, 23, 42, 0.82)',
      backdropFilter: 'blur(6px)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: '#f8fafc',
      padding: '20px',
      boxSizing: 'border-box',
    });

    // Modal Card
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: 'linear-gradient(145deg, #1e293b 0%, #0f172a 100%)',
      border: '1px solid #3b82f6',
      borderRadius: '16px',
      padding: '24px',
      maxWidth: '460px',
      width: '100%',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 25px rgba(59, 130, 246, 0.25)',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    });

    // Header
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '12px';

    const badge = document.createElement('div');
    badge.textContent = '🛡️';
    badge.style.fontSize = '26px';

    const titleContainer = document.createElement('div');

    const subtitle = document.createElement('div');
    subtitle.textContent = 'PRAHARI OS v2.0 • Security Guard';
    Object.assign(subtitle.style, {
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.05em',
      color: '#60a5fa',
      textTransform: 'uppercase',
      marginBottom: '2px',
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = options.title;
    Object.assign(titleEl.style, {
      fontWeight: '700',
      fontSize: '16px',
      color: '#f8fafc',
      lineHeight: '1.3',
    });

    titleContainer.appendChild(subtitle);
    titleContainer.appendChild(titleEl);
    header.appendChild(badge);
    header.appendChild(titleContainer);
    modal.appendChild(header);

    // Details box
    const detailsBox = document.createElement('div');
    Object.assign(detailsBox.style, {
      background: 'rgba(15, 23, 42, 0.8)',
      borderRadius: '10px',
      padding: '14px 16px',
      border: '1px solid #334155',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      fontSize: '13px',
    });

    for (const d of options.details) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'baseline';
      row.style.gap = '12px';

      const lbl = document.createElement('span');
      lbl.textContent = d.label + ':';
      lbl.style.color = '#94a3b8';
      lbl.style.fontWeight = '600';
      lbl.style.fontSize = '12px';

      const val = document.createElement('span');
      val.textContent = d.value;
      val.style.color = '#e2e8f0';
      val.style.fontWeight = '700';
      val.style.wordBreak = 'break-word';

      row.appendChild(lbl);
      row.appendChild(val);
      detailsBox.appendChild(row);
    }

    modal.appendChild(detailsBox);

    if (options.note) {
      const noteEl = document.createElement('div');
      noteEl.textContent = options.note;
      Object.assign(noteEl.style, {
        fontSize: '12px',
        color: '#94a3b8',
        background: 'rgba(59, 130, 246, 0.1)',
        border: '1px solid rgba(59, 130, 246, 0.2)',
        borderRadius: '8px',
        padding: '10px 12px',
        lineHeight: '1.4',
      });
      modal.appendChild(noteEl);
    }

    // Action buttons
    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '10px';
    btnRow.style.marginTop = '4px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = options.cancelText;
    Object.assign(cancelBtn.style, {
      padding: '9px 18px',
      borderRadius: '8px',
      border: '1px solid #475569',
      background: '#334155',
      color: '#f1f5f9',
      fontWeight: '600',
      fontSize: '13px',
      cursor: 'pointer',
      transition: 'all 0.15s ease',
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = options.confirmText;
    Object.assign(confirmBtn.style, {
      padding: '9px 18px',
      borderRadius: '8px',
      border: 'none',
      background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
      color: '#ffffff',
      fontWeight: '700',
      fontSize: '13px',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)',
      transition: 'all 0.15s ease',
    });

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.onclick = () => cleanup(false);
    confirmBtn.onclick = () => cleanup(true);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}

/**
 * Non-blocking confirmation for high-risk actions.
 */
function confirmHighRisk(action: Action, el: Element | null): Promise<boolean> {
  const what = action.op.toUpperCase();
  const where = el === null ? 'the page' : describe(el);
  return showDOMConfirmModal({
    title: 'HIGH-RISK ACTION CONFIRMATION',
    details: [
      { label: 'Action', value: what },
      { label: 'Target', value: where },
      { label: 'Site', value: location.hostname },
    ],
    confirmText: 'Allow Action',
    cancelText: 'Cancel',
  });
}

function describe(el: Element): string {
  const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60);
  return el.tagName.toLowerCase() + (name.length > 0 ? ' "' + name + '"' : '');
}

/** React, Vue, Angular, and Google Forms ignore plain `el.value = x`; setter + events works. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  let valToSet = value;
  if (el instanceof HTMLInputElement && el.type === 'date') {
    const parts = value.trim().split(/[\s/-]+/);
    if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      const [p1, p2, p3] = parts;
      valToSet = p3.length === 4 ? `${p3}-${p2.padStart(2, '0')}-${p1.padStart(2, '0')}` : `${p1}-${p2.padStart(2, '0')}-${p3.padStart(2, '0')}`;
    }
  }

  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) {
    setter.call(el, valToSet);
  } else {
    el.value = valToSet;
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: valToSet, inputType: 'insertText' }));
  } catch {
    /* fallback */
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function extractElementData(
  el: Element,
  fields?: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const requestedFields =
    fields && fields.length > 0
      ? fields
      : ['text'];

  for (const field of requestedFields) {
    switch (field) {
      case 'text':
        result.text = (el.textContent ?? '').trim();
        break;

      case 'value':
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          result.value = el.value;
        }
        break;

      case 'html':
        result.html = el.innerHTML;
        break;

      case 'aria-label':
        result['aria-label'] = el.getAttribute('aria-label');
        break;

      case 'placeholder':
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          result.placeholder = el.placeholder;
        }
        break;

      default:
        result[field] = el.getAttribute(field);
    }
  }

  return result;
}

export async function execute(action: Action): Promise<ActionResult> {
  const target = 'target' in action ? action.target : undefined;
  const el = resolve(target);

  if (target !== undefined && el === null) {
    return { outcome: 'error', detail: 'target no longer on the page' };
  }

  // --- risk gate -------------------------------------------------------------
  const clientRisk = liveRisk(el, action);
  const serverRisk = 'risk' in action && action.risk !== undefined ? action.risk : 'safe';
  // Escalation only. Taking the max is the whole enforcement of RULES.md S2.
  const effective: Risk = RISK_ORDER[serverRisk] > RISK_ORDER[clientRisk] ? serverRisk : clientRisk;

  if (effective === 'high' && !(await confirmHighRisk(action, el))) {
    return { outcome: 'blocked', detail: 'user declined a high-risk action' };
  }

  // --- dispatch --------------------------------------------------------------
  try {
    switch (action.op) {
      case 'scroll': {
  if (action.direction === 'to_element' && el !== null) {
    el.scrollIntoView({
      behavior: 'auto',
      block: 'center',
    });

    await settle(400);

    return { outcome: 'advanced' };
  }

  const before = window.scrollY;

  // Default: move almost one full screen at a time
  const amount = action.amount ?? Math.floor(window.innerHeight * 0.8);

  const dx =
    action.direction === 'left'
      ? -amount
      : action.direction === 'right'
        ? amount
        : 0;

  const dy =
    action.direction === 'up'
      ? -amount
      : action.direction === 'down'
        ? amount
        : 0;

  // IMPORTANT: no smooth scrolling for an agent
  window.scrollBy({
    top: dy,
    left: dx,
    behavior: 'auto',
  });

  // Let the page layout settle before the next observation
  await settle(500);

  const after = window.scrollY;

  console.log(
    'PRAHARI SCROLL:',
    'before=', before,
    'after=', after,
    'requested=', dy,
    'max=',
    document.documentElement.scrollHeight - window.innerHeight,
  );

  return {
    outcome: Math.abs(after - before) > 5
      ? 'advanced'
      : 'no_change',
  };
}

      case 'click': {
        if (el === null) return { outcome: 'error', detail: 'Target element not found on page' };
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: 'center' });
          await settle(80);
          el.focus({ preventScroll: true });
          el.click();
        } else if (el instanceof Element) {
          el.scrollIntoView({ block: 'center' });
          await settle(80);
          (el as HTMLElement).focus?.({ preventScroll: true });
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        await settle(150);
        return { outcome: 'advanced' };
      }

      case 'type': {
        let value = action.value ?? '';

        if (action.value_ref !== undefined) {
          const vault = currentVault();
          if (vault === null) {
            return { outcome: 'blocked', detail: 'no vault for this session' };
          }
          if (typeof target !== 'string') {
            // A coordinate target has no stable identity to bind a token to, so it can
            // never be an allowed sink.
            return { outcome: 'blocked', detail: 'refused to resolve a token into a point target' };
          }

          const resolved = vault.detokenize(action.value_ref, {
            elementId: target,
            origin: location.origin,
          });

          if (!resolved.ok) {
            // P5: refuse, log, and tell the user what was attempted. This is the branch
            // that fires when an injected instruction tries to exfiltrate a value.
            return {
              outcome: 'blocked',
              detail: explainViolation(resolved.reason, action.value_ref, target),
            };
          }

          if (resolved.confirmRequired && !(await confirmDetokenize(resolved.cls, resolved.value, el))) {
            return { outcome: 'blocked', detail: 'user declined to release a ' + resolved.cls };
          }

          value = resolved.value;
        }

        // S5: verify the server did not send a raw un-vaulted token syntax string as a literal.
        if (action.value_ref === undefined && isToken(value)) {
          return { outcome: 'blocked', detail: 'token supplied as a literal value' };
        }

        let targetInput: HTMLInputElement | HTMLTextAreaElement | null = null;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          targetInput = el;
        } else if (el instanceof HTMLElement) {
          targetInput =
            el.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
            el.closest('[role=listitem], [role=group], .geS5n, .Qr7Oae, .form-group, .field, fieldset')?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
            el.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
            null;
        }

        if (targetInput === null && el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('role') === 'textbox')) {
          el.scrollIntoView({ block: 'center' });
          el.focus({ preventScroll: true });
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          await settle(80);
          return { outcome: 'advanced' };
        }

        if (el instanceof HTMLSelectElement) {
          const val = value.toLowerCase();
          const option = [...el.options].find(
            (o) => o.value.toLowerCase().includes(val) || o.text.toLowerCase().includes(val)
          ) ?? el.options[1] ?? el.options[0];
          if (option) {
            el.value = option.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await settle(80);
          return { outcome: 'advanced' };
        }

        if (targetInput === null) {
          return { outcome: 'error', detail: 'target element is not a text field' };
        }

        targetInput.scrollIntoView({ block: 'center' });
        targetInput.focus({ preventScroll: true });
        if (action.clear_first === true) setNativeValue(targetInput, '');
        setNativeValue(targetInput, value);
        await settle(80);
        return { outcome: 'advanced' };
      }

      case 'select': {
        if (!(el instanceof HTMLSelectElement)) {
          return { outcome: 'error', detail: 'target is not a select' };
        }
        const option = [...el.options].find(
          (o) => o.value === action.option || o.text.trim() === action.option,
        );
        if (option === undefined) return { outcome: 'no_change', detail: 'option not found' };
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { outcome: 'advanced' };
      }

      case 'key': {
        const active = (document.activeElement ?? document.body) as HTMLElement;
        active.dispatchEvent(new KeyboardEvent('keydown', { key: action.combo, bubbles: true }));
        active.dispatchEvent(new KeyboardEvent('keyup', { key: action.combo, bubbles: true }));
        return { outcome: 'advanced' };
      }

      case 'wait': {
        await settle(Math.min(action.ms ?? 500, 5000));
        return { outcome: 'no_change' };
      }

      case 'navigate':
        // Deliberately not implemented in the skeleton. Navigation from a server
        // instruction is the highest-value target for prompt injection, and it needs
        // the confirm modal and origin policy from Phase 4 first.
        return { outcome: 'blocked', detail: 'navigate is disabled until the risk modal ships' };

case 'extract': {
  const extracted: Record<string, unknown> = {};

  for (const target of action.targets) {
    const element = resolve(target);

    if (element === null) {
      extracted[String(target)] = {
        error: 'target no longer on page',
      };
      continue;
    }

    extracted[String(target)] = extractElementData(
      element,
      action.fields
    );
  }

  return {
    outcome: 'advanced',
    detail: 'extracted requested page data',
    data: extracted,
  };
}

case 'ask_user': {
  const result: ActionResult = {
    outcome: 'advanced',
    question: action.question,
  };

  if (action.options !== undefined) {
    result.options = action.options;
  }

  return result;
}

case 'done':
  return {
    outcome: 'advanced',
    detail: action.summary ?? 'Task complete',
  };

case 'fail':
  return {
    outcome: 'error',
    detail: action.reason ?? 'Agent reported task failure',
  };

      default: {
        const _never: never = action;
        void _never;
        return { outcome: 'error', detail: 'unknown op' };
      }
    }
  } catch (err) {
    // P9: never surface the message; a DOM exception can carry page text.
    return { outcome: 'error', detail: err instanceof Error ? err.name : 'Error' };
  }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Plain-language reason a token was refused, safe to show the user. */
function explainViolation(reason: SinkViolation, token: string, sink: string): string {
  switch (reason) {
    case 'SINK_NOT_ALLOWED':
      return (
        'REFUSED: ' + token + ' is bound to the field it came from, and ' + sink +
        ' is not that field. This is the defence against a page tricking the agent ' +
        'into typing your data somewhere it can be read.'
      );
    case 'NOT_REVERSIBLE':
      return 'REFUSED: ' + token + ' is a credential. Its real value was never stored.';
    case 'ORIGIN_CHANGED':
      return 'REFUSED: the page changed origin since ' + token + ' was created.';
    case 'EXPIRED':
      return 'REFUSED: ' + token + ' has expired. Re-observe the page first.';
    case 'UNKNOWN_TOKEN':
      return 'REFUSED: ' + token + ' was never issued by this session.';
  }
}

/**
 * Confirmation before a high-sensitivity value is released into a field.
 *
 * Shows a MASKED form of the value: enough for the user to recognise it, not enough
 * for a shoulder-surfer. Uses a non-blocking in-page DOM modal so tab switching works.
 */
function confirmDetokenize(cls: string, value: string, el: Element | null): Promise<boolean> {
  return showDOMConfirmModal({
    title: `PRAHARI is about to fill in your ${cls}`,
    details: [
      { label: 'Value', value: maskValue(value) },
      { label: 'Field', value: el === null ? 'unknown' : describe(el) },
      { label: 'Site', value: location.hostname },
    ],
    note: 'The server never saw this value — it asked for it by reference.',
    confirmText: 'Release Value',
    cancelText: 'Cancel',
  });
}

function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

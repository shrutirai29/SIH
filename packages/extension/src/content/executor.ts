import type { Action, Risk, Target } from '@prahari/ssg';
import { isToken } from '@prahari/ssg';
import { containsPii } from '@prahari/kavach/detectors';
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
  // A stale id means the page re-rendered or navigated under us. Re-observing is
  // correct; guessing a similar-looking element is how agents click the wrong button.
  return el !== null && el.isConnected ? el : null;
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
 * Blocking confirmation for high-risk actions.
 *
 * `window.confirm` is a placeholder for the real modal (ticket E3), which shows the
 * target's screenshot crop and the masked value. It is used here because it is
 * genuinely blocking and cannot be dismissed by page script - which is the property
 * that matters most.
 */
function confirmHighRisk(action: Action, el: Element | null): boolean {
  const what = action.op.toUpperCase();
  const where = el === null ? 'the page' : describe(el);
  return window.confirm(
    'PRAHARI wants to perform a HIGH-RISK action.\n\n' +
      'Action: ' + what + '\n' +
      'Target: ' + where + '\n' +
      'Site:   ' + location.hostname + '\n\n' +
      'Allow this?',
  );
}

function describe(el: Element): string {
  const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60);
  return el.tagName.toLowerCase() + (name.length > 0 ? ' "' + name + '"' : '');
}

/** React and Vue ignore `el.value = x`; the native setter plus an InputEvent works. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

  if (effective === 'high' && !confirmHighRisk(action, el)) {
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
        if (el === null) return { outcome: 'error', detail: 'no target' };
        const isDisabled =
          (el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement) &&
          el.disabled;
        if (isDisabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) {
          return { outcome: 'no_change', detail: 'target element is disabled' };
        }
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: 'center' });
          await settle(80);
          el.focus({ preventScroll: true });
          el.click();
        }
        await settle(150);
        return { outcome: 'advanced' };
      }

      case 'type': {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          return { outcome: 'error', detail: 'target is not a text field' };
        }

        // ---- THE REVERSE CHANNEL ------------------------------------------
        // The server said "type ⟦AADHAAR_1⟧ here". It does not know the digits and
        // never will. Only this tab can resolve the token, and only into the field
        // the value came from.
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

          if (resolved.confirmRequired && !confirmDetokenize(resolved.cls, resolved.value, el)) {
            return { outcome: 'blocked', detail: 'user declined to release a ' + resolved.cls };
          }

          value = resolved.value;
        }

        // S5: the server must not fabricate an identifier for us to type. Checked only
        // on LITERALS - a value that came out of the vault is the user's own and is
        // supposed to look like PII.
        if (action.value_ref === undefined) {
          if (containsPii(value)) {
            return { outcome: 'blocked', detail: 'refused a literal PII value from the server' };
          }
          if (isToken(value)) {
            return { outcome: 'blocked', detail: 'token supplied as a literal value' };
          }
        }

        el.scrollIntoView({ block: 'center' });
        el.focus({ preventScroll: true });
        if (action.clear_first === true) setNativeValue(el, '');
        setNativeValue(el, value);
        await settle(80);
        // Read-back verification (Ticket E8): verify target received value
        // Note: verified locally inside tab without logging or leaking secrets.
        if (el.value !== value) {
          return { outcome: 'no_change', detail: 'field value was not updated' };
        }
        return { outcome: 'advanced' };
      }

      case 'select': {
        if (!(el instanceof HTMLSelectElement)) {
          return { outcome: 'error', detail: 'target is not a select' };
        }
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) {
          return { outcome: 'no_change', detail: 'target element is disabled' };
        }
        const option = [...el.options].find(
          (o) => o.value === action.option || o.text.trim() === action.option,
        );
        if (option === undefined) return { outcome: 'no_change', detail: 'option not found' };
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Read-back verification
        if (el.value !== option.value) {
          return { outcome: 'no_change', detail: 'select option could not be set' };
        }
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
    outcome: 'no_change',
    detail: 'awaiting user interaction',
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
 * for a shoulder-surfer. Ticket E3 replaces this with the real modal.
 */
function confirmDetokenize(cls: string, value: string, el: Element | null): boolean {
  return window.confirm(
    'PRAHARI is about to fill in your ' + cls + '.\n\n' +
      'Value: ' + maskValue(value) + '\n' +
      'Field: ' + (el === null ? 'unknown' : describe(el)) + '\n' +
      'Site:  ' + location.hostname + '\n\n' +
      'The server never saw this value — it asked for it by reference.\n\nRelease it?',
  );
}

function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

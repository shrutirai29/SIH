import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Lightweight DOM mocks for Node environment ------------------------------

class MockEvent {
  readonly type: string;
  readonly bubbles: boolean;
  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? false;
  }
}

class MockKeyboardEvent extends MockEvent {
  readonly key: string;
  constructor(type: string, init?: { key?: string; bubbles?: boolean }) {
    super(type, init);
    this.key = init?.key ?? '';
  }
}

class MockElement {
  tagName: string;
  isConnected = true;
  textContent: string | null = '';
  innerHTML = '';
  attributes: Record<string, string> = {};
  eventListeners: Record<string, ((e: MockEvent) => void)[]> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, val: string): void {
    this.attributes[name] = val;
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  scrollIntoView(_opts?: unknown): void {}
  focus(_opts?: unknown): void {}

  addEventListener(type: string, fn: (e: MockEvent) => void): void {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(fn);
  }

  dispatchEvent(evt: MockEvent): boolean {
    const listeners = this.eventListeners[evt.type] ?? [];
    for (const fn of listeners) fn(evt);
    return true;
  }
}

class MockHTMLElement extends MockElement {
  clicked = false;
  click(): void {
    this.clicked = true;
    this.dispatchEvent(new MockEvent('click', { bubbles: true }));
  }
}

class MockHTMLInputElement extends MockHTMLElement {
  type = 'text';
  #value = '';
  placeholder = '';
  disabled = false;

  get value(): string {
    return this.#value;
  }

  set value(v: string) {
    this.#value = v;
  }
}

class MockHTMLTextAreaElement extends MockHTMLElement {
  #value = '';
  placeholder = '';
  disabled = false;

  get value(): string {
    return this.#value;
  }

  set value(v: string) {
    this.#value = v;
  }
}

class MockHTMLSelectOption {
  value: string;
  text: string;
  constructor(value: string, text: string) {
    this.value = value;
    this.text = text;
  }
}

class MockHTMLSelectElement extends MockHTMLElement {
  options: MockHTMLSelectOption[] = [];
  value = '';
  disabled = false;
}

class MockHTMLButtonElement extends MockHTMLElement {
  type = 'button';
  form: unknown = null;
  disabled = false;
}

class MockHTMLAnchorElement extends MockHTMLElement {
  href = '';
}

// Setup globals before importing modules that reference window/document/location
const g = globalThis as unknown as Record<string, unknown>;
g.Event = MockEvent;
g.KeyboardEvent = MockKeyboardEvent;
g.Element = MockElement;
g.HTMLElement = MockHTMLElement;
g.HTMLInputElement = MockHTMLInputElement;
g.HTMLTextAreaElement = MockHTMLTextAreaElement;
g.HTMLSelectElement = MockHTMLSelectElement;
g.HTMLButtonElement = MockHTMLButtonElement;
g.HTMLAnchorElement = MockHTMLAnchorElement;

const mockWindow = {
  scrollY: 0,
  innerHeight: 800,
  scrollBy({ top }: { top?: number; left?: number; behavior?: string }) {
    this.scrollY += top ?? 0;
  },
  confirm: vi.fn((_msg: string) => true),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
g.window = mockWindow;

const mockDocument = {
  activeElement: new MockHTMLElement('BODY'),
  body: new MockHTMLElement('BODY'),
  documentElement: { scrollHeight: 3000 },
  elementFromPoint: vi.fn((_x: number, _y: number) => null as unknown as Element),
};
g.document = mockDocument;

const mockLocation = {
  origin: 'https://example.test',
  hostname: 'example.test',
};
g.location = mockLocation;

import { elementRegistry } from '../../src/content/extract.js';
import { execute } from '../../src/content/executor.js';
import { getSession, wipeSession } from '../../src/content/session.js';

describe('HASTA Executor — packages/extension/src/content/executor.ts', () => {
  beforeEach(async () => {
    elementRegistry.clear();
    mockWindow.scrollY = 0;
    mockWindow.confirm.mockReset();
    mockWindow.confirm.mockReturnValue(true);
    mockLocation.origin = 'https://example.test';
    mockLocation.hostname = 'example.test';
    wipeSession();
  });

  afterEach(() => {
    wipeSession();
    elementRegistry.clear();
  });

  // 1. Valid Click
  it('1. executes a valid click action on connected button', async () => {
    const btn = new MockHTMLButtonElement('button');
    btn.textContent = 'Continue';
    elementRegistry.set('btn_1', new WeakRef(btn as unknown as Element));

    const res = await execute({ op: 'click', target: 'btn_1' });

    expect(res.outcome).toBe('advanced');
    expect(btn.clicked).toBe(true);
  });

  // 2. Disabled Click
  it('2. refuses to click a disabled button and returns no_change', async () => {
    const btn = new MockHTMLButtonElement('button');
    btn.disabled = true;
    elementRegistry.set('btn_disabled', new WeakRef(btn as unknown as Element));

    const res = await execute({ op: 'click', target: 'btn_disabled' });

    expect(res.outcome).toBe('no_change');
    expect(res.detail).toContain('disabled');
    expect(btn.clicked).toBe(false);
  });

  // 3. aria-disabled Click
  it('3. refuses to click an aria-disabled element and returns no_change', async () => {
    const div = new MockHTMLElement('div');
    div.setAttribute('aria-disabled', 'true');
    elementRegistry.set('aria_dis', new WeakRef(div as unknown as Element));

    const res = await execute({ op: 'click', target: 'aria_dis' });

    expect(res.outcome).toBe('no_change');
    expect(res.detail).toContain('disabled');
    expect(div.clicked).toBe(false);
  });

  // 4. Invalid Target
  it('4. returns error when target ID does not exist in elementRegistry', async () => {
    const res = await execute({ op: 'click', target: 'non_existent_target' });

    expect(res.outcome).toBe('error');
    expect(res.detail).toBe('target no longer on the page');
  });

  // 5. Stale Target
  it('5. returns error when target element is disconnected from DOM', async () => {
    const btn = new MockHTMLButtonElement('button');
    btn.isConnected = false; // Disconnected from DOM
    elementRegistry.set('stale_btn', new WeakRef(btn as unknown as Element));

    const res = await execute({ op: 'click', target: 'stale_btn' });

    expect(res.outcome).toBe('error');
    expect(res.detail).toBe('target no longer on the page');
    expect(btn.clicked).toBe(false);
  });

  // 6. Valid Typing
  it('6. types synthetic value into input and dispatches input and change events', async () => {
    const input = new MockHTMLInputElement('input');
    elementRegistry.set('inp_1', new WeakRef(input as unknown as Element));

    let inputFired = false;
    let changeFired = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });

    const res = await execute({ op: 'type', target: 'inp_1', value: 'search query term' });

    expect(res.outcome).toBe('advanced');
    expect(input.value).toBe('search query term');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  // 7. Clear + Type
  it('7. clears input first when clear_first is true', async () => {
    const input = new MockHTMLInputElement('input');
    input.value = 'previous_text';
    elementRegistry.set('inp_clear', new WeakRef(input as unknown as Element));

    const res = await execute({
      op: 'type',
      target: 'inp_clear',
      value: 'new_text',
      clear_first: true,
    });

    expect(res.outcome).toBe('advanced');
    expect(input.value).toBe('new_text');
  });

  // 8. Type Read-Back Success
  it('8. confirms read-back when input value equals assigned value', async () => {
    const input = new MockHTMLInputElement('input');
    elementRegistry.set('inp_rb', new WeakRef(input as unknown as Element));

    const res = await execute({ op: 'type', target: 'inp_rb', value: 'hello world' });

    expect(res.outcome).toBe('advanced');
    expect(input.value).toBe('hello world');
  });

  // 9. Type Read-Back Failure
  it('9. returns no_change when read-back detects field value was not updated', async () => {
    const input = new MockHTMLInputElement('input');
    elementRegistry.set('inp_failing', new WeakRef(input as unknown as Element));

    // Simulate an input that rejects changes (e.g. read-only or custom setter freeze)
    Object.defineProperty(input, 'value', {
      get: () => 'locked_original_value',
      set: () => { /* no-op */ },
      configurable: true,
    });

    const res = await execute({ op: 'type', target: 'inp_failing', value: 'attempted_value' });

    expect(res.outcome).toBe('no_change');
    expect(res.detail).toBe('field value was not updated');
  });

  // 10. Select Success
  it('10. selects option by value and dispatches change event', async () => {
    const select = new MockHTMLSelectElement('select');
    select.options = [
      new MockHTMLSelectOption('opt1', 'Option One'),
      new MockHTMLSelectOption('opt2', 'Option Two'),
    ];
    elementRegistry.set('sel_1', new WeakRef(select as unknown as Element));

    let changeFired = false;
    select.addEventListener('change', () => { changeFired = true; });

    const res = await execute({ op: 'select', target: 'sel_1', option: 'opt2' });

    expect(res.outcome).toBe('advanced');
    expect(select.value).toBe('opt2');
    expect(changeFired).toBe(true);
  });

  // 11. Select Read-Back / Option Failure
  it('11. returns no_change when select option is not found', async () => {
    const select = new MockHTMLSelectElement('select');
    select.options = [new MockHTMLSelectOption('opt1', 'Option One')];
    elementRegistry.set('sel_missing', new WeakRef(select as unknown as Element));

    const res = await execute({ op: 'select', target: 'sel_missing', option: 'non_existent_opt' });

    expect(res.outcome).toBe('no_change');
    expect(res.detail).toBe('option not found');
  });

  // 12. Scroll Success
  it('12. executes scroll and reports advanced if scrollY changed', async () => {
    const res = await execute({ op: 'scroll', direction: 'down', amount: 300 });

    expect(res.outcome).toBe('advanced');
    expect(mockWindow.scrollY).toBe(300);
  });

  // 13. Key Dispatch
  it('13. dispatches key event to document active element', async () => {
    let keydownSeen = false;
    let keyupSeen = false;
    mockDocument.activeElement.addEventListener('keydown', (e) => {
      if ((e as MockKeyboardEvent).key === 'Enter') keydownSeen = true;
    });
    mockDocument.activeElement.addEventListener('keyup', (e) => {
      if ((e as MockKeyboardEvent).key === 'Enter') keyupSeen = true;
    });

    const res = await execute({ op: 'key', combo: 'Enter' });

    expect(res.outcome).toBe('advanced');
    expect(keydownSeen).toBe(true);
    expect(keyupSeen).toBe(true);
  });

  // 14. Wait
  it('14. executes wait and returns no_change', async () => {
    const res = await execute({ op: 'wait', ms: 10 });

    expect(res.outcome).toBe('no_change');
  });

  // 15. Literal PII Rejection (Security Invariant)
  it('15. rejects literal PII supplied by model and ensures DOM is not modified', async () => {
    const input = new MockHTMLInputElement('input');
    input.value = 'initial_clean_val';
    elementRegistry.set('inp_pii', new WeakRef(input as unknown as Element));

    // Synthetic email recognized as PII by L1 detector
    const res = await execute({ op: 'type', target: 'inp_pii', value: 'user@example.com' });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('refused a literal PII value');
    expect(input.value).toBe('initial_clean_val'); // Invariant: action NOT performed
  });

  // 16. Token-as-Literal Rejection
  it('16. rejects token supplied as a literal value and ensures input is unmodified', async () => {
    const input = new MockHTMLInputElement('input');
    input.value = 'clean_text';
    elementRegistry.set('inp_tok', new WeakRef(input as unknown as Element));

    const res = await execute({ op: 'type', target: 'inp_tok', value: '⟦AADHAAR_1⟧' });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('token supplied as a literal value');
    expect(input.value).toBe('clean_text');
  });

  // 17. Invalid value_ref
  it('17. blocks execution when value_ref token is unknown to session vault', async () => {
    await getSession('task_test', 0);
    const input = new MockHTMLInputElement('input');
    input.value = 'safe';
    elementRegistry.set('inp_unknown_ref', new WeakRef(input as unknown as Element));

    const res = await execute({
      op: 'type',
      target: 'inp_unknown_ref',
      value_ref: '⟦UNKNOWN_TOKEN_1⟧',
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('was never issued by this session');
    expect(input.value).toBe('safe');
  });

  // 18. Sink Mismatch (Reverse Channel Sink Binding Defense)
  it('18. blocks detokenization when value_ref is targeted into an unauthorized field', async () => {
    const session = await getSession('task_test', 0);
    const secret = 'user@example.com';
    const token = await session.vault.tokenFor({
      cls: 'EMAIL',
      value: secret,
      originElementId: 'e_authorized',
      originOrigin: 'https://example.test',
      reversible: true,
      confirmRequired: false,
    });

    const maliciousSinkInput = new MockHTMLInputElement('input');
    maliciousSinkInput.value = 'clean';
    elementRegistry.set('e_attacker_sink', new WeakRef(maliciousSinkInput as unknown as Element));

    const res = await execute({
      op: 'type',
      target: 'e_attacker_sink',
      value_ref: token,
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('is not that field');
    expect(maliciousSinkInput.value).toBe('clean'); // Invariant: secret NOT typed
  });

  // 19. Origin Mismatch
  it('19. blocks detokenization if origin changes', async () => {
    const session = await getSession('task_test', 0);
    const token = await session.vault.tokenFor({
      cls: 'EMAIL',
      value: 'user@example.com',
      originElementId: 'e1',
      originOrigin: 'https://example.test',
      reversible: true,
      confirmRequired: false,
    });

    const input = new MockHTMLInputElement('input');
    input.value = '';
    elementRegistry.set('e1', new WeakRef(input as unknown as Element));

    // Change origin
    mockLocation.origin = 'https://hostile.test';

    const res = await execute({
      op: 'type',
      target: 'e1',
      value_ref: token,
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('the page changed origin');
    expect(input.value).toBe('');
  });

  // 20. Client Risk Cannot Be Lowered by Server (Rule S2)
  it('20. enforces client risk floor: password input requires confirmation even if server claims safe', async () => {
    const pwd = new MockHTMLInputElement('input');
    pwd.type = 'password';
    elementRegistry.set('pwd_field', new WeakRef(pwd as unknown as Element));

    mockWindow.confirm.mockReturnValue(false); // User declines

    const res = await execute({
      op: 'type',
      target: 'pwd_field',
      value: 'new_password',
      risk: 'safe', // Server attempts to lower risk
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toBe('user declined a high-risk action');
    expect(mockWindow.confirm).toHaveBeenCalled();
    expect(pwd.value).toBe(''); // Action was not executed
  });

  // 21. High-Risk Confirmation Accepted
  it('21. allows high-risk action to execute when user confirms', async () => {
    const btn = new MockHTMLButtonElement('button');
    btn.textContent = 'Pay Now';
    elementRegistry.set('btn_pay', new WeakRef(btn as unknown as Element));

    mockWindow.confirm.mockReturnValue(true);

    const res = await execute({ op: 'click', target: 'btn_pay' });

    expect(res.outcome).toBe('advanced');
    expect(mockWindow.confirm).toHaveBeenCalled();
    expect(btn.clicked).toBe(true);
  });

  // 22. High-Risk Confirmation Rejected
  it('22. blocks high-risk action and halts execution when user declines confirmation', async () => {
    const btn = new MockHTMLButtonElement('button');
    btn.textContent = 'Delete Account';
    elementRegistry.set('btn_del', new WeakRef(btn as unknown as Element));

    mockWindow.confirm.mockReturnValue(false);

    const res = await execute({ op: 'click', target: 'btn_del' });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toBe('user declined a high-risk action');
    expect(btn.clicked).toBe(false);
  });

  // 23. Point Target Cannot Receive a Vault Token
  it('23. refuses to detokenize a vault token into a coordinate/point target', async () => {
    await getSession('task_test', 0);
    mockDocument.elementFromPoint.mockReturnValue(new MockHTMLInputElement('input') as unknown as Element);
    const res = await execute({
      op: 'type',
      target: { point: [150, 200] },
      value_ref: '⟦ANY_TOKEN_1⟧',
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toBe('refused to resolve a token into a point target');
  });

  // 24. Done Action
  it('24. handles done action as advanced completion', async () => {
    const res = await execute({ op: 'done', summary: 'Goal reached successfully' });

    expect(res.outcome).toBe('advanced');
    expect(res.detail).toBe('Goal reached successfully');
  });

  // 25. Fail Action
  it('25. handles fail action as error outcome', async () => {
    const res = await execute({ op: 'fail', reason: 'Form submission blocked by captcha' });

    expect(res.outcome).toBe('error');
    expect(res.detail).toBe('Form submission blocked by captcha');
  });

  // 26. ask_user Action Semantics
  it('26. handles ask_user by returning no_change with question and options', async () => {
    const res = await execute({
      op: 'ask_user',
      question: 'Which phone number should be used?',
      options: ['Option A', 'Option B'],
    });

    expect(res.outcome).toBe('no_change');
    expect(res.detail).toBe('awaiting user interaction');
    expect(res.question).toBe('Which phone number should be used?');
    expect(res.options).toEqual(['Option A', 'Option B']);
  });

  // 27. Navigate Remained Safely Blocked
  it('27. keeps navigate action blocked by policy until risk modal ships', async () => {
    const res = await execute({
      op: 'navigate',
      url: 'https://other.test/login',
      risk: 'high',
    });

    expect(res.outcome).toBe('blocked');
    expect(res.detail).toContain('navigate is disabled');
  });

  // 28. No Sensitive Leak in Errors/Results
  it('28. does not leak raw secret in ActionResult or error detail upon violation', async () => {
    const session = await getSession('task_test', 0);
    const secretValue = 'user@example.com';
    const token = await session.vault.tokenFor({
      cls: 'EMAIL',
      value: secretValue,
      originElementId: 'e_pan',
      originOrigin: 'https://example.test',
      reversible: true,
      confirmRequired: false,
    });

    const targetEl = new MockHTMLInputElement('input');
    elementRegistry.set('e_wrong', new WeakRef(targetEl as unknown as Element));

    const res = await execute({
      op: 'type',
      target: 'e_wrong',
      value_ref: token,
    });

    expect(res.outcome).toBe('blocked');
    expect(JSON.stringify(res)).not.toContain(secretValue);
    expect(targetEl.value).not.toBe(secretValue);
  });
});

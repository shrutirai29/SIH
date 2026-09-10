/**
 * Task Progress Widget - Translucent Glass Grid Edition.
 *
 * Divided glass-tiled UI inspired by Watch Dogs grid interface:
 * - Translucent dark frosted glass backdrop (rgba(10, 15, 26, 0.82) + blur)
 * - Clean PRAHARI typography (no strange terms)
 * - 2x2 Divided Glass Tile Grid for execution steps (DOM, Privacy, AI Reasoning, Execution)
 * - Compact 340px width with crisp contrast
 */

import browser from 'webextension-polyfill';
import type { AgentState, MascotTaskItem } from '../../shared/messages.js';

export interface TaskWidgetOptions {
  onStartTask?: (goal: string) => void;
  onStopTask?: () => void;
  onToggleCollapse?: (collapsed: boolean) => void;
}

export class TaskProgressWidget {
  private element: HTMLElement;
  private options: TaskWidgetOptions;
  private isCollapsed = false;
  private tasks: MascotTaskItem[] = [];
  private currentState: AgentState | null = null;

  constructor(element: HTMLElement, options: TaskWidgetOptions = {}) {
    this.element = element;
    this.options = options;
    this.syncTasksFromAgentState({
      phase: 'idle',
      goal: '',
      step: 0,
      maxSteps: 10,
      redactionCount: 0,
      isMultiTabActive: false,
    });
    this.render();
  }

  public updateState(state: AgentState): void {
    this.currentState = state;
    this.syncTasksFromAgentState(state);
    this.render();
  }

  public setTasks(tasks: MascotTaskItem[]): void {
    this.tasks = tasks;
    this.render();
  }

  private syncTasksFromAgentState(state: AgentState): void {
    const taskList: MascotTaskItem[] = [];

    taskList.push({
      id: 'step-extract',
      label: 'DOM Perception',
      status:
        state.phase === 'observing'
          ? 'in_progress'
          : state.step > 0 || state.phase !== 'idle'
            ? 'completed'
            : 'pending',
      detail: state.phase === 'observing' ? 'Analyzing DOM...' : 'DOM Extracted',
    });

    taskList.push({
      id: 'step-kavach',
      label: 'Privacy Guard',
      status:
        state.phase === 'sanitizing'
          ? 'in_progress'
          : ['sending', 'thinking', 'acting', 'done'].includes(state.phase) || state.redactionCount > 0
            ? 'completed'
            : 'pending',
      detail:
        state.redactionCount > 0
          ? `${state.redactionCount} Tokenised`
          : '0 PII Leaked',
    });

    taskList.push({
      id: 'step-reasoning',
      label: 'AI Reasoning',
      status:
        ['sending', 'thinking'].includes(state.phase)
          ? 'in_progress'
          : state.phase === 'acting' || state.phase === 'done'
            ? 'completed'
            : state.phase === 'asking'
              ? 'in_progress'
              : 'pending',
      detail:
        state.phase === 'thinking'
          ? 'Generating plan...'
          : state.phase === 'asking'
            ? 'Awaiting input'
            : 'Planner Standby',
    });

    taskList.push({
      id: 'step-execution',
      label: 'Action Exec',
      status:
        state.phase === 'acting' || state.phase === 'asking'
          ? 'in_progress'
          : state.phase === 'done'
            ? 'completed'
            : state.phase === 'error' || state.phase === 'blocked'
              ? 'failed'
              : 'pending',
      detail: state.message || (state.phase === 'done' ? 'Goal Finished' : 'Ready for prompt'),
    });

    this.tasks = taskList;
  }

  public render(): void {
    const phase = this.currentState?.phase;
    const isWorking = this.currentState && !['idle', 'done', 'error', 'blocked'].includes(phase ?? 'idle');
    const isError = phase === 'error' || phase === 'blocked';
    const goalText = this.currentState?.goal || 'Assistant Standby';
    const statusText = this.currentState?.message || (isWorking ? 'Processing...' : isError ? 'Task Blocked' : 'Idle');
    const tabNum = this.currentState?.tabNumber ?? 1;

    this.element.className = `prahari-task-widget ${this.isCollapsed ? 'collapsed' : ''}`;
    this.element.innerHTML = `
      <div class="prahari-widget-card watchdogs-hud">
        <!-- Watch Dogs Style Top Header Bar -->
        <div class="hud-top-bar">
          <div class="hud-top-left">
            <span class="hud-os-symbol">❖</span>
            <span class="hud-os-title">PRAHARI OS</span>
            <span class="hud-os-ver">v2.0</span>
          </div>
          <div class="hud-top-right">
            <span class="hud-tab-chip">TAB #${tabNum}</span>
            <span class="hud-status-badge ${isError ? 'err' : isWorking ? 'active' : 'idle'}">
              ${isError ? 'ERROR' : isWorking ? 'BUSY' : 'IDLE'}
            </span>
            <button class="btn-icon collapse-btn" title="${this.isCollapsed ? 'Expand HUD' : 'Minimize HUD'}">
              ${this.isCollapsed ? '▲' : '▼'}
            </button>
          </div>
        </div>

        ${
          this.isCollapsed
            ? ''
            : `
          <div class="hud-body">
            ${isError ? `
            <div class="hud-error-banner">
              <span class="hud-err-tag">[ALERT] SYSTEM FAILURE</span>
              <div class="hud-err-msg" title="${this.escapeHtml(statusText)}">${this.escapeHtml(statusText)}</div>
            </div>
            ` : ''}

            <!-- Target Objective Box -->
            <div class="hud-objective-tile">
              <span class="hud-tile-label">[TARGET OBJECTIVE]</span>
              <div class="hud-objective-text" title="${this.escapeHtml(goalText)}">${this.escapeHtml(goalText)}</div>
            </div>

            <!-- Conversational Q&A Card with Save Forever Option -->
            ${this.currentState?.pendingQuestion ? `
            <div class="hud-question-card">
              <div class="hud-q-header">
                <span class="hud-q-icon">🤖</span>
                <span class="hud-q-title">INPUT NEEDED</span>
              </div>
              <div class="hud-q-text">${this.escapeHtml(this.currentState.pendingQuestion.question)}</div>
              ${this.currentState.pendingQuestion.options && this.currentState.pendingQuestion.options.length > 0 ? `
                <div class="hud-q-options">
                  ${this.currentState.pendingQuestion.options.map(opt => `<button type="button" class="hud-q-opt-btn" data-opt="${this.escapeHtml(opt)}">${this.escapeHtml(opt)}</button>`).join('')}
                </div>
              ` : ''}
              <div class="hud-q-input-row">
                <input type="text" class="hud-q-text-input" placeholder="Type answer..." />
                <button type="button" class="hud-btn hud-q-submit-btn">[✓] SUBMIT</button>
              </div>
              <label class="hud-q-save-label">
                <input type="checkbox" class="hud-q-save-cb" checked />
                <span>💾 Save answer forever for future forms</span>
              </label>
            </div>
            ` : ''}

            <!-- 2x2 Watch Dogs Divided Tile Grid -->
            <div class="hud-grid-container">
              ${this.renderWatchDogsTile('DOM Vision', this.tasks[0], '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>', '01')}
              ${this.renderWatchDogsTile('Privacy Guard', this.tasks[1], '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><rect x="9" y="10" width="6" height="5" rx="1"/><path d="M10 10V8a2 2 0 0 1 4 0v2"/></svg>', '02')}
              ${this.renderWatchDogsTile('AI Reasoning', this.tasks[2], '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>', '03')}
              ${this.renderWatchDogsTile('Action Exec', this.tasks[3], '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', '04')}
            </div>

            <!-- Footer Bar with Controllers & Inputs -->
            <div class="hud-footer-controls">
              <div class="hud-masked-stat">
                <span class="hud-stat-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
                <span class="hud-stat-text">${this.currentState?.redactionCount ?? 0} MASKED</span>
              </div>
              <div class="hud-controls-right">
                ${
                  isWorking
                    ? `<button class="hud-btn hud-btn-stop">[X] STOP</button>`
                    : `<div class="hud-input-group">
                        <input type="text" class="hud-task-input" placeholder="Type prompt..." />
                        <button class="hud-btn hud-btn-run">[A] RUN</button>
                      </div>`
                }
              </div>
            </div>
          </div>
        `
        }
      </div>
    `;

    this.attachEvents();
  }

  private renderWatchDogsTile(title: string, task: MascotTaskItem | undefined, svgIcon: string, indexStr: string): string {
    if (!task) return '';
    const isDone = task.status === 'completed';
    const isProg = task.status === 'in_progress';
    const isFail = task.status === 'failed';

    const statusClass = isDone ? 'tile-done' : isProg ? 'tile-active' : isFail ? 'tile-fail' : 'tile-pending';
    const statusTag = isDone ? 'OK' : isProg ? 'RUN' : isFail ? 'ERR' : 'WAIT';

    const iconToShow = isDone
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : svgIcon;

    const detailString = this.escapeHtml(task.detail || (isDone ? 'Complete' : isProg ? 'Running' : 'Standby'));

    return `
      <div class="hud-tile-box ${statusClass}">
        <div class="tile-header-line">
          <span class="tile-index">${indexStr}</span>
          <span class="tile-title-text">${this.escapeHtml(title)}</span>
        </div>
        <div class="tile-center-content">
          <span class="tile-svg-icon">${iconToShow}</span>
        </div>
        <div class="tile-footer-line">
          <span class="tile-detail-text" title="${detailString}">${detailString}</span>
          <span class="tile-status-pill">${statusTag}</span>
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    const collapseBtn = this.element.querySelector('.collapse-btn');
    collapseBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isCollapsed = !this.isCollapsed;
      this.options.onToggleCollapse?.(this.isCollapsed);
      this.render();
    });

    const stopBtn = this.element.querySelector('.hud-btn-stop');
    stopBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabId = this.currentState?.tabId;
      if (tabId) {
        browser.runtime.sendMessage({ kind: 'STOP_TASK', tabId }).catch(() => {});
      }
    });

    const runBtn = this.element.querySelector('.hud-btn-run');
    const inputEl = this.element.querySelector('.hud-task-input') as HTMLInputElement | null;

    const triggerRun = () => {
      const val = inputEl?.value.trim();
      if (!val) return;

      const tabId = this.currentState?.tabId;

      // Update state locally immediately so HUD UI flips to active working phase instantly
      this.updateState({
        phase: 'observing',
        goal: val,
        step: 0,
        maxSteps: 10,
        redactionCount: this.currentState?.redactionCount ?? 0,
        isMultiTabActive: false,
        message: 'Starting task...',
      });

      browser.runtime
        .sendMessage({
          kind: 'START_TASK',
          goal: val,
          ...(typeof tabId === 'number' ? { tabId } : {}),
        })
        .catch((err) => {
          console.error('PRAHARI START_TASK message error:', err);
        });

      if (inputEl) inputEl.value = '';
    };

    runBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerRun();
    });

    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        triggerRun();
      }
    });

    // Wire up conversational Q&A from the floating HUD
    const q = this.currentState?.pendingQuestion;
    if (q) {
      const qInput = this.element.querySelector('.hud-q-text-input') as HTMLInputElement | null;
      const qSubmit = this.element.querySelector('.hud-q-submit-btn');
      const qSaveCb = this.element.querySelector('.hud-q-save-cb') as HTMLInputElement | null;
      const optBtns = this.element.querySelectorAll('.hud-q-opt-btn');

      const submitAnswer = (val: string) => {
        const clean = val.trim();
        if (!clean) return;
        const saveForever = qSaveCb?.checked ?? true;
        if (saveForever) {
          browser.runtime.sendMessage({
            kind: 'SAVE_FIELD',
            fieldKey: q.fieldKey,
            label: q.fieldKey,
            value: clean,
          }).catch(() => {});
        }
        browser.runtime.sendMessage({
          kind: 'ANSWER_QUESTION',
          tabId: this.currentState?.tabId,
          fieldKey: q.fieldKey,
          value: clean,
        }).catch(() => {});

        this.updateState({
          ...this.currentState!,
          phase: 'acting',
          message: `Filling: ${clean}`,
          pendingQuestion: undefined,
        });
      };

      qSubmit?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (qInput) submitAnswer(qInput.value);
      });

      qInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          if (qInput) submitAnswer(qInput.value);
        }
      });

      optBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const optVal = btn.getAttribute('data-opt');
          if (optVal) submitAnswer(optVal);
        });
      });
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

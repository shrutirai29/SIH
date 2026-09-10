/**
 * Floating Draggable Fox Mascot & Divided Tiled Glass HUD Overlay.
 *
 * Features:
 * - 3D Low-Poly Fennec Fox mascot
 * - Compact 24px bottom-left aligned tab badge (#1, #2, #3...)
 * - Tiled Glass HUD (Translucent dark rgba(10, 15, 26, 0.82) backdrop, 2x2 grid tile division)
 * - Automatic GET_TAB_INFO query on init so new tabs immediately display their unique sequential tab number
 */

import browser from 'webextension-polyfill';
import type { AgentPhase, AgentState, MascotMood } from '../../shared/messages.js';
import { TaskProgressWidget } from './task-widget.js';
import { LottieEffectsController } from './lottie-effects.js';

const HOST_ID = 'prahari-mascot-host';

export interface MascotTheme {
  name: string;
  numColor: string;
  badgeBg: string;
  badgeBorder: string;
}

const THEMES: MascotTheme[] = [
  {
    name: 'orange',
    numColor: '#ffffff',
    badgeBg: '#ea580c',
    badgeBorder: '#fb923c',
  },
  {
    name: 'purple',
    numColor: '#ffffff',
    badgeBg: '#7c3aed',
    badgeBorder: '#c084fc',
  },
  {
    name: 'cyan',
    numColor: '#ffffff',
    badgeBg: '#0891b2',
    badgeBorder: '#38bdf8',
  },
  {
    name: 'green',
    numColor: '#ffffff',
    badgeBg: '#16a34a',
    badgeBorder: '#4ade80',
  },
  {
    name: 'pink',
    numColor: '#ffffff',
    badgeBg: '#db2777',
    badgeBorder: '#f472b6',
  },
  {
    name: 'yellow',
    numColor: '#ffffff',
    badgeBg: '#ca8a04',
    badgeBorder: '#facc15',
  },
];

export class MascotOverlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private containerEl: HTMLElement | null = null;
  private mascotWrapEl: HTMLElement | null = null;
  private lottieWrapEl: HTMLElement | null = null;
  private tabBadgeTextEl: HTMLElement | null = null;
  private widgetEl: HTMLElement | null = null;
  private toastAreaEl: HTMLElement | null = null;

  private taskWidget: TaskProgressWidget | null = null;
  private lottieEffects: LottieEffectsController | null = null;

  private isVisible = false;
  private isWidgetOpen = false;
  private posX = 0;
  private posY = 24;
  private hasCustomPos = false;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialPosX = 0;
  private initialPosY = 0;

  private tabNumber: number = 1;
  private currentTheme: MascotTheme = THEMES[0]!;

  constructor() {
    this.posX = 0;
    this.posY = 24;
  }

  public toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  public show(): void {
    this.isVisible = true;
    this.ensureDom();
    if (this.host) {
      this.host.style.display = 'block';
      const mountTarget = document.body || document.documentElement;
      if (mountTarget && (!this.host.isConnected || this.host.parentElement !== mountTarget)) {
        mountTarget.appendChild(this.host);
      }
    }

    this.isWidgetOpen = true;
    this.updateWidgetVisibility();

    // Query tab info to ensure sequential tab number is set immediately
    this.fetchTabInfo();
  }

  public hide(): void {
    this.isVisible = false;
    if (this.host) this.host.style.display = 'none';
  }

  public getVisible(): boolean {
    return this.isVisible;
  }

  public setTabNumber(tabNumber: number): void {
    this.tabNumber = tabNumber;
    this.setTheme((tabNumber - 1) % THEMES.length);
    this.updateTabBadgeText();
  }

  public setTheme(themeIndex: number): void {
    const theme = THEMES[themeIndex % THEMES.length];
    if (!theme) return;
    this.currentTheme = theme;
    this.applyThemeStyle();
  }

  public setThemeByName(name: string): void {
    const idx = THEMES.findIndex((t) => t.name === name);
    if (idx >= 0) this.setTheme(idx);
  }

  private fetchTabInfo(): void {
    browser.runtime.sendMessage({ kind: 'GET_TAB_INFO' }).then((res) => {
      if (res && typeof (res as { tabNumber?: number }).tabNumber === 'number') {
        this.setTabNumber((res as { tabNumber: number }).tabNumber);
      }
    }).catch(() => {});

    browser.runtime.sendMessage({ kind: 'GET_STATE' }).then((res) => {
      if (res && (res as AgentState).phase) {
        this.updateState(res as AgentState);
      }
    }).catch(() => {});
  }

  private updateTabBadgeText(): void {
    if (this.tabBadgeTextEl) {
      this.tabBadgeTextEl.textContent = String(this.tabNumber);
    }
  }

  private applyThemeStyle(): void {
    if (!this.root) return;
    const badgeEl = this.root.querySelector('.mascot-tab-badge') as HTMLElement | null;

    if (badgeEl) {
      badgeEl.style.background = this.currentTheme.badgeBg;
      badgeEl.style.borderColor = this.currentTheme.badgeBorder;
      badgeEl.style.color = this.currentTheme.numColor;
    }
  }

  public updateState(state: AgentState): void {
    if (typeof state.tabNumber === 'number') {
      this.setTabNumber(state.tabNumber);
    }
    if (!this.isVisible) return;
    this.ensureDom();

    const mood = this.mapPhaseToMood(state.phase);

    // Update 3D Fennec Fox Lottie Mood Animation
    void this.lottieEffects?.playEffect(mood);

    if (mood !== 'idle') {
      this.isWidgetOpen = true;
    }
    this.updateWidgetVisibility();

    this.taskWidget?.updateState(state);
  }

  public showToast(notify: {
    tabId: number;
    tabTitle: string;
    phase: AgentPhase;
    message: string;
  }): void {
    this.ensureDom();
    if (!this.toastAreaEl) return;

    const toast = document.createElement('div');
    toast.className = `prahari-toast-card status-${notify.phase}`;

    const iconSvg =
      notify.phase === 'done'
        ? `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style="color: #3fb950;"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>`
        : notify.phase === 'interrupted'
          ? `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style="color: #d29922;"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`
          : `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style="color: #f85149;"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;

    const safeTitle = (notify.tabTitle || `Tab #${notify.tabId}`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const safeMsg = (notify.message || `Task reached ${notify.phase}`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    toast.innerHTML = `
      <div class="toast-header">
        <div class="toast-icon-title">
          ${iconSvg}
          <span class="toast-tab-title" title="${safeTitle}">${safeTitle}</span>
        </div>
        <button class="toast-close" title="Dismiss">×</button>
      </div>
      <div class="toast-body">${safeMsg}</div>
      <div class="toast-actions">
        <button class="toast-switch-btn">Switch to tab</button>
      </div>
    `;

    toast.querySelector('.toast-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.remove();
    });

    toast.querySelector('.toast-switch-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      browser.runtime.sendMessage({ kind: 'FOCUS_TAB', tabId: notify.tabId }).catch(() => {});
      toast.remove();
    });

    this.toastAreaEl.appendChild(toast);

    setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, 10000);
  }

  private updateWidgetVisibility(): void {
    if (this.widgetEl) {
      this.widgetEl.style.display = this.isWidgetOpen ? 'block' : 'none';
    }
  }

  private mapPhaseToMood(phase: AgentPhase): MascotMood {
    switch (phase) {
      case 'idle':
        return 'idle';
      case 'thinking':
        return 'thinking';
      case 'observing':
      case 'sanitizing':
      case 'sending':
      case 'acting':
        return 'working';
      case 'done':
        return 'success';
      case 'blocked':
      case 'error':
        return 'error';
      default:
        return 'idle';
    }
  }

  private ensureDom(): void {
    if (this.root !== null) {
      if (this.host && !this.host.isConnected) {
        (document.body || document.documentElement)?.appendChild(this.host);
      }
      return;
    }

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.setAttribute('data-prahari-ui', 'mascot');
    this.host.setAttribute('aria-label', 'PRAHARI Fox Assistant Mascot');
    this.host.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100vw',
      'height: 100vh',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');

    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = this.getStyles() + `
      <div id="prahari-mascot-container" class="mascot-container" style="${this.hasCustomPos ? `left: ${this.posX}px; top: ${this.posY}px; right: auto;` : 'right: 24px; top: 24px;'}">
        <div class="mascot-anchor">
          <div class="mascot-avatar-box" title="Click to toggle HUD / Drag to reposition">
            <div id="lottie-mascot-host" class="lottie-mascot-host"></div>
            <div class="mascot-tab-badge" title="Agent Tab #${this.tabNumber}">
              <span class="badge-num">${this.tabNumber}</span>
            </div>
          </div>
          <div id="task-widget-slot" class="task-widget-slot"></div>
        </div>
      </div>
      <div id="prahari-toast-area" class="toast-area"></div>
    `;

    const mountTarget = document.body || document.documentElement;
    if (mountTarget) {
      mountTarget.appendChild(this.host);
    }

    this.containerEl = this.root.querySelector('#prahari-mascot-container');
    this.mascotWrapEl = this.root.querySelector('.mascot-avatar-box');
    this.lottieWrapEl = this.root.querySelector('#lottie-mascot-host');
    this.tabBadgeTextEl = this.root.querySelector('.badge-num');
    this.widgetEl = this.root.querySelector('#task-widget-slot');
    this.toastAreaEl = this.root.querySelector('#prahari-toast-area');

    if (this.lottieWrapEl) {
      this.lottieEffects = new LottieEffectsController(this.lottieWrapEl);
    }

    if (this.widgetEl) {
      this.taskWidget = new TaskProgressWidget(this.widgetEl);
    }

    this.applyThemeStyle();
    this.updateTabBadgeText();
    this.fetchTabInfo();
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    window.addEventListener('mousemove', (e) => {
      if (!this.isVisible) return;
      this.lottieEffects?.updateCursorTracking(e.clientX, e.clientY);
    }, { passive: true });

    if (this.mascotWrapEl) {
      this.mascotWrapEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;

        if (!this.hasCustomPos && this.containerEl) {
          const rect = this.containerEl.getBoundingClientRect();
          this.posX = rect.left;
          this.posY = rect.top;
        }

        this.initialPosX = this.posX;
        this.initialPosY = this.posY;
        this.containerEl?.classList.add('dragging');
        e.preventDefault();
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.containerEl) return;

      const deltaX = e.clientX - this.dragStartX;
      const deltaY = e.clientY - this.dragStartY;

      let newX = this.initialPosX + deltaX;
      let newY = this.initialPosY + deltaY;

      const maxW = window.innerWidth - 180;
      const maxH = window.innerHeight - 180;

      newX = Math.max(12, Math.min(newX, Math.max(12, maxW)));
      newY = Math.max(12, Math.min(newY, Math.max(12, maxH)));

      this.hasCustomPos = true;
      this.posX = newX;
      this.posY = newY;
      this.containerEl.style.right = 'auto';
      this.containerEl.style.left = `${newX}px`;
      this.containerEl.style.top = `${newY}px`;
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) {
        const deltaX = Math.abs(e.clientX - this.dragStartX);
        const deltaY = Math.abs(e.clientY - this.dragStartY);

        this.isDragging = false;
        this.containerEl?.classList.remove('dragging');

        if (deltaX < 6 && deltaY < 6) {
          this.isWidgetOpen = !this.isWidgetOpen;
          this.updateWidgetVisibility();
        }
      }
    });

    window.addEventListener('resize', () => {
      if (!this.containerEl || !this.hasCustomPos) return;
      const maxW = window.innerWidth - 180;
      const maxH = window.innerHeight - 180;
      if (this.posX > maxW) {
        this.posX = Math.max(12, maxW);
        this.containerEl.style.left = `${this.posX}px`;
      }
      if (this.posY > maxH) {
        this.posY = Math.max(12, maxH);
        this.containerEl.style.top = `${this.posY}px`;
      }
    });
  }

  private getStyles(): string {
    return `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          color-scheme: dark;
        }

        .mascot-container {
          position: fixed;
          display: flex;
          align-items: flex-start;
          pointer-events: auto;
          user-select: none;
          z-index: 2147483647;
          transition: transform 0.1s ease-out;
        }

        .mascot-container.dragging {
          transition: none;
          cursor: grabbing;
        }

        .mascot-anchor {
          display: flex;
          flex-direction: row-reverse;
          align-items: flex-start;
          gap: 16px;
        }

        /* 3D Low-Poly Fennec Fox Mascot Box */
        .mascot-avatar-box {
          position: relative;
          width: 170px;
          height: 170px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.4));
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .mascot-avatar-box:hover {
          transform: scale(1.06);
        }

        .lottie-mascot-host {
          width: 100%;
          height: 100%;
          position: relative;
        }

        /* Compact 24px Bottom-Left Aligned Tab Badge */
        .mascot-tab-badge {
          position: absolute;
          bottom: 12px;
          left: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #ea580c;
          border: 2px solid #fb923c;
          color: #ffffff;
          font-size: 11px;
          font-weight: 900;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.8);
          transition: all 0.2s ease;
          z-index: 15;
        }

        /* TRANSLUCENT DARK FROSTED GLASS TASK WIDGET BOX WITH 3D HUD TILT */
        .task-widget-slot {
          position: relative;
          z-index: 10;
          perspective: 1000px;
        }

        .prahari-widget-card.watchdogs-hud {
          width: 360px;
          background: rgba(10, 14, 24, 0.82) !important;
          backdrop-filter: blur(18px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(18px) saturate(180%) !important;
          border: 1.5px solid rgba(255, 255, 255, 0.2) !important;
          border-radius: 6px;
          box-shadow: 0 28px 56px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.16) !important;
          overflow: hidden;
          color: #ffffff !important;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          transform: perspective(1000px) rotateY(7deg) rotateX(-3deg);
          transform-style: preserve-3d;
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
          animation: hudPopIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .prahari-widget-card.watchdogs-hud:hover {
          transform: perspective(1000px) rotateY(2deg) rotateX(-1deg) scale(1.02);
          box-shadow: 0 32px 64px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.24) !important;
        }

        @keyframes hudPopIn {
          from { opacity: 0; transform: perspective(1000px) rotateY(12deg) rotateX(-8deg) scale(0.92); }
          to { opacity: 1; transform: perspective(1000px) rotateY(7deg) rotateX(-3deg) scale(1); }
        }

        /* Watch Dogs Style Top Header Bar */
        .hud-top-bar {
          padding: 10px 14px;
          background: rgba(0, 0, 0, 0.6) !important;
          border-bottom: 1.5px solid rgba(255, 255, 255, 0.14) !important;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .hud-top-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .hud-os-symbol {
          color: #38bdf8;
          font-size: 14px;
          font-weight: 900;
        }

        .hud-os-title {
          font-weight: 800;
          font-size: 13px;
          letter-spacing: 1.2px;
          color: #ffffff;
          text-transform: uppercase;
        }

        .hud-os-ver {
          font-size: 10px;
          color: #94a3b8;
          font-weight: 700;
        }

        .hud-top-right {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .hud-tab-chip {
          font-size: 10px;
          font-weight: 800;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.25);
          color: #ffffff;
          padding: 3px 8px;
          border-radius: 3px;
          letter-spacing: 0.6px;
        }

        .hud-status-badge {
          font-size: 10px;
          font-weight: 800;
          padding: 3px 8px;
          border-radius: 3px;
          letter-spacing: 0.8px;
          text-transform: uppercase;
        }

        .hud-status-badge.idle { background: rgba(255, 255, 255, 0.1); color: #cbd5e1; }
        .hud-status-badge.active { background: rgba(56, 189, 248, 0.3); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5); }
        .hud-status-badge.err { background: rgba(239, 68, 68, 0.3); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.5); }

        .collapse-btn {
          background: transparent;
          border: none;
          color: #cbd5e1;
          cursor: pointer;
          font-size: 12px;
          padding: 2px 6px;
        }

        .collapse-btn:hover {
          color: #ffffff;
        }

        .hud-body {
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .hud-error-banner {
          background: rgba(239, 68, 68, 0.22);
          border: 1.5px solid rgba(239, 68, 68, 0.5);
          border-radius: 4px;
          padding: 8px 10px;
        }

        .hud-err-tag {
          font-size: 10px;
          font-weight: 900;
          color: #fca5a5;
          letter-spacing: 0.8px;
        }

        .hud-err-msg {
          font-size: 11px;
          color: #fecaca;
          margin-top: 3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Target Objective Box Tile */
        .hud-objective-tile {
          background: rgba(0, 0, 0, 0.45);
          border: 1.5px solid rgba(255, 255, 255, 0.16);
          padding: 10px 12px;
          border-radius: 4px;
        }

        .hud-tile-label {
          font-size: 11px;
          font-weight: 800;
          color: #38bdf8;
          letter-spacing: 1px;
          display: block;
          margin-bottom: 4px;
          text-transform: uppercase;
        }

        .hud-objective-text {
          font-size: 13px;
          font-weight: 600;
          color: #ffffff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* 2x2 Watch Dogs Grid Layout with Divided Tiles */
        .hud-grid-container {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .hud-tile-box {
          background: rgba(0, 0, 0, 0.42);
          border: 1.5px solid rgba(255, 255, 255, 0.16);
          border-radius: 4px;
          padding: 10px;
          height: 84px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          position: relative;
          overflow: hidden;
        }

        .hud-tile-box.tile-active {
          background: rgba(0, 240, 255, 0.18) !important;
          border-color: #00f0ff !important;
          box-shadow: 0 0 16px rgba(0, 240, 255, 0.35);
        }

        /* SOLID PURPLE FILL ONLY UPON COMPLETION */
        .hud-tile-box.tile-done {
          background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%) !important;
          border-color: #a855f7 !important;
          box-shadow: 0 4px 16px rgba(124, 58, 237, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;
        }

        .hud-tile-box.tile-fail {
          background: rgba(239, 68, 68, 0.18) !important;
          border-color: rgba(239, 68, 68, 0.5) !important;
        }

        .tile-header-line {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .tile-index {
          font-size: 11px;
          font-weight: 800;
          color: #64748b;
          flex-shrink: 0;
        }

        .tile-active .tile-index { color: #38bdf8; }
        .tile-done .tile-index { color: #f3e8ff; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }

        .tile-title-text {
          font-size: 11px;
          font-weight: 800;
          color: #ffffff;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tile-center-content {
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 2px 0;
        }

        .tile-svg-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #94a3b8;
          transition: color 0.2s ease, transform 0.2s ease;
        }

        .tile-active .tile-svg-icon {
          color: #00f0ff;
          filter: drop-shadow(0 0 6px rgba(0, 240, 255, 0.7));
        }

        .tile-done .tile-svg-icon {
          color: #ffffff;
          filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
        }

        .tile-fail .tile-svg-icon {
          color: #f87171;
        }

        .tile-footer-line {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          width: 100%;
          min-width: 0;
        }

        .tile-detail-text {
          font-size: 10px;
          font-weight: 600;
          color: #cbd5e1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }

        .tile-done .tile-detail-text {
          color: #f3e8ff;
          font-weight: 800;
        }

        .tile-status-pill {
          font-size: 9px;
          font-weight: 800;
          padding: 2px 5px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.08);
          color: #cbd5e1;
          letter-spacing: 0.4px;
          flex-shrink: 0;
        }

        .tile-done .tile-status-pill {
          background: #ffffff;
          color: #5b21b6;
          font-weight: 900;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
        }

        .tile-active .tile-status-pill { background: rgba(0, 240, 255, 0.3); color: #00f0ff; }
        .tile-fail .tile-status-pill { background: rgba(239, 68, 68, 0.3); color: #f87171; }

        /* Watch Dogs Style Controller Footer Bar */
        .hud-footer-controls {
          background: rgba(0, 0, 0, 0.45);
          border: 1.5px solid rgba(255, 255, 255, 0.14);
          padding: 8px 10px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .hud-masked-stat {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 900;
          color: #4ade80;
          letter-spacing: 0.6px;
        }

        .hud-controls-right {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .hud-input-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .hud-task-input {
          background: rgba(0, 0, 0, 0.6);
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          padding: 6px 10px;
          border-radius: 4px;
          width: 130px;
          outline: none;
        }

        .hud-task-input:focus {
          border-color: #38bdf8;
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
        }

        .hud-btn {
          border: none;
          font-size: 12px;
          font-weight: 900;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          letter-spacing: 0.8px;
          transition: all 0.18s ease;
        }

        .hud-btn-run {
          background: #16a34a;
          color: #ffffff;
          border: 1.5px solid #22c55e;
        }

        .hud-btn-run:hover {
          background: #15803d;
          box-shadow: 0 0 12px rgba(34, 197, 94, 0.5);
        }

        .hud-btn-stop {
          background: #dc2626;
          color: #ffffff;
          border: 1.5px solid #ef4444;
        }

        .hud-btn-stop:hover {
          background: #b91c1c;
          box-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
        }

        .hud-btn-stop {
          background: #dc2626;
          color: #ffffff;
          border: 1.5px solid #ef4444;
        }

        .hud-btn-stop:hover {
          background: #b91c1c;
          box-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
        }

        .hud-btn-stop:hover {
          background: #b91c1c;
        }

        /* Toast Notifications */
        .toast-area {
          position: fixed;
          bottom: 24px;
          right: 24px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          z-index: 2147483647;
          pointer-events: auto;
        }

        .prahari-toast-card {
          width: 320px;
          background: rgba(10, 15, 26, 0.92) !important;
          backdrop-filter: blur(12px) !important;
          border: 1px solid rgba(255, 255, 255, 0.14) !important;
          border-radius: 10px;
          padding: 12px;
          box-shadow: 0 16px 36px rgba(0,0,0,0.8);
          display: flex;
          flex-direction: column;
          gap: 6px;
          animation: toastIn 0.2s ease-out;
        }

        @keyframes toastIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .toast-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .toast-icon-title {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow: hidden;
        }

        .toast-tab-title {
          font-size: 12px;
          font-weight: 700;
          color: #f8fafc !important;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 230px;
        }

        .toast-close {
          background: transparent;
          border: none;
          color: #94a3b8;
          font-size: 16px;
          cursor: pointer;
        }

        .toast-body {
          font-size: 11px;
          color: #cbd5e1 !important;
          line-height: 1.4;
        }

        .toast-actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 4px;
        }

        .toast-switch-btn {
          background: rgba(59, 130, 246, 0.25);
          border: 1px solid rgba(59, 130, 246, 0.4);
          color: #93c5fd;
          font-size: 11px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 6px;
          cursor: pointer;
          transition: background 0.15s;
        }

        .toast-switch-btn:hover {
          background: rgba(59, 130, 246, 0.45);
          color: #ffffff;
        }
      </style>
    `;
  }
}

let instance: MascotOverlay | null = null;
export function getMascotOverlay(): MascotOverlay {
  if (instance === null) {
    instance = new MascotOverlay();
  }
  return instance;
}

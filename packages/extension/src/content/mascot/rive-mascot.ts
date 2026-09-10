/**
 * Interactive Rive Mascot with Dynamic Eye-Tracking & State Machine.
 *
 * Integrates @rive-app/canvas with cursor tracking (lookX, lookY) and
 * task state triggers (Idle, Working, Success, Error).
 * If the .riv binary is loading or placeholder, it automatically renders a
 * high-fidelity procedural canvas mascot with identical eye-tracking and state physics.
 */

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
import browser from 'webextension-polyfill';
import type { MascotMood } from '../../shared/messages.js';

export interface MascotPointerCoord {
  lookX: number; // -100 to 100
  lookY: number; // -100 to 100
}

export class RiveMascotController {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private riveInstance: Rive | null = null;
  private isRiveLoaded = false;
  private currentMood: MascotMood = 'idle';
  private targetLook: MascotPointerCoord = { lookX: 0, lookY: 0 };
  private currentLook: MascotPointerCoord = { lookX: 0, lookY: 0 };
  private blinkVal = 0;
  private blinkTimer = 0;
  private breathPhase = 0;
  private isDestroyed = false;
  private rafId: number | null = null;

  // Rive State Machine Inputs
  private inputLookX: { value: number } | null = null;
  private inputLookY: { value: number } | null = null;
  private triggerIdle: { fire: () => void } | null = null;
  private triggerWorking: { fire: () => void } | null = null;
  private triggerSuccess: { fire: () => void } | null = null;
  private triggerError: { fire: () => void } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.init();
  }

  private async init(): Promise<void> {
    const rivUrl = browser.runtime.getURL('assets/animations/mascot/mascot.riv');
    try {
      this.riveInstance = new Rive({
        src: rivUrl,
        canvas: this.canvas,
        autoplay: true,
        layout: new Layout({
          fit: Fit.Contain,
          alignment: Alignment.Center,
        }),
        onLoad: () => {
          this.isRiveLoaded = true;
          try {
            const smNames = this.riveInstance?.stateMachineNames || [];
            if (smNames.length > 0 && smNames[0]) {
              this.riveInstance?.play(smNames[0]);
            }
            this.bindRiveInputs();
          } catch (e) {
            console.warn('Rive state machine init error:', e);
          }
        },
        onLoadError: () => {
          this.isRiveLoaded = false;
          this.startProceduralLoop();
        },
      });
    } catch {
      this.isRiveLoaded = false;
      this.startProceduralLoop();
    }

    // Start rendering / interpolation loop
    this.startProceduralLoop();
  }

  private bindRiveInputs(): void {
    if (!this.riveInstance) return;
    try {
      const inputs = this.riveInstance.stateMachineInputs('State Machine 1') ||
                     this.riveInstance.stateMachineInputs('MascotState') ||
                     this.riveInstance.stateMachineInputs('MainMachine');
      if (inputs) {
        for (const input of inputs) {
          if (input.name === 'lookX' || input.name === 'mouseX' || input.name === 'numX') {
            this.inputLookX = input as unknown as { value: number };
          } else if (input.name === 'lookY' || input.name === 'mouseY' || input.name === 'numY') {
            this.inputLookY = input as unknown as { value: number };
          } else if (input.name === 'triggerIdle' || input.name === 'isIdle') {
            this.triggerIdle = input as unknown as { fire: () => void };
          } else if (input.name === 'triggerWorking' || input.name === 'isWorking') {
            this.triggerWorking = input as unknown as { fire: () => void };
          } else if (input.name === 'triggerSuccess' || input.name === 'isSuccess') {
            this.triggerSuccess = input as unknown as { fire: () => void };
          } else if (input.name === 'triggerError' || input.name === 'isError') {
            this.triggerError = input as unknown as { fire: () => void };
          }
        }
      }
    } catch {
      // Gracefully fall back to procedural
    }
  }

  /**
   * Update gaze vector based on mouse coordinates relative to mascot center.
   * @param mouseX Document screen X
   * @param mouseY Document screen Y
   */
  public updateCursorTracking(mouseX: number, mouseY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const dx = mouseX - centerX;
    const dy = mouseY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Normalize to -100..100 clamped with soft non-linear falloff
    const maxDistance = 600;
    const clampedDist = Math.min(dist, maxDistance);
    const scale = (clampedDist / maxDistance);

    this.targetLook = {
      lookX: dist > 0 ? (dx / dist) * scale * 100 : 0,
      lookY: dist > 0 ? (dy / dist) * scale * 100 : 0,
    };

    if (this.isRiveLoaded && this.inputLookX && this.inputLookY) {
      this.inputLookX.value = this.targetLook.lookX;
      this.inputLookY.value = this.targetLook.lookY;
    }
  }

  /** Set the runtime mood / task state */
  public setMood(mood: MascotMood): void {
    if (this.currentMood === mood) return;
    this.currentMood = mood;

    if (this.isRiveLoaded) {
      switch (mood) {
        case 'idle':
          this.triggerIdle?.fire?.();
          break;
        case 'working':
          this.triggerWorking?.fire?.();
          break;
        case 'success':
          this.triggerSuccess?.fire?.();
          break;
        case 'error':
          this.triggerError?.fire?.();
          break;
      }
    }
  }

  public getMood(): MascotMood {
    return this.currentMood;
  }

  /** Procedural Mascot Render Loop (Active when .riv is loading or as fallback) */
  private startProceduralLoop = (): void => {
    if (this.rafId !== null) return;

    const loop = () => {
      if (this.isDestroyed) return;

      // Smooth spring interpolation towards target gaze
      this.currentLook.lookX += (this.targetLook.lookX - this.currentLook.lookX) * 0.15;
      this.currentLook.lookY += (this.targetLook.lookY - this.currentLook.lookY) * 0.15;

      // Blinking physics
      this.blinkTimer++;
      if (this.blinkTimer > 180 + Math.random() * 80) {
        this.blinkVal = 1;
        this.blinkTimer = 0;
      }
      if (this.blinkVal > 0) {
        this.blinkVal -= 0.12;
        if (this.blinkVal < 0) this.blinkVal = 0;
      }

      this.breathPhase += 0.04;

      if (!this.isRiveLoaded && this.ctx) {
        this.renderProceduralMascot(this.ctx);
      }

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  };

  private renderProceduralMascot(ctx: CanvasRenderingContext2D): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2 + Math.sin(this.breathPhase) * 3;

    // Outer Glowing Shield Ring / Aura based on state
    let auraColor = 'rgba(78, 140, 255, 0.4)';
    let eyeColor = '#4E8CFF';
    let helmColor = '#1e293b';

    if (this.currentMood === 'working') {
      auraColor = 'rgba(251, 191, 36, 0.6)';
      eyeColor = '#FBBF24';
      helmColor = '#1f2430';
    } else if (this.currentMood === 'success') {
      auraColor = 'rgba(34, 197, 94, 0.6)';
      eyeColor = '#22C55E';
    } else if (this.currentMood === 'error') {
      auraColor = 'rgba(239, 68, 68, 0.6)';
      eyeColor = '#EF4444';
    }

    // Aura pulse
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 46 + Math.sin(this.breathPhase * 2) * 2, 0, Math.PI * 2);
    ctx.fillStyle = auraColor;
    ctx.filter = 'blur(8px)';
    ctx.fill();
    ctx.restore();

    // Robotic Helmet / Shell
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 40, 0, Math.PI * 2);
    const grad = ctx.createLinearGradient(cx - 30, cy - 30, cx + 30, cy + 30);
    grad.addColorStop(0, '#334155');
    grad.addColorStop(0.5, helmColor);
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fill();

    // Metallic Rim
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.currentMood === 'working' ? '#F59E0B' : '#64748B';
    ctx.stroke();
    ctx.restore();

    // Visor / Screen Face
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx - 28, cy - 18, 56, 36, 12);
    ctx.fillStyle = '#090d16';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.stroke();

    // Eye offsets mapped from gaze (-100..100) -> (-8..8 px)
    const eyeOffsetX = (this.currentLook.lookX / 100) * 8;
    const eyeOffsetY = (this.currentLook.lookY / 100) * 6;

    const leftEyeX = cx - 12 + eyeOffsetX;
    const rightEyeX = cx + 12 + eyeOffsetX;
    const eyeY = cy + eyeOffsetY;

    // Draw Dynamic Eyes with Blinking and Mood Expressions
    const eyeHeight = Math.max(1, 10 * (1 - this.blinkVal));
    const eyeRadius = 5;

    ctx.fillStyle = eyeColor;
    ctx.shadowColor = eyeColor;
    ctx.shadowBlur = 8;

    if (this.currentMood === 'success') {
      // Happy curved arch eyes
      ctx.lineWidth = 3;
      ctx.strokeStyle = eyeColor;
      ctx.beginPath();
      ctx.arc(leftEyeX, eyeY, 6, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(rightEyeX, eyeY, 6, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else if (this.currentMood === 'error') {
      // Alert X eyes
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = eyeColor;
      [-1, 1].forEach((dir) => {
        const ex = dir === -1 ? leftEyeX : rightEyeX;
        ctx.beginPath();
        ctx.moveTo(ex - 4, eyeY - 4);
        ctx.lineTo(ex + 4, eyeY + 4);
        ctx.moveTo(ex + 4, eyeY - 4);
        ctx.lineTo(ex - 4, eyeY + 4);
        ctx.stroke();
      });
    } else {
      // Standard oval expressive eyes
      ctx.beginPath();
      ctx.ellipse(leftEyeX, eyeY, eyeRadius, eyeHeight / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.ellipse(rightEyeX, eyeY, eyeRadius, eyeHeight / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Eye pupil catchlight
      if (this.blinkVal < 0.5) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(leftEyeX + 1.5, eyeY - 1.5, 1.5, 0, Math.PI * 2);
        ctx.arc(rightEyeX + 1.5, eyeY - 1.5, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Working scanning bar effect
    if (this.currentMood === 'working') {
      const scanX = cx - 24 + ((Math.sin(this.breathPhase * 4) + 1) / 2) * 48;
      ctx.fillStyle = 'rgba(251, 191, 36, 0.4)';
      ctx.fillRect(scanX - 2, cy - 16, 4, 32);
    }

    ctx.restore();

    // Decorative Top Antenna / Shield Light
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy - 42, 4, 0, Math.PI * 2);
    ctx.fillStyle = eyeColor;
    ctx.shadowColor = eyeColor;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.riveInstance?.cleanup();
    this.riveInstance = null;
  }
}

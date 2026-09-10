/**
 * Fox Lottie Mascot & Visual Effects Controller.
 *
 * Provides rich multi-state animations for the floating Fox mascot:
 * - Idle: Fox base animation ('fox-base.json') with real-time interactive mouse cursor eye tracking
 * - Thinking: Fox with rotating eye loading circle animation & radar scan orbit inside eye pupils
 * - Running Task: 'fox-running.json' with athletic running legs, cadence bounce, foot dust puffs, and speed dash lines
 * - Error: Fox with exclamation mark eyes '!' with pulsating red alert badges and recoil shake
 * - Success: Multiple rich celebration animations (Confetti Shower, Fireworks, Golden Shield, Joy Dance)
 */

import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light.js';
import type { MascotMood } from '../../shared/messages.js';
import foxBaseData from '../../../assets/animations/lottie/fox-base.json';
import foxRunningData from '../../../assets/animations/lottie/fox-running.json';

export type SuccessVariant = 'confetti' | 'fireworks' | 'golden_shield' | 'joy_dance';

export class LottieEffectsController {
  private container: HTMLElement;
  private lottieWrapper: HTMLElement | null = null;
  private currentAnim: AnimationItem | null = null;
  private currentMood: MascotMood = 'idle';
  private currentSuccessVariant: SuccessVariant = 'confetti';

  // Eye tracking coordinates for Fox
  private targetGazeX = 0;
  private targetGazeY = 0;
  private currentGazeX = 0;
  private currentGazeY = 0;

  // Dynamic Canvas Overlay for Eyes & Particles
  private fxCanvas: HTMLCanvasElement | null = null;
  private fxCtx: CanvasRenderingContext2D | null = null;
  private fxRafId: number | null = null;

  // Particle system
  private particles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    color: string;
    alpha: number;
    life: number;
    maxLife: number;
    shape?: 'circle' | 'rect' | 'star' | 'dust';
    rotation?: number;
    rotSpeed?: number;
  }> = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.setupDOM();
    this.loadAnimationForMood('idle');
  }

  private setupDOM(): void {
    this.container.style.position = 'relative';
    this.container.style.width = '100%';
    this.container.style.height = '100%';

    // Fox Lottie Host
    this.lottieWrapper = document.createElement('div');
    this.lottieWrapper.style.width = '100%';
    this.lottieWrapper.style.height = '100%';
    this.lottieWrapper.style.transformOrigin = '50% 50%';
    this.container.appendChild(this.lottieWrapper);

    // Dynamic Effects Canvas Overlay (Eyes & Particle Systems)
    this.fxCanvas = document.createElement('canvas');
    this.fxCanvas.width = 300;
    this.fxCanvas.height = 300;
    Object.assign(this.fxCanvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '15',
    });
    this.container.appendChild(this.fxCanvas);
    this.fxCtx = this.fxCanvas.getContext('2d');

    // Start effect render loop
    this.startFXLoop();
  }

  /** Load the appropriate Lottie animation data for state */
  private async loadAnimationForMood(mood: MascotMood): Promise<void> {
    if (!this.lottieWrapper) return;

    // Running state uses the keyframed running legs JSON, idle/others use foxBaseData
    const animData = (mood === 'working') ? foxRunningData : foxBaseData;

    try {
      if (this.currentAnim) {
        this.currentAnim.destroy();
        this.currentAnim = null;
      }

      this.currentAnim = lottie.loadAnimation({
        container: this.lottieWrapper,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: animData,
      });

      this.updateAnimationParameters(mood);
    } catch {
      // Fallback
      if (this.lottieWrapper) {
        this.lottieWrapper.innerHTML = '<div style="font-size:48px;text-align:center;line-height:90px;">🦊</div>';
      }
    }
  }

  /** Apply speed, filters and visual classes for the state without harsh colored glows */
  private updateAnimationParameters(mood: MascotMood): void {
    if (!this.currentAnim || !this.lottieWrapper) return;

    if (mood === 'working') {
      this.currentAnim.setSpeed(2.2);
    } else if (mood === 'thinking') {
      this.currentAnim.setSpeed(0.8);
    } else if (mood === 'success') {
      this.currentAnim.setSpeed(1.2);
    } else if (mood === 'error') {
      this.currentAnim.setSpeed(0.4);
    } else {
      this.currentAnim.setSpeed(1.0);
    }
    // Clean transparent mascot with natural shadow only, no artificial red/green glows
    this.lottieWrapper.style.filter = '';
  }

  /**
   * Update Fox cursor tracking / eye gaze vector.
   */
  public updateCursorTracking(mouseX: number, mouseY: number): void {
    if (this.currentMood !== 'idle') return;
    const rect = this.container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height * 0.45;

    const dx = mouseX - cx;
    const dy = mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxD = 600;
    const scale = Math.min(dist, maxD) / maxD;

    this.targetGazeX = dist > 0 ? (dx / dist) * scale : 0;
    this.targetGazeY = dist > 0 ? (dy / dist) * scale : 0;
  }

  /** Set mood state */
  public async playEffect(mood: MascotMood, successVariant?: SuccessVariant): Promise<void> {
    const isWorkingTransition = (mood === 'working' && this.currentMood !== 'working') ||
                                (mood !== 'working' && this.currentMood === 'working');
    this.currentMood = mood;

    if (successVariant) {
      this.currentSuccessVariant = successVariant;
    }

    // CSS class updates
    this.container.classList.remove(
      'prahari-fox-running',
      'prahari-fox-shake',
      'prahari-fox-bounce',
      'prahari-fox-pop'
    );

    if (mood === 'working') {
      this.container.classList.add('prahari-fox-running');
    } else if (mood === 'error') {
      this.container.classList.add('prahari-fox-shake');
    } else if (mood === 'success') {
      this.container.classList.add('prahari-fox-pop');
      this.triggerSuccessCelebration(this.currentSuccessVariant);
    }

    if (isWorkingTransition) {
      await this.loadAnimationForMood(mood);
    } else {
      this.updateAnimationParameters(mood);
    }
  }

  /** Set which success celebration animation to play */
  public setSuccessVariant(variant: SuccessVariant): void {
    this.currentSuccessVariant = variant;
  }

  /** Trigger particle explosion for success */
  public triggerSuccessCelebration(variant: SuccessVariant = this.currentSuccessVariant): void {
    if (!this.fxCanvas) return;
    const cx = this.fxCanvas.width / 2;
    const cy = this.fxCanvas.height / 2;

    switch (variant) {
      case 'confetti':
        this.spawnConfettiShower(cx, cy);
        break;
      case 'fireworks':
        this.spawnFireworks(cx, cy);
        break;
      case 'golden_shield':
        this.spawnGoldenShieldAura(cx, cy);
        break;
      case 'joy_dance':
        this.spawnJoyDanceParticles(cx, cy);
        break;
    }
  }

  /* ────────── Particle Spawners ────────── */

  private spawnConfettiShower(cx: number, cy: number): void {
    const colors = ['#f59e0b', '#22c55e', '#3b82f6', '#ec4899', '#8b5cf6', '#eab308'];
    for (let i = 0; i < 45; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 2 + Math.random() * 6;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 40,
        y: cy + (Math.random() - 0.5) * 40,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.5,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)] ?? '#22c55e',
        alpha: 1,
        life: 0,
        maxLife: 60 + Math.random() * 40,
        shape: Math.random() > 0.4 ? 'rect' : 'circle',
        rotation: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 0.2,
      });
    }
  }

  private spawnFireworks(cx: number, cy: number): void {
    const colors = ['#38bdf8', '#fbbf24', '#f472b6', '#34d399', '#a78bfa'];
    for (let burst = 0; burst < 3; burst++) {
      const bx = cx + (Math.random() - 0.5) * 80;
      const by = cy - 20 + (Math.random() - 0.5) * 60;
      const burstColor = colors[burst % colors.length] ?? '#38bdf8';
      for (let i = 0; i < 20; i++) {
        const angle = (Math.PI * 2 * i) / 20;
        const speed = 3 + Math.random() * 4;
        this.particles.push({
          x: bx,
          y: by,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 3 + Math.random() * 3,
          color: burstColor,
          alpha: 1,
          life: 0,
          maxLife: 45 + Math.random() * 25,
          shape: 'star',
          rotation: Math.random() * Math.PI,
          rotSpeed: 0.1,
        });
      }
    }
  }

  private spawnGoldenShieldAura(cx: number, cy: number): void {
    for (let i = 0; i < 30; i++) {
      const angle = (Math.PI * 2 * i) / 30;
      this.particles.push({
        x: cx,
        y: cy + 10,
        vx: Math.cos(angle) * 3,
        vy: Math.sin(angle) * 3,
        size: 5 + Math.random() * 4,
        color: '#fbbf24',
        alpha: 1,
        life: 0,
        maxLife: 55,
        shape: 'star',
        rotation: angle,
        rotSpeed: 0.05,
      });
    }
  }

  private spawnJoyDanceParticles(cx: number, cy: number): void {
    const colors = ['#ec4899', '#f43f5e', '#a855f7', '#60a5fa'];
    for (let i = 0; i < 25; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 60,
        y: cy + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 3,
        vy: -2 - Math.random() * 3,
        size: 4 + Math.random() * 4,
        color: colors[i % colors.length] ?? '#ec4899',
        alpha: 1,
        life: 0,
        maxLife: 50 + Math.random() * 30,
        shape: 'circle',
        rotation: 0,
        rotSpeed: 0,
      });
    }
  }

  /** Spawn running dust puff at fox's feet */
  private spawnRunningDust(): void {
    if (!this.fxCanvas || Math.random() > 0.35) return;
    const w = this.fxCanvas.width;
    const h = this.fxCanvas.height;
    this.particles.push({
      x: w * 0.44 + (Math.random() - 0.5) * 20,
      y: h * 0.82 + (Math.random() - 0.5) * 6,
      vx: -1.5 - Math.random() * 2,
      vy: -0.4 - Math.random() * 0.8,
      size: 4 + Math.random() * 5,
      color: 'rgba(251, 191, 36, 0.4)',
      alpha: 0.7,
      life: 0,
      maxLife: 25 + Math.random() * 15,
      shape: 'dust',
    });
  }

  /* ────────── Effect Render Loop ────────── */

  private startFXLoop(): void {
    const render = () => {
      if (!this.fxCtx || !this.fxCanvas) return;
      const ctx = this.fxCtx;
      const w = this.fxCanvas.width;
      const h = this.fxCanvas.height;
      ctx.clearRect(0, 0, w, h);

      const t = performance.now() / 1000;

      // 1. Idle State: Smooth Fox Eye / Head Gaze Tracking
      if (this.currentMood === 'idle') {
        this.currentGazeX += (this.targetGazeX - this.currentGazeX) * 0.12;
        this.currentGazeY += (this.targetGazeY - this.currentGazeY) * 0.12;
        if (this.lottieWrapper) {
          const svgEl = this.lottieWrapper.querySelector('svg');
          if (svgEl) {
            svgEl.style.transform = `translate(${this.currentGazeX * 4}px, ${this.currentGazeY * 3}px) rotate(${this.currentGazeX * 1.5}deg)`;
          }
        }
      } else if (this.lottieWrapper) {
        const svgEl = this.lottieWrapper.querySelector('svg');
        if (svgEl) {
          svgEl.style.transform = '';
        }
      }

      // 2. Thinking State: Eye Loading Circle Animation
      if (this.currentMood === 'thinking') {
        this.renderThinkingEyes(ctx, w, h, t);
      }

      // 3. Error State: Exclamation Mark Eyes
      if (this.currentMood === 'error') {
        this.renderErrorEyes(ctx, w, h, t);
      }

      // 4. Running State: Dust Puffs & Speed Lines
      if (this.currentMood === 'working') {
        this.spawnRunningDust();
        this.renderSpeedLines(ctx, w, h, t);
      }

      // 5. Update and Render Particles
      this.updateAndRenderParticles(ctx);

      this.fxRafId = requestAnimationFrame(render);
    };

    this.fxRafId = requestAnimationFrame(render);
  }

  /** Render rotating / pulsing loading circle in the fox's eyes */
  private renderThinkingEyes(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    // Exact positions visually anchored to the fox's facial eyes
    const eyePositions = [
      { x: w * 0.51, y: h * 0.505 },  // Left eye
      { x: w * 0.67, y: h * 0.465 },  // Right eye
    ];

    for (const pos of eyePositions) {
      ctx.save();
      ctx.translate(pos.x, pos.y);

      // Outer pulsing cyan glow
      ctx.beginPath();
      ctx.arc(0, 0, 10 + Math.sin(t * 4) * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.fill();

      // Dark iris background
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 6;
      ctx.fill();

      // Rotating Loading Arc 1 (Cyan)
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#38bdf8';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      const angle1 = t * 6;
      ctx.arc(0, 0, 5, angle1, angle1 + Math.PI * 1.2);
      ctx.stroke();

      // Counter-rotating Inner Dot / Arc 2 (White)
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const angle2 = -t * 8;
      ctx.arc(0, 0, 2.5, angle2, angle2 + Math.PI * 0.8);
      ctx.stroke();

      ctx.restore();
    }
  }

  /** Render exclamation marks covering fox's eyes in error state */
  private renderErrorEyes(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    // Exact eye positions visually anchored to the fox's facial eyes
    const eyePositions = [
      { x: w * 0.51, y: h * 0.505 },  // Left eye
      { x: w * 0.67, y: h * 0.465 },  // Right eye
    ];

    // Smooth gentle wobble (not harsh)
    const wobble = Math.sin(t * 8) * 1.2;

    for (const pos of eyePositions) {
      ctx.save();
      ctx.translate(pos.x + wobble, pos.y);

      // 1. Opaque fur-colored patch to hide the underlying Lottie eyes
      ctx.beginPath();
      ctx.ellipse(0, 0, 14, 10, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#f5c9a0'; // Fox face fur tone
      ctx.fill();

      // 2. Subtle eye outline
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(30, 27, 75, 0.6)';
      ctx.stroke();

      // 3. Red Exclamation Mark Bar (scaled to fit the eye)
      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = 'rgba(239, 68, 68, 0.5)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.roundRect(-2.5, -8, 5, 10, 2);
      ctx.fill();

      // 4. Exclamation Mark Dot
      ctx.beginPath();
      ctx.arc(0, 5, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  /** Render speed wind lines for running task */
  private renderSpeedLines(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    for (let i = 0; i < 4; i++) {
      const lineY = h * (0.35 + i * 0.14) + Math.sin(t * 10 + i) * 4;
      const speed = 120 + i * 40;
      const progress = ((t * speed) % (w * 0.6));
      const lineX = w * 0.8 - progress;
      const lineLen = 25 + (i % 2) * 20;

      ctx.beginPath();
      ctx.moveTo(lineX, lineY);
      ctx.lineTo(lineX - lineLen, lineY);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Update and render all active particles */
  private updateAndRenderParticles(ctx: CanvasRenderingContext2D): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;

      const progress = p.life / p.maxLife;
      const alpha = p.alpha * (1 - progress);

      if (p.life >= p.maxLife || alpha <= 0.01) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation || 0) + (p.rotSpeed || 0) * p.life);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else if (p.shape === 'star') {
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation || 0) + (p.rotSpeed || 0) * p.life);
        this.drawStar(ctx, 0, 0, 5, p.size, p.size * 0.45);
        ctx.fill();
      } else if (p.shape === 'dust') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + progress * 0.8), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 191, 36, ' + (0.35 * (1 - progress)) + ')';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  private drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, outerR: number, innerR: number): void {
    let rot = (Math.PI / 2) * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerR);
    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerR;
      y = cy + Math.sin(rot) * outerR;
      ctx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerR;
      y = cy + Math.sin(rot) * innerR;
      ctx.lineTo(x, y);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerR);
    ctx.closePath();
  }

  public destroy(): void {
    if (this.fxRafId !== null) {
      cancelAnimationFrame(this.fxRafId);
      this.fxRafId = null;
    }
    if (this.currentAnim) {
      this.currentAnim.destroy();
      this.currentAnim = null;
    }
  }
}

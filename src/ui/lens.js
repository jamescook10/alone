// Rain on the lens.
//
// There is no post chain - screen effects here are DOM overlays composited by
// the browser - so the classic droplets-on-the-camera effect is a fullscreen
// 2D canvas: a few dozen soft refractive-looking beads that collect while rain
// falls on you, wander down the glass under their own weight, and dry off.
// Cheap on purpose: it draws nothing at all while the lens is dry, which is
// almost always.

import { clamp } from '../core/noise.js';

const MAX_DROPS = 44;

export class LensFX {
  constructor(world) {
    this.world = world;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:42;';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.drops = [];
    this.film = 0; // the brief sheet of water when you surface
    this._wasUnder = false;
    this._spawnCarry = 0;
    this._active = false;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    // CSS pixels are plenty for soft blobs; devicePixelRatio would quadruple
    // the fill cost of an effect that lives at the edge of attention.
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  update(dt) {
    const w = this.world;
    const p = w.player;
    const weather = w.weather;
    if (!p || !weather || dt <= 0) return;

    // Photo mode and the screenshot harness want the pane of glass out of the
    // way - and the harness teleports the player through water stops, each
    // surfacing splashing the lens, which peppered every postcard with beads.
    const ui = w.ui;
    if (ui && (ui.hudVisible === false || ui.photo)) {
      this.drops.length = 0;
      this.film = 0;
      this._wasUnder = p.underwater;
      if (this._active) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this._active = false;
      }
      return;
    }

    // Surfacing from a swim leaves the lens sheeted and beaded even in
    // sunshine - the one moment everyone knows this effect from. Only after a
    // real dunk: floating in a swell the eye crosses the waterline every
    // wave, and an unguarded edge fired the whole burst each time.
    if (this._wasUnder && !p.underwater && this._underT > 0.7) {
      this.film = 1;
      for (let i = 0; i < 26; i++) this._spawn(1);
    }
    this._underT = p.underwater ? (this._underT || 0) + dt : 0;
    this._wasUnder = p.underwater;
    if (p.underwater) {
      // The water takes the drops with it.
      this.drops.length = 0;
      this.film = 0;
    }

    // Drops land on the glass while rain falls on you. Looking up turns the
    // lens into a target; shelter and snow keep it dry.
    const rain = weather.rain * (1 - p.sheltered);
    if (rain > 0.02) {
      const up = 0.55 + 0.9 * Math.max(0, Math.sin(p.pitch));
      this._spawnCarry += dt * rain * up * 11;
      while (this._spawnCarry > 1 && this.drops.length < MAX_DROPS) {
        this._spawnCarry -= 1;
        this._spawn(rain);
      }
      this._spawnCarry = Math.min(this._spawnCarry, 2);
    }

    this.film = Math.max(0, this.film - dt * 0.55);

    const W = this.canvas.width;
    const H = this.canvas.height;
    const alive = this.drops.length > 0 || this.film > 0.01;
    if (!alive) {
      if (this._active) {
        this.ctx.clearRect(0, 0, W, H);
        this._active = false;
      }
      return;
    }
    this._active = true;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    // The sheet: a faint brightening film that drains downward.
    if (this.film > 0.01) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `rgba(190,215,235,${0.16 * this.film})`);
      g.addColorStop(1, `rgba(190,215,235,${0.05 * this.film})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      // Big beads overcome the surface tension and run, gathering speed and
      // shedding size as they go; small ones just sit and evaporate.
      if (d.r > 9 || d.sliding) {
        d.sliding = true;
        d.vy += dt * 60;
        d.y += d.vy * dt;
        d.x += Math.sin(d.y * 0.05 + d.seed * 20) * 14 * dt;
        d.r = Math.max(3, d.r - dt * 2.2);
        if (d.y > H + 20) d.life = 0;
      }
      if (d.life <= 0) {
        this.drops.splice(i, 1);
        continue;
      }
      const fade = clamp(d.life / 1.2, 0, 1) * clamp((d.t0 - d.life) * 6, 0, 1);
      this._draw(ctx, d, fade);
    }
  }

  _spawn(intensity) {
    if (this.drops.length >= MAX_DROPS) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const life = 3 + Math.random() * 6;
    this.drops.push({
      x: Math.random() * W,
      y: Math.random() * H * 0.9,
      // Heavier rain lands bigger drops.
      r: 3.5 + Math.random() * Math.random() * (8 + 12 * intensity),
      vy: 0,
      sliding: false,
      seed: Math.random(),
      life,
      t0: life,
    });
  }

  _draw(ctx, d, fade) {
    const { x, y, r } = d;
    // A bead of water on glass: a darker refracting rim, a lens-bright body
    // and one small highlight. Radial gradients sell it without any shader.
    const body = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    body.addColorStop(0, `rgba(220,236,248,${0.42 * fade})`);
    body.addColorStop(0.65, `rgba(170,195,215,${0.24 * fade})`);
    body.addColorStop(0.88, `rgba(30,42,55,${0.34 * fade})`);
    body.addColorStop(1, 'rgba(30,42,55,0)');
    ctx.fillStyle = body;
    ctx.beginPath();
    // Sliding drops stretch into a teardrop; the tail is a second, smaller arc.
    ctx.ellipse(x, y, r, r * (d.sliding ? 1.35 : 1), 0, 0, 6.2832);
    ctx.fill();
    const hl = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x - r * 0.3, y - r * 0.35, r * 0.4);
    hl.addColorStop(0, `rgba(255,255,255,${0.65 * fade})`);
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.4, 0, 6.2832);
    ctx.fill();
  }
}

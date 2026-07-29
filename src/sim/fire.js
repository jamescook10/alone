// Combustion.
//
// A fire is a point with fuel, intensity and a radius. Each tick it warms
// everything nearby; anything whose material has an ignition temperature and
// whose accumulated heat passes it starts burning too. Wind pushes the spread
// downwind, rain and water put it out, and burning something consumes it -
// trees blacken and lose their leaves, buildings take damage, grass turns to
// ash. Nothing here is scripted: light a fire in a dry pine forest on a windy
// day and you will regret it.

import * as THREE from 'three';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { MATERIAL } from './chemistry.js';

const MAX_FIRES = 220;
const MAX_LIGHTS = 7;

export class FireSim {
  constructor(world) {
    this.world = world;
    this.fires = [];
    this.lights = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff7a22, 0, 34, 1.7);
      l.visible = false;
      l.castShadow = false;
      world.engine.scene.add(l);
      this.lights.push(l);
    }
    this._acc = 0;
    this._heatGrid = new Map(); // coarse cache of "how hot is it here"
    this.totalLit = 0;
  }

  /* ---------------------------------------------------------------- ignite */

  /**
   * Start a fire. `strength` scales the initial intensity, `radius` how far it
   * reaches for fuel. Returns the fire, or null if the spot cannot burn.
   */
  ignite(x, y, z, strength = 1, radius = 2.2, source = null) {
    if (this.fires.length >= MAX_FIRES) {
      // Let the weakest fire go so the new one can exist.
      let worst = 0;
      for (let i = 1; i < this.fires.length; i++) {
        if (this.fires[i].intensity < this.fires[worst].intensity) worst = i;
      }
      this.fires.splice(worst, 1);
    }
    const terrain = this.world.terrain;
    const wl = terrain.waterAt(x, z);
    if (wl > -Infinity && y < wl - 0.1) return null;

    const s = terrain.sampleAt(x, z);
    const wet = this.world.weather ? this.world.weather.rain : 0;
    const fire = {
      x, y, z,
      intensity: strength * 0.55,
      target: strength,
      fuel: 12 * strength,
      radius,
      age: 0,
      spreadT: 0.4 + Math.random() * 0.5,
      source,
      moist: s.moisture,
      wet,
      groundBurn: 0,
      light: null,
    };
    this.fires.push(fire);
    this.totalLit++;
    if (this.world.audio) this.world.audio.fireStart(x, y, z);
    return fire;
  }

  /** Heat contribution of nearby fires at a point, in degrees celsius. */
  heatAt(x, y, z) {
    let sum = 0;
    for (const f of this.fires) {
      const dx = f.x - x, dy = f.y - y, dz = f.z - z;
      const d2 = dx * dx + dy * dy * 0.55 + dz * dz;
      const r = f.radius * 3.2 + 3;
      if (d2 > r * r) continue;
      const d = Math.sqrt(d2);
      // Hot right at the flame, falling off fast; rising heat above it.
      const up = dy < 0 ? clamp(1 + dy * 0.12, 0.4, 1.6) : 1;
      sum += f.intensity * 780 / (1 + d * d * 1.5) * up;
    }
    return Math.min(sum, 1400);
  }

  /** Direct heating power in kW available at a point, for cooking and boiling. */
  powerAt(x, y, z) {
    let sum = 0;
    for (const f of this.fires) {
      const dx = f.x - x, dz = f.z - z;
      const dy = y - f.y;
      const horiz = Math.hypot(dx, dz);
      if (horiz > f.radius + 1.4 || dy < -0.6 || dy > 3.2) continue;
      const k = (1 - smoothstep(f.radius * 0.4, f.radius + 1.4, horiz)) * (1 - smoothstep(0.4, 3.0, dy));
      sum += f.intensity * 26 * k;
    }
    return sum;
  }

  extinguishNear(x, y, z, radius = 2.5, amount = 1) {
    let n = 0;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (Math.hypot(f.x - x, f.y - y, f.z - z) > radius) continue;
      f.intensity -= amount;
      f.fuel -= amount * 4;
      this.world.particles.steam(f.x, f.y + 0.3, f.z, 1.4, 8);
      if (f.intensity <= 0.05) {
        this._removeFire(i);
        n++;
      }
    }
    if (n && this.world.audio) this.world.audio.hiss(x, y, z);
    return n;
  }

  _removeFire(i) {
    const f = this.fires[i];
    if (this.world.audio) this.world.audio.fireStop(f);
    this.fires.splice(i, 1);
  }

  /* ---------------------------------------------------------------- update */

  update(dt) {
    if (dt <= 0) return;
    const w = this.world;
    const weather = w.weather;
    const wind = weather ? weather.windDir : { x: 1, y: 0 };
    const windStr = weather ? weather.wind : 0.3;
    const rain = weather ? weather.rain : 0;
    const player = w.player;

    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.age += dt;

      // Grow toward the target intensity, then burn down as fuel runs out.
      const fuelK = saturate(f.fuel / 6);
      f.intensity = lerp(f.intensity, f.target * fuelK, 1 - Math.exp(-dt * 0.7));
      f.fuel -= dt * (0.55 + f.intensity * 0.5);

      // Rain, damp ground and being in water all fight the fire.
      const damp = rain * 2.6 + f.moist * 0.22;
      f.fuel -= dt * damp;
      if (rain > 0.15 && Math.random() < dt * rain * 1.4) {
        w.particles.steam(f.x, f.y + 0.4, f.z, 0.8, 1);
      }

      if (f.intensity < 0.04 || f.fuel <= 0) {
        w.particles.smoke(f.x, f.y + 0.3, f.z, 1.1, 0.35, 2);
        this._removeFire(i);
        continue;
      }

      // Visuals, scaled by distance so a distant wildfire is still cheap.
      const dp = Math.hypot(f.x - player.position.x, f.z - player.position.z);
      const detail = dp < 70 ? 1 : dp < 220 ? 0.35 : 0.1;
      const rate = f.intensity * 26 * detail;
      if (Math.random() < rate * dt) w.particles.fire(f.x, f.y, f.z, 0.55 + f.intensity * 0.7, 2);
      if (Math.random() < rate * dt * 0.35) w.particles.smoke(f.x, f.y + f.intensity * 0.8, f.z, 0.8 + f.intensity, 0.45, 1);
      if (Math.random() < rate * dt * 0.10) w.particles.sparks(f.x, f.y + 0.4, f.z, 2, 0.35);

      /* --- spread ------------------------------------------------------- */
      f.spreadT -= dt;
      if (f.spreadT <= 0) {
        f.spreadT = 0.55 + Math.random() * 0.7;
        this._trySpread(f, wind, windStr, rain);
      }
    }

    // Warm the plants and props that sit in the heat, so things catch fire on
    // their own once they get hot enough.
    this._acc += dt;
    if (this._acc > 0.25) {
      this._heat(this._acc, wind, windStr);
      this._acc = 0;
    }

    this._updateLights();
  }

  _trySpread(f, wind, windStr, rain) {
    const w = this.world;
    if (rain > 0.55) return;
    const reach = f.radius + 1.4 + f.intensity * 1.8;

    // Plants: the main thing that carries a fire across a landscape.
    const hits = w.flora.within(f.x, f.z, reach + 3, []);
    for (const hit of hits) {
      const p = hit.plant;
      if (p.health <= 0.06) continue;
      const dx = p.x - f.x, dz = p.z - f.z;
      const d = Math.hypot(dx, dz);
      // Downwind is much more likely.
      const dot = d > 0.01 ? (dx / d) * wind.x + (dz / d) * wind.y : 0;
      const windBoost = 1 + Math.max(0, dot) * windStr * 2.6;
      const chance = (1 - smoothstep(f.radius * 0.5, reach + 3, d)) * windBoost * f.intensity * 0.55;
      if (Math.random() > chance) continue;
      const info = w.flora.constructor === Object ? null : null;
      const burn = SPECIES_BURN(hit) * (1 - f.moist * 0.5);
      w.flora.damage(hit, 0.34 * burn);
      const h = w.flora.height(p);
      if (!p.burning) {
        p.burning = true;
        const nf = this.ignite(p.x, p.y + h * 0.35, p.z, 0.7 + burn * 0.6, 1.4 + h * 0.10, hit);
        if (nf) nf.moist = f.moist;
      }
    }

    // Buildings, vehicles and props.
    w.civ.fireSpread(f, reach, windStr, wind);

    // Ground fire creeps outward across grass.
    if (f.groundBurn < 3 && f.intensity > 0.5 && Math.random() < 0.3) {
      const a = Math.atan2(wind.y, wind.x) + (Math.random() - 0.5) * 1.9;
      const d = f.radius + 0.9 + Math.random() * 2.4 * (1 + windStr);
      const nx = f.x + Math.cos(a) * d;
      const nz = f.z + Math.sin(a) * d;
      const s = this.world.terrain.sampleAt(nx, nz);
      const grassy = s.moisture < 0.72 && s.height > 0.6 && s.waterLevel === -Infinity;
      if (grassy) {
        f.groundBurn++;
        const nf = this.ignite(nx, this.world.terrain.heightAt(nx, nz) + 0.25, nz, 0.45, 1.5, null);
        if (nf) {
          nf.groundBurn = f.groundBurn;
          nf.fuel = 5;
        }
      }
    }
  }

  /** Slow accumulation of heat in things that are not burning yet. */
  _heat(dt, wind, windStr) {
    const w = this.world;
    for (const f of this.fires) {
      if (f.intensity < 0.3) continue;
      const hits = w.flora.within(f.x, f.z, f.radius * 2.4 + 4, []);
      for (const hit of hits) {
        const p = hit.plant;
        if (p.burning) continue;
        const d = Math.hypot(p.x - f.x, p.z - f.z);
        const heat = this.heatAt(p.x, p.y + 0.6, p.z);
        p.heat = (p.heat || 15) + (heat - (p.heat || 15)) * clamp(dt * 0.5, 0, 1);
        const mat = MATERIAL.leaf;
        if (p.heat > mat.ignite * (0.6 + p.health * 0.4)) {
          p.burning = true;
          this.ignite(p.x, p.y + w.flora.height(p) * 0.3, p.z, 0.8, 1.6, hit);
        }
      }
    }
  }

  _updateLights() {
    const cam = this.world.player.position;
    // Pick the brightest few fires near the camera and give them real light.
    const scored = this.fires
      .map((f) => ({ f, s: f.intensity / (1 + Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z) * 0.05) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_LIGHTS);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = this.lights[i];
      const e = scored[i];
      if (!e || e.f.intensity < 0.08) {
        l.visible = false;
        continue;
      }
      const f = e.f;
      const flick = 0.78 + 0.22 * Math.sin(performance.now() * 0.011 + i * 2.1) * Math.sin(performance.now() * 0.027 + i);
      l.visible = true;
      l.position.set(f.x, f.y + 0.6 + f.intensity * 0.4, f.z);
      l.intensity = f.intensity * 190 * flick;
      l.distance = 12 + f.intensity * 30;
      l.color.setRGB(1, lerp(0.42, 0.62, flick), lerp(0.10, 0.22, flick));
    }
  }
}

function SPECIES_BURN(hit) {
  // Resinous conifers burn hard; cactus and green willow resist.
  const sp = hit.plant.sp;
  const table = [1.0, 1.35, 1.1, 0.9, 1.0, 0.35, 0.8, 1.8, 0.9, 1.4, 1.5, 1.2, 1.3];
  return table[sp] !== undefined ? table[sp] : 1;
}

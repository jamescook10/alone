// The world: owns every system and runs them in the right order.

import * as THREE from 'three';
import { WorldGen } from './worldgen.js';
import { Terrain } from './terrain.js';
import { Horizon } from './horizon.js';
import { Sky } from './sky.js';
import { Weather } from './weather.js';
import { Clouds } from './clouds.js';
import { Flora } from './flora.js';
import { Wildlife } from './wildlife.js';
import { Civilisation } from './civilisation.js';
import { Physics } from '../sim/physics.js';
import { FireSim } from '../sim/fire.js';
import { Particles } from '../gfx/particles.js';
import { Player } from '../player/player.js';
import { Interaction } from '../player/interact.js';
import { atmo } from '../gfx/atmosphere.js';
import { GERSTNER_WAVES } from '../gfx/materials.js';

const SHADOW_ANCHOR = new THREE.Vector3();

export class World {
  constructor(engine, seed, opts = {}) {
    this.engine = engine;
    this.seed = seed >>> 0;
    this.wg = new WorldGen(this.seed);
    this.time = 0;
    this.paused = false;
    this.opts = opts;

    // Everything the player changes about the world lives here, keyed so it
    // survives chunks streaming out and back in.
    this.edits = {
      removedPlants: new Set(),
      plantedPlants: [],
      plantHealth: new Map(),
      fruitTaken: new Map(),
      buildingDamage: new Map(),
      removedProps: new Set(),
      fires: [],
      journal: [],
    };

    this.particles = new Particles(this);
    this.flora = new Flora(this);
    this.terrain = new Terrain(this);
    engine.scene.add(this.terrain.group);
    engine.scene.add(this.terrain.waterGroup);

    this.sky = new Sky(engine, { dayLength: opts.dayLength || 1500, startTime: opts.startTime });
    this.weather = new Weather(this);
    this.clouds = new Clouds(this);
    this.physics = new Physics(this);
    this.fire = new FireSim(this);
    this.wildlife = new Wildlife(this);
    this.civ = new Civilisation(this);

    const spawn = opts.spawn || this.wg.findSpawn();
    this.player = new Player(this, spawn);
    this.horizon = new Horizon(this);
    this.interaction = new Interaction(this);

    this.audio = null; // attached by main once the user has interacted
    this.ui = null;

    this._climateT = 0;
    this._climateTarget = this.wg.seaTemp(spawn.x, spawn.z);
    atmo.uClimateTemp.value = this._climateTarget;

    // A flat plate of water far beyond the streamed chunks, so the ocean
    // reaches the horizon instead of stopping at the edge of the world.
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(900, 260000, 96, 1),
      new THREE.MeshBasicMaterial({ color: 0x0b2a34, depthWrite: true, fog: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 2;
    disc.frustumCulled = false;
    this.horizonSea = disc;
    engine.scene.add(disc);
  }

  update(dt) {
    if (this.paused) dt = 0;
    this.time += dt;
    const p = this.player;

    this.player.update(dt);
    this.terrain.update(p.position);
    this.horizon.update();
    this.weather.update(dt, p);
    this.sky.update(dt, this.engine.camera, this.weather);
    // Shadows track the ground under the player, not the player: flying at
    // cloud height with the shadow box centred on you leaves the world below
    // outside the light camera and drew a dark rectangle on the landscape.
    const gy = this.terrain.heightAt(p.position.x, p.position.z);
    SHADOW_ANCHOR.set(p.position.x, Math.min(p.position.y, gy + 40), p.position.z);
    this.sky.positionLights(SHADOW_ANCHOR);
    this.clouds.update(dt);
    this.flora.update(dt);
    this.fire.update(dt);
    this.physics.update(dt);
    this.wildlife.update(dt, p);
    this.civ.update(dt, p);
    this.particles.update(dt);
    this.interaction.update(dt);

    atmo.uTime.value += dt;
    atmo.uPlayerPos.value.copy(p.position);
    this._updateWaterFX(dt, p);

    // Follow the region's climate so trees, rocks and roofs cross the snow
    // line where the ground does. Eased, because walking over a chunk boundary
    // must not flip a whole hillside white in one frame.
    this._climateT -= dt;
    if (this._climateT <= 0) {
      this._climateT = 0.4;
      this._climateTarget = this.wg.seaTemp(p.position.x, p.position.z);
    }
    atmo.uClimateTemp.value += (this._climateTarget - atmo.uClimateTemp.value) * (1 - Math.exp(-dt * 1.5));

    // The far ocean plate follows you and takes the colour of the water you
    // would see at that distance.
    this.horizonSea.position.set(p.position.x, -2.2, p.position.z);
    const hz = this.sky.horizonColor;
    this.horizonSea.material.color.setRGB(
      hz.r * 0.55 + 0.004,
      hz.g * 0.62 + 0.012,
      hz.b * 0.70 + 0.018
    );
    this.horizonSea.visible = !p.underwater;

    if (this.audio) this.audio.update(dt);
  }

  /**
   * The things that only matter when there is water near you: the surface
   * height the ground shader needs to put caustics on itself, the rings that
   * spread from someone standing in it, and the mist over any fall within
   * earshot. All of it is refreshed a few times a second rather than per
   * frame - none of it moves fast enough to notice, and `waterAt` is a full
   * world sample.
   */
  _updateWaterFX(dt, p) {
    this._waterT = (this._waterT || 0) - dt;
    if (this._waterT <= 0) {
      this._waterT = 0.25;
      // The nearest water surface. Caustics are only visible where you can
      // see the bottom, so a short probe is all the ground shader needs.
      let best = -9999;
      for (let i = 0; i < 12; i++) {
        const a = i * 2.399963;
        const r = i === 0 ? 0 : 14 * Math.sqrt(i);
        const wl = this.terrain.waterAt(p.position.x + Math.cos(a) * r, p.position.z + Math.sin(a) * r);
        if (wl > best) best = wl;
      }
      atmo.uWaterY.value = best;
      this.falls = this.wg.fallsNear(p.position.x, p.position.z, 240, this.falls || []);
      // The loudest one within earshot, for the soundscape.
      let near = null;
      let nearD = Infinity;
      for (const f of this.falls) {
        const d = Math.hypot(f.x - p.position.x, f.z - p.position.z);
        const loud = d / Math.max(0.3, f.fall * Math.sqrt(f.flow));
        if (loud < nearD) {
          nearD = loud;
          near = f;
          near.dist = d;
        }
      }
      this.nearestFall = near;
    }

    // Rings spread from a body in the water, and harder when it is moving.
    const wade = p.submersion > 0.04 && !p.underwater
      ? Math.min(1, p.submersion * 2) * (0.30 + Math.min(0.7, p.speed * 0.22))
      : 0;
    atmo.uWade.value += (wade - atmo.uWade.value) * (1 - Math.exp(-dt * 6));

    // Mist over the falls. Only the near ones, and only a few particles a
    // second each - a fall is a standing plume, not a firework.
    if (this.falls && this.falls.length && dt > 0) {
      for (let i = 0; i < this.falls.length && i < 5; i++) {
        const f = this.falls[i];
        const d = Math.hypot(f.x - p.position.x, f.z - p.position.z);
        if (d > 190) continue;
        const scale = 0.7 + Math.min(2.2, f.w * 0.22 + f.drop * 0.05);
        if (Math.random() < dt * (2.5 + f.fall * 5) * (1 - d / 190)) {
          this.particles.spray(f.x, f.y - f.drop * 0.35, f.z, scale, 2);
        }
      }
    }
  }

  /**
   * CPU mirror of the water vertex shader's Gerstner sum (height only), so
   * the swimming player bobs on the same swell they can see. Same wave
   * table, same time uniform, same wind and shore damping.
   */
  waveHeightAt(x, z) {
    const wl = this.terrain.waterAt(x, z);
    if (wl === -Infinity) return 0;
    const depth = wl - this.terrain.heightAt(x, z);
    const shore = Math.max(0, Math.min(1, depth / 2.5));
    if (shore <= 0.01) return 0;
    const wind = Math.max(0, Math.min(1.5, atmo.uWindStrength.value));
    const amp = shore * (0.45 + wind * 0.75);
    const t = atmo.uTime.value;
    let h = 0;
    for (const [dx, dz, L, A] of GERSTNER_WAVES) {
      const k = (Math.PI * 2) / L;
      const w = Math.sqrt(9.81 * k);
      const il = 1 / Math.hypot(dx, dz);
      h += A * amp * Math.sin(k * (dx * il * x + dz * il * z) + w * t);
    }
    return h;
  }

  /** A short note added to the journal, shown in the UI. */
  note(text, kind = 'note') {
    const entry = { text, kind, day: this.sky.day, time: this.sky.hours };
    this.edits.journal.push(entry);
    if (this.ui) this.ui.onJournal(entry);
    return entry;
  }

  dispose() {
    this.terrain.dispose();
    this.horizon.dispose();
  }
}

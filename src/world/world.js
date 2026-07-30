// The world: owns every system and runs them in the right order.

import * as THREE from 'three';
import { WorldGen } from './worldgen.js';
import { Terrain } from './terrain.js';
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
    this.interaction = new Interaction(this);

    this.audio = null; // attached by main once the user has interacted
    this.ui = null;

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
  }
}

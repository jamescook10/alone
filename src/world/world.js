// The world: owns every system and runs them in the right order.

import * as THREE from 'three';
import { WorldGen } from './worldgen.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Weather } from './weather.js';
import { Flora } from './flora.js';
import { Wildlife } from './wildlife.js';
import { Civilisation } from './civilisation.js';
import { Physics } from '../sim/physics.js';
import { FireSim } from '../sim/fire.js';
import { Particles } from '../gfx/particles.js';
import { Player } from '../player/player.js';
import { Interaction } from '../player/interact.js';
import { atmo } from '../gfx/atmosphere.js';

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
      new THREE.RingGeometry(1500, 260000, 96, 1),
      new THREE.MeshBasicMaterial({ color: 0x0b2a34, depthWrite: false, fog: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 3;
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
    this.sky.positionLights(p.position);
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
    this.horizonSea.position.set(p.position.x, -0.4, p.position.z);
    const hz = this.sky.horizonColor;
    this.horizonSea.material.color.setRGB(
      hz.r * 0.55 + 0.004,
      hz.g * 0.62 + 0.012,
      hz.b * 0.70 + 0.018
    );
    this.horizonSea.visible = !p.underwater;

    if (this.audio) this.audio.update(dt);
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

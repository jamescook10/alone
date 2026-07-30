// Animals.
//
// Steering agents with a shared skeleton trick: every vertex knows which limb
// it belongs to and where that limb pivots, so legs walk, wings beat and fish
// undulate entirely in the vertex shader. The CPU only ever decides where an
// animal wants to go.

import * as THREE from 'three';
import { buildAnimal } from './animalMeshes.js';
import { makeSolidMaterial } from '../gfx/materials.js';
import { injectAtmosphere } from '../gfx/atmosphere.js';
import { Noise, Rng, clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { BIOME } from './worldgen.js';

const GAIT = { WALK: 0, FLY: 1, SWIM: 2, HOP: 3 };

const SPECIES = [
  { key: 'deer', name: 'deer', gait: GAIT.WALK, size: 1.0, speed: 4.2, flee: 26, herd: 5, cap: 26,
    body: [0.30, 0.34, 0.78], legs: 0.78, neck: 0.55, col: [0.20, 0.115, 0.062], antlers: true,
    biomes: [BIOME.FOREST, BIOME.MEADOW, BIOME.GRASSLAND, BIOME.TAIGA], call: 'deer', voice: 0.006 },
  { key: 'rabbit', name: 'rabbit', gait: GAIT.HOP, size: 0.34, speed: 5.4, flee: 13, herd: 3, cap: 28,
    body: [0.14, 0.14, 0.26], legs: 0.16, neck: 0.10, col: [0.20, 0.17, 0.135], ears: true,
    biomes: [BIOME.MEADOW, BIOME.GRASSLAND, BIOME.FOREST, BIOME.TUNDRA], call: null, voice: 0 },
  { key: 'boar', name: 'boar', gait: GAIT.WALK, size: 0.8, speed: 4.6, flee: 12, herd: 4, cap: 16,
    body: [0.32, 0.34, 0.66], legs: 0.38, neck: 0.26, col: [0.10, 0.082, 0.070], tusks: true,
    biomes: [BIOME.FOREST, BIOME.RAINFOREST, BIOME.SWAMP], call: 'boar', voice: 0.01 },
  { key: 'wolf', name: 'wolf', gait: GAIT.WALK, size: 0.75, speed: 5.6, flee: 0, herd: 4, cap: 12,
    body: [0.24, 0.26, 0.72], legs: 0.52, neck: 0.30, col: [0.145, 0.140, 0.135], curious: true,
    biomes: [BIOME.TAIGA, BIOME.FOREST, BIOME.TUNDRA, BIOME.SNOW], call: 'wolf', voice: 0.004 },
  { key: 'fox', name: 'fox', gait: GAIT.WALK, size: 0.45, speed: 5.0, flee: 16, herd: 1, cap: 12,
    body: [0.15, 0.16, 0.44], legs: 0.28, neck: 0.18, col: [0.34, 0.115, 0.035], bushyTail: true,
    biomes: [BIOME.FOREST, BIOME.MEADOW, BIOME.TAIGA, BIOME.GRASSLAND], call: 'fox', voice: 0.004, night: true },
  { key: 'goat', name: 'mountain goat', gait: GAIT.WALK, size: 0.7, speed: 3.6, flee: 18, herd: 4, cap: 14,
    body: [0.24, 0.28, 0.56], legs: 0.46, neck: 0.26, col: [0.36, 0.345, 0.315], horns: true,
    biomes: [BIOME.ALPINE, BIOME.SCREE, BIOME.TUNDRA], call: 'goat', voice: 0.008 },
  { key: 'camel', name: 'camel', gait: GAIT.WALK, size: 1.1, speed: 3.4, flee: 14, herd: 3, cap: 8,
    body: [0.34, 0.44, 0.84], legs: 0.95, neck: 0.85, col: [0.28, 0.205, 0.115], hump: true,
    biomes: [BIOME.DESERT, BIOME.SAVANNA], call: null, voice: 0 },
  { key: 'bird', name: 'birds', gait: GAIT.FLY, size: 0.22, speed: 9.5, flee: 22, herd: 14, cap: 90,
    body: [0.07, 0.07, 0.20], legs: 0, neck: 0.05, col: [0.09, 0.085, 0.080], wings: 0.30,
    biomes: null, call: 'songbird', voice: 0.05 },
  { key: 'gull', name: 'gulls', gait: GAIT.FLY, size: 0.32, speed: 8.5, flee: 16, herd: 7, cap: 40,
    body: [0.09, 0.09, 0.26], legs: 0, neck: 0.07, col: [0.62, 0.63, 0.66], wings: 0.46,
    biomes: [BIOME.BEACH, BIOME.OCEAN, BIOME.REEF], call: 'gull', voice: 0.035 },
  { key: 'raptor', name: 'eagle', gait: GAIT.FLY, size: 0.55, speed: 12, flee: 0, herd: 1, cap: 6,
    body: [0.12, 0.13, 0.42], legs: 0, neck: 0.10, col: [0.115, 0.085, 0.055], wings: 0.95,
    biomes: [BIOME.ALPINE, BIOME.SCREE, BIOME.SNOW, BIOME.FOREST], call: 'eagle', voice: 0.010 },
  { key: 'fish', name: 'fish', gait: GAIT.SWIM, size: 0.30, speed: 3.4, flee: 7, herd: 18, cap: 110,
    body: [0.075, 0.11, 0.26], legs: 0, neck: 0, col: [0.135, 0.170, 0.190], fins: true,
    biomes: null, call: null, voice: 0 },
  { key: 'whale', name: 'whale', gait: GAIT.SWIM, size: 7.5, speed: 2.6, flee: 0, herd: 2, cap: 3,
    body: [1.3, 1.5, 5.4], legs: 0, neck: 0, col: [0.055, 0.060, 0.072], fins: true, deep: true,
    biomes: null, call: 'whale', voice: 0.003 },
  { key: 'butterfly', name: 'butterflies', gait: GAIT.FLY, size: 0.10, speed: 2.0, flee: 4, herd: 8, cap: 60,
    body: [0.02, 0.02, 0.05], legs: 0, neck: 0, col: [1.4, 1.0, 0.35], wings: 0.16,
    biomes: [BIOME.MEADOW, BIOME.GRASSLAND, BIOME.RAINFOREST, BIOME.SWAMP], call: null, voice: 0 },
];

/* ------------------------------------------------------------- the system */

const ANIM_PARS = /* glsl */ `
attribute float aLimb;
attribute vec3 aPivot;
attribute vec3 aPivot2;
attribute float aPhase;
attribute vec3 aMotion; // x: gait, y: speed 0..1, z: alertness
uniform float uAnimTime;

vec3 rotAxis( vec3 p, vec3 pivot, vec3 axis, float ang ) {
  vec3 v = p - pivot;
  float c = cos( ang ), s = sin( ang );
  return pivot + v * c + cross( axis, v ) * s + axis * dot( axis, v ) * ( 1.0 - c );
}
`;

const ANIM_BODY = /* glsl */ `
{
  float gait = aMotion.x;
  float sp = aMotion.y;
  float t = uAnimTime * ( 2.0 + sp * 9.0 ) + aPhase;
  if ( gait < 0.5 || gait > 2.5 ) {
    // walking or hopping quadruped
    if ( aLimb > 0.5 && aLimb < 4.5 ) {
      float off = ( aLimb < 2.5 ? 0.0 : 3.14159 ) + ( mod( aLimb, 2.0 ) > 0.5 ? 0.0 : 3.14159 );
      float ang = sin( t + off ) * ( 0.16 + sp * 0.75 );
      if ( gait > 2.5 ) ang = max( 0.0, sin( t ) ) * ( 0.2 + sp * 1.25 );
      transformed = rotAxis( transformed, aPivot, vec3( 1.0, 0.0, 0.0 ), ang );
    } else if ( aLimb > 4.5 && aLimb < 5.5 ) {
      // head: dips to graze when still, lifts when alert
      float ang = mix( 0.55, -0.12, clamp( sp * 2.2 + aMotion.z, 0.0, 1.0 ) )
        + sin( t * 0.5 ) * 0.06;
      transformed = rotAxis( transformed, aPivot, vec3( 1.0, 0.0, 0.0 ), ang );
    } else if ( aLimb > 5.5 && aLimb < 6.5 ) {
      transformed = rotAxis( transformed, aPivot, vec3( 0.0, 1.0, 0.0 ), sin( t * 1.6 ) * 0.32 );
    } else if ( aLimb > 8.5 ) {
      // Lower leg: follows its hip's swing, folds at the knee on the
      // backswing so the foot lifts instead of mowing through the ground.
      float li = aLimb - 8.0;
      float off2 = ( li < 2.5 ? 0.0 : 3.14159 ) + ( mod( li, 2.0 ) > 0.5 ? 0.0 : 3.14159 );
      float ang2 = sin( t + off2 ) * ( 0.16 + sp * 0.75 );
      float bend = 0.06 + max( 0.0, -sin( t + off2 ) ) * ( 0.20 + sp * 0.85 ) * min( 1.0, sp * 4.0 + aMotion.z );
      if ( gait > 2.5 ) {
        ang2 = max( 0.0, sin( t ) ) * ( 0.2 + sp * 1.25 );
        bend = 0.08 + max( 0.0, -sin( t ) ) * min( 1.0, sp * 4.0 ) * 0.55;
      }
      transformed = rotAxis( transformed, aPivot2, vec3( 1.0, 0.0, 0.0 ), bend );
      transformed = rotAxis( transformed, aPivot, vec3( 1.0, 0.0, 0.0 ), ang2 );
    }
    if ( gait > 2.5 ) transformed.y += max( 0.0, sin( t ) ) * sp * 0.30;
  } else if ( gait < 1.5 ) {
    // flight
    float beat = sin( uAnimTime * ( 9.0 + sp * 8.0 ) + aPhase );
    if ( aLimb > 6.5 ) {
      float s = aLimb > 7.5 ? -1.0 : 1.0;
      transformed = rotAxis( transformed, aPivot, vec3( 0.0, 0.0, 1.0 ), beat * 1.05 * s );
    }
    if ( aLimb > 5.5 && aLimb < 6.5 ) {
      transformed = rotAxis( transformed, aPivot, vec3( 1.0, 0.0, 0.0 ), beat * 0.14 );
    }
  } else {
    // swimming: the whole body waves, the tail most of all
    float k = transformed.z;
    float wave = sin( uAnimTime * ( 3.2 + sp * 6.0 ) + aPhase - k * 2.4 );
    float amp = 0.10 + sp * 0.16;
    transformed.x += wave * amp * ( 0.25 + max( 0.0, -k ) * 2.4 );
    if ( aLimb > 6.5 ) {
      float s = aLimb > 7.5 ? -1.0 : 1.0;
      transformed = rotAxis( transformed, aPivot, vec3( 0.0, 0.0, 1.0 ), wave * 0.34 * s );
    }
  }
}
`;

export class Wildlife {
  constructor(world) {
    this.world = world;
    this.n = new Noise(world.seed ^ 0xbeef);
    this.rng = new Rng(world.seed ^ 0x1a2b);
    this.animTime = { value: 0 };

    // Smooth shading now: the bodies are rounded spines, and flat shading
    // would refacet every curve.
    this.mat = makeSolidMaterial({ key: 'animal', flat: false, roughness: 0.82 });
    this._patch(this.mat);

    this.pools = SPECIES.map((sp) => {
      const geo = buildAnimal(sp);
      const mesh = new THREE.InstancedMesh(geo, this.mat, sp.cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = sp.size > 0.4;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const phase = new THREE.InstancedBufferAttribute(new Float32Array(sp.cap), 1);
      const motion = new THREE.InstancedBufferAttribute(new Float32Array(sp.cap * 3), 3);
      phase.setUsage(THREE.DynamicDrawUsage);
      motion.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aPhase', phase);
      geo.setAttribute('aMotion', motion);
      world.engine.scene.add(mesh);
      return { sp, mesh, phase, motion, animals: [] };
    });

    this.animals = [];
    this.spawnTimer = 0;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.nearbySpecies = new Set();
  }

  /**
   * The material already carries the atmosphere injection, so this chains a
   * second patch onto it rather than replacing the same include twice.
   */
  _patch(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.uniforms.uAnimTime = this.animTime;
      shader.vertexShader = shader.vertexShader.replace(
        'varying vec3 vWorldPos;',
        'varying vec3 vWorldPos;\n' + ANIM_PARS
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        ANIM_BODY + '\n#include <project_vertex>'
      );
    };
  }

  /* ---------------------------------------------------------------- spawn */

  _canLive(sp, s) {
    if (sp.gait === GAIT.SWIM) {
      if (s.waterLevel === -Infinity) return false;
      const depth = s.waterLevel - s.height;
      if (sp.deep) return depth > 55;
      return depth > 1.4;
    }
    if (s.waterLevel > s.height + 0.2) return sp.gait === GAIT.FLY && sp.key === 'gull';
    if (sp.gait === GAIT.FLY) {
      if (!sp.biomes) return s.height > 0.5;
      return sp.biomes.indexOf(s.biome) >= 0 || s.height > 0.5 && sp.key === 'gull' && s.height < 12;
    }
    if (s.height < 0.4) return false;
    return sp.biomes ? sp.biomes.indexOf(s.biome) >= 0 : true;
  }

  _spawnAround(player, budget) {
    const w = this.world;
    const rng = this.rng;
    for (let attempt = 0; attempt < budget; attempt++) {
      const pool = this.pools[rng.int(0, this.pools.length)];
      const sp = pool.sp;
      if (pool.animals.length >= sp.cap) continue;
      const a = rng.float(0, Math.PI * 2);
      const r = lerp(48, 190, rng.next());
      const x = player.position.x + Math.cos(a) * r;
      const z = player.position.z + Math.sin(a) * r;
      const s = w.terrain.sampleAt(x, z);
      if (!this._canLive(sp, s)) continue;

      // Nocturnal species keep to the dark, and the rest to the light.
      const night = 1 - w.sky.dayFactor;
      const wantNight = sp.night ? night : 1 - night * 0.65;
      if (rng.next() > wantNight) continue;

      // Spawn a small group, because animals are rarely alone.
      const n = Math.min(sp.herd, sp.cap - pool.animals.length, 1 + Math.floor(rng.next() * sp.herd));
      for (let i = 0; i < n; i++) {
        const jx = x + rng.float(-1, 1) * sp.herd * 1.6;
        const jz = z + rng.float(-1, 1) * sp.herd * 1.6;
        this._makeAnimal(pool, jx, jz, s);
      }
      return;
    }
  }

  _makeAnimal(pool, x, z, s) {
    const sp = pool.sp;
    const w = this.world;
    const rng = this.rng;
    const gh = w.terrain.heightAt(x, z);
    let y = gh;
    if (sp.gait === GAIT.FLY) y = gh + lerp(6, 46, rng.next()) * (sp.key === 'butterfly' ? 0.06 : 1);
    if (sp.gait === GAIT.SWIM) {
      const wl = w.terrain.waterAt(x, z);
      if (wl === -Infinity) return;
      y = lerp(gh + 0.5, wl - 0.6, rng.float(0.15, 0.9));
    }
    const a = {
      sp, pool,
      x, y, z,
      vx: 0, vy: 0, vz: 0,
      dir: rng.float(0, Math.PI * 2),
      scale: sp.size * rng.float(0.82, 1.2),
      phase: rng.float(0, 6.283),
      wander: rng.float(0, 1000),
      alert: 0,
      restT: rng.float(0, 8),
      resting: false,
      speedN: 0,
      voiceT: rng.float(2, 30),
      slot: -1,
      bank: 0,
      pitch: 0,
      alive: true,
    };
    pool.animals.push(a);
    this.animals.push(a);
    return a;
  }

  _despawn(a) {
    a.alive = false;
    const i = a.pool.animals.indexOf(a);
    if (i >= 0) a.pool.animals.splice(i, 1);
    const j = this.animals.indexOf(a);
    if (j >= 0) this.animals.splice(j, 1);
  }

  /* --------------------------------------------------------------- update */

  update(dt, player) {
    if (dt <= 0) {
      this._commit();
      return;
    }
    this.animTime.value += dt;
    const w = this.world;
    const px = player.position.x;
    const pz = player.position.z;
    const py = player.position.y;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.35;
      if (this.animals.length < 190) this._spawnAround(player, 8);
    }

    this.nearbySpecies.clear();

    for (let i = this.animals.length - 1; i >= 0; i--) {
      const a = this.animals[i];
      const sp = a.sp;
      const dx = a.x - px;
      const dz = a.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 340 * 340) {
        this._despawn(a);
        continue;
      }
      if (d2 < 90 * 90) this.nearbySpecies.add(sp.key);

      const dist = Math.sqrt(d2);
      const scared = sp.flee > 0 ? saturate((sp.flee - dist) / sp.flee) : 0;
      a.alert = lerp(a.alert, scared > 0.02 ? 1 : 0, 1 - Math.exp(-dt * 3));

      /* --- steering --------------------------------------------------- */
      a.wander += dt * 0.35;
      let wantDir = a.dir;
      let wantSpeed = 0;

      if (scared > 0.12) {
        // Run away, and quickly.
        wantDir = Math.atan2(dz, dx);
        wantSpeed = sp.speed * lerp(0.65, 1.25, scared);
        a.resting = false;
        a.restT = 2 + Math.random() * 4;
        if (sp.curious && dist > sp.flee * 0.5) {
          wantDir += Math.PI; // wolves watch you instead of fleeing
          wantSpeed *= 0.3;
        }
      } else {
        a.restT -= dt;
        if (a.restT <= 0) {
          a.resting = !a.resting;
          a.restT = a.resting ? lerp(3, 14, Math.random()) : lerp(4, 18, Math.random());
          if (!a.resting) a.dir += (Math.random() - 0.5) * 2.4;
        }
        const wob = this.n.noise2(a.wander, a.phase) * 1.5;
        wantDir = a.dir + wob * dt * 3;
        wantSpeed = a.resting ? 0 : sp.speed * lerp(0.22, 0.55, Math.abs(this.n.noise2(a.wander * 0.4, 7)));
      }

      // Flocking, for the species that do it.
      if (sp.herd > 2) {
        let cx = 0, cz = 0, cy = 0, ax = 0, az = 0, n = 0, sx = 0, sz = 0;
        const flock = a.pool.animals;
        for (let k = 0; k < flock.length; k++) {
          const o = flock[k];
          if (o === a) continue;
          const ox = o.x - a.x, oz = o.z - a.z, oy = o.y - a.y;
          const od2 = ox * ox + oz * oz + oy * oy;
          if (od2 > 400) continue;
          n++;
          cx += o.x; cz += o.z; cy += o.y;
          ax += Math.cos(o.dir); az += Math.sin(o.dir);
          if (od2 < 9) {
            const inv = 1 / (Math.sqrt(od2) + 0.01);
            sx -= ox * inv; sz -= oz * inv;
          }
        }
        if (n > 0) {
          cx = cx / n - a.x;
          cz = cz / n - a.z;
          const cohere = Math.atan2(cz, cx);
          const align = Math.atan2(az, ax);
          const sep = Math.atan2(sz, sx);
          const sepW = Math.hypot(sx, sz) > 0.01 ? 0.9 : 0;
          wantDir = blendAngles([
            [wantDir, 1], [cohere, 0.6], [align, 0.8], [sep, sepW * 1.8],
          ]);
          if (sp.gait === GAIT.FLY || sp.gait === GAIT.SWIM) {
            const dy = cy / n - a.y;
            a.vy += clamp(dy, -1, 1) * dt * 1.4;
          }
          wantSpeed = Math.max(wantSpeed, sp.speed * (sp.gait === GAIT.FLY ? 0.55 : 0.3));
        }
      }

      // Turn toward the wish direction.
      let diff = wrapAngle(wantDir - a.dir);
      const turnRate = sp.gait === GAIT.FLY ? 2.4 : 3.4;
      a.dir += clamp(diff, -turnRate * dt, turnRate * dt);
      a.bank = lerp(a.bank, clamp(diff * 0.9, -0.7, 0.7), 1 - Math.exp(-dt * 3));

      /* --- locomotion -------------------------------------------------- */
      const targetVX = Math.cos(a.dir) * wantSpeed;
      const targetVZ = Math.sin(a.dir) * wantSpeed;
      const accel = 1 - Math.exp(-dt * (sp.gait === GAIT.FLY ? 1.6 : 5));
      a.vx += (targetVX - a.vx) * accel;
      a.vz += (targetVZ - a.vz) * accel;
      a.x += a.vx * dt;
      a.z += a.vz * dt;

      const gh = w.terrain.heightAt(a.x, a.z);
      const wl = w.terrain.waterAt(a.x, a.z);

      if (sp.gait === GAIT.FLY) {
        // Hold a comfortable altitude above whatever is below.
        const want = gh + (sp.key === 'butterfly' ? 0.7 : sp.key === 'raptor' ? 65 : 16) +
          Math.sin(a.wander * 0.8) * (sp.key === 'butterfly' ? 0.4 : 8);
        a.vy += clamp((want - a.y) * 0.5, -6, 6) * dt * 1.4;
        a.vy *= Math.exp(-dt * 0.9);
        a.y += a.vy * dt;
        if (a.y < gh + 0.4) {
          a.y = gh + 0.4;
          a.vy = Math.abs(a.vy) * 0.4;
        }
        a.pitch = clamp(-a.vy * 0.08, -0.5, 0.5);
      } else if (sp.gait === GAIT.SWIM) {
        if (wl === -Infinity) {
          // Beached: turn back toward deeper water.
          a.dir += Math.PI;
          a.x -= a.vx * dt * 3;
          a.z -= a.vz * dt * 3;
        } else {
          const floor = gh + 0.4;
          const ceil = wl - (sp.deep ? 1.5 : 0.35);
          const wantY = clamp(
            lerp(floor, ceil, 0.35 + 0.4 * (this.n.noise2(a.wander * 0.5, a.phase) * 0.5 + 0.5)),
            floor, Math.max(floor, ceil)
          );
          a.vy += clamp((wantY - a.y) * 0.7, -2, 2) * dt * 2;
          a.vy *= Math.exp(-dt * 1.6);
          a.y = clamp(a.y + a.vy * dt, floor, Math.max(floor, ceil));
          // A whale surfaces now and then to blow.
          if (sp.deep && a.y > ceil - 0.6 && Math.random() < dt * 0.6) {
            w.particles.steam(a.x, wl + 0.3, a.z, 3.4, 6);
            if (w.audio) w.audio.animalCall(sp.call, a.x, a.y, a.z, 0.9);
          }
        }
        a.pitch = clamp(-a.vy * 0.2, -0.6, 0.6);
      } else {
        // Ground animals hug the terrain and avoid deep water.
        a.y = gh;
        if (wl > gh + 0.9) {
          a.dir += Math.PI * (0.7 + Math.random() * 0.6);
          a.x -= a.vx * dt * 2.5;
          a.z -= a.vz * dt * 2.5;
        }
        const slope = 1 - w.terrain.normalAt(a.x, a.z, this._v).y;
        if (slope > 0.7 && sp.key !== 'goat') a.dir += dt * 2.2;
        a.pitch = 0;
      }

      a.speedN = clamp(Math.hypot(a.vx, a.vz) / sp.speed, 0, 1);

      /* --- voices ------------------------------------------------------ */
      if (sp.call && sp.voice > 0) {
        a.voiceT -= dt;
        if (a.voiceT <= 0) {
          a.voiceT = 1 / sp.voice * lerp(0.4, 1.8, Math.random());
          const night = 1 - w.sky.dayFactor;
          const active = sp.night ? night : 1 - night * 0.8;
          const singing = sp.key === 'songbird' || sp.key === 'bird';
          const dawnBoost = singing ? 1 + smoothstep(0.34, 0.26, Math.abs(w.sky.time - 0.28)) * 2 : 1;
          if (w.audio && dist < 130 && Math.random() < active * dawnBoost * 0.8) {
            w.audio.animalCall(sp.call, a.x, a.y + 0.6, a.z, clamp(1 - dist / 130, 0.1, 1));
          }
        }
      }
    }

    this._commit();
  }

  _commit() {
    for (const pool of this.pools) {
      const list = pool.animals;
      const mesh = pool.mesh;
      const n = Math.min(list.length, pool.sp.cap);
      mesh.count = n;
      for (let i = 0; i < n; i++) {
        const a = list[i];
        this._q.setFromEuler(EULER.set(a.pitch, -a.dir + Math.PI * 0.5, a.bank, 'YXZ'));
        this._m4.compose(this._v.set(a.x, a.y, a.z), this._q, this._s.setScalar(a.scale));
        this._m4.toArray(mesh.instanceMatrix.array, i * 16);
        pool.phase.array[i] = a.phase;
        pool.motion.array[i * 3] = a.sp.gait;
        pool.motion.array[i * 3 + 1] = a.speedN;
        pool.motion.array[i * 3 + 2] = a.alert;
      }
      mesh.instanceMatrix.needsUpdate = true;
      pool.phase.needsUpdate = true;
      pool.motion.needsUpdate = true;
      mesh.visible = n > 0;
    }
  }

  /** Nearest animal to a point, for the interaction prompt. */
  nearest(x, y, z, range = 5) {
    let best = null;
    let bd = range * range;
    for (const a of this.animals) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2 + (a.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  /** Startle everything nearby - used by explosions and by felling trees. */
  startle(x, z, radius = 40) {
    for (const a of this.animals) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > radius) continue;
      a.alert = 1;
      a.resting = false;
      a.dir = Math.atan2(a.z - z, a.x - x);
      const boost = a.sp.speed * (1 - d / radius);
      a.vx = Math.cos(a.dir) * boost;
      a.vz = Math.sin(a.dir) * boost;
      if (a.sp.gait === GAIT.FLY) a.vy += 5;
    }
  }
}

const EULER = new THREE.Euler();

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function blendAngles(pairs) {
  let x = 0, y = 0;
  for (const [a, w] of pairs) {
    x += Math.cos(a) * w;
    y += Math.sin(a) * w;
  }
  return Math.atan2(y, x);
}

export { SPECIES as ANIMAL_SPECIES, GAIT };

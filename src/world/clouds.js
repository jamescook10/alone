// Clouds: instanced flat-shaded polyhedral clusters drifting with the wind.
//
// This replaced the raymarched volumetric pass. A cloud is now four to six
// squashed icosahedra merged into one chunky cluster, ~100 triangles, drawn
// as two instanced meshes - the whole sky of clouds costs two draw calls and
// no fragment marching at all.
//
// Placement is a hashed grid in wind-drifted space: each cell rolls once
// against the current cloud cover, so clouds pop into being far away, sail
// with the weather, and thin out as the front passes - with no stored state.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { injectAtmosphere } from '../gfx/atmosphere.js';
import { Rng, hash3f, saturate, smoothstep } from '../core/noise.js';

const CELL = 1050;      // metres of sky per possible cloud
const RADIUS = 6800;    // how far out clouds exist
const ALTITUDE = 640;
const CAP = 80;         // per variant

// Four kinds of cloud, because a sky that only ever makes fair-weather
// cumulus reads as the same afternoon every day. Which kind a cell grows is
// decided by the weather, not by the cell: an overcast front lays a flat
// stratus deck, a storm throws up towers, and settled air keeps its loaves.
const CUMULUS = 0, CUMULUS_BIG = 1, STRATUS = 2, TOWER = 3;

function merge(parts) {
  const merged = mergeGeometries(parts);
  merged.computeBoundingSphere();
  return merged;
}

function cumulusGeometry(seed, big) {
  const rng = new Rng(seed).next;
  const parts = [];
  const n = (big ? 5 : 4) + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const s = (big ? 0.7 : 0.55) + rng() * 0.8;
    // Wide and shallow: a cumulus is a loaf, not a ball.
    g.scale(s * (1.2 + rng() * 0.7), s * (0.42 + rng() * 0.22), s * (0.85 + rng() * 0.5));
    g.rotateY(rng() * Math.PI);
    g.translate((i - (n - 1) / 2) * 0.9 + (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.9);
    parts.push(g);
  }
  return merge(parts);
}

/** A featureless sheet: wide, thin, and overlapping its neighbours. */
function stratusGeometry(seed) {
  const rng = new Rng(seed).next;
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const s = 1.5 + rng() * 1.1;
    g.scale(s * 1.6, s * 0.14, s * 1.4);
    g.rotateY(rng() * Math.PI);
    g.translate((rng() - 0.5) * 3.4, (rng() - 0.5) * 0.20, (rng() - 0.5) * 3.4);
    parts.push(g);
  }
  return merge(parts);
}

/**
 * Cumulonimbus: a tower that goes up until it hits the tropopause and then
 * spreads sideways into an anvil, because it cannot go any higher. That
 * flat-topped silhouette is the one shape in the sky that tells you from ten
 * miles off that you are going to get wet.
 */
function towerGeometry(seed) {
  const rng = new Rng(seed).next;
  const parts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const k = i / (n - 1);
    const s = 1.0 - k * 0.32 + rng() * 0.25;
    g.scale(s * (0.95 + k * 0.25), s * 0.55, s * (0.9 + k * 0.2));
    g.rotateY(rng() * Math.PI);
    g.translate((rng() - 0.5) * 0.5, -0.7 + k * 2.9, (rng() - 0.5) * 0.5);
    parts.push(g);
  }
  for (let i = 0; i < 3; i++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const s = 1.5 + rng() * 0.7;
    g.scale(s * 1.5, s * 0.18, s * 1.3);
    g.rotateY(rng() * Math.PI);
    g.translate((rng() - 0.5) * 1.6 + 0.6, 2.5 + (rng() - 0.5) * 0.3, (rng() - 0.5) * 1.6);
    parts.push(g);
  }
  return merge(parts);
}

// Vertical scale and base altitude per kind, relative to the cell's own size.
const FORM = [
  { yScale: 0.75, alt: 1.00, size: 1.00 },
  { yScale: 0.75, alt: 1.05, size: 1.15 },
  { yScale: 0.60, alt: 0.72, size: 1.55 },
  { yScale: 1.00, alt: 0.85, size: 1.05 },
];

const M4 = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const VEC = new THREE.Vector3();
const SCL = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// One cloud, filled in place. Both the draw loop and the rain's "is there
// anything above me" query read the grid through this, so a cloud can never
// be drawn in one place and rained from another.
const C = { x: 0, y: 0, z: 0, s: 0, sy: 0, spin: 0, variant: 0 };

export class Clouds {
  constructor(world) {
    this.world = world;
    this.drift = new THREE.Vector2(0, 0);

    this.mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    injectAtmosphere(this.mat, { key: 'cloud', snow: false });

    const geos = [
      cumulusGeometry(world.seed, false),
      cumulusGeometry(world.seed + 131, true),
      stratusGeometry(world.seed + 262),
      towerGeometry(world.seed + 393),
    ];
    this.meshes = [];
    for (let v = 0; v < 4; v++) {
      const mesh = new THREE.InstancedMesh(geos[v], this.mat, CAP);
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span kilometres; cull per-cloud below
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      world.engine.scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** Fill C with the cloud living in cell (i,j), or return false if it is empty. */
  _cell(i, j, cover) {
    const roll = hash3f(i, j, 0xc10d);
    if (roll >= cover * 0.92) return false;
    const w = this.world.weather;
    const jx = hash3f(i, j, 3), jz = hash3f(i, j, 7);
    // Clouds swell in rather than popping: scale rises as cover clears the
    // cell's threshold.
    const grow = smoothstep(0, 0.22, cover * 0.92 - roll);
    // What kind of cloud this cell grows. The deck comes in first as the
    // front thickens, and only the tail of a real storm throws up towers -
    // one or two on the horizon, not a forest of them.
    const kind = hash3f(i, j, 0x5a1e);
    let variant;
    if (kind < w.overcast * 0.88) variant = STRATUS;
    else if (w.stormy > 0.62 && kind > 1 - (w.stormy - 0.6) * 0.55) variant = TOWER;
    else variant = (i + j) & 1;
    const f = FORM[variant];
    C.x = (i + 0.15 + jx * 0.7) * CELL - this.drift.x;
    C.z = (j + 0.15 + jz * 0.7) * CELL - this.drift.y;
    C.s = (115 + hash3f(i, j, 11) * 165) * (0.35 + grow * 0.65) * f.size;
    C.y = (ALTITUDE + hash3f(i, j, 13) * 260) * f.alt
      + Math.sin(this.world.time * 0.05 + jx * 9) * 12;
    C.sy = C.s * f.yScale;
    C.spin = jz;
    C.variant = variant;
    return true;
  }

  /**
   * What is overhead at a point: how much cloud (0-1) and how low its base
   * hangs. Rain asks this before it falls anywhere. The sky here is discrete
   * clusters with real gaps between them, so regional "it is raining" was
   * never enough on its own - it put a downpour under clear blue whenever the
   * player stood in a gap, and it kept raining around the aeroplane a
   * kilometre above the whole deck.
   */
  sampleAt(x, z) {
    const cover = this.world.weather.cloudCover;
    if (cover <= 0.02) return { cover: 0, base: Infinity };
    const ci = Math.floor((x + this.drift.x) / CELL);
    const cj = Math.floor((z + this.drift.y) / CELL);
    // Shafts broaden as the deck thickens: scattered cumulus drops a column
    // you can walk out of, an overcast front rains on nearly everything under
    // it. Measured over a 6 km square, that takes the ground getting no rain
    // at all from 48% under a showery sky to 6% under a full storm - so a
    // storm still soaks the world without rain ever falling out of blue sky.
    const spread = 3.0 + 1.6 * saturate((cover - 0.55) / 0.42);
    let acc = 0, base = Infinity, near = Infinity;
    // The widest shaft reaches ~1.3 km, so two rings of cells is enough.
    for (let j = cj - 2; j <= cj + 2; j++) {
      for (let i = ci - 2; i <= ci + 2; i++) {
        if (!this._cell(i, j, cover)) continue;
        // Base of the cluster, not its centre: the geometry hangs about 0.6 of
        // a radius below the instance origin.
        const b = C.y - C.s * 0.6;
        const dx = x - C.x, dz = z - C.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        // The cluster is a rotated loaf; a disc stands in for it and for the
        // drift of what falls out of it - rain reaches the ground a little
        // wider than the cloud is. The soft edge is what makes walking out
        // from under a shower take a few seconds, not one step.
        const r = C.s * spread;
        const w = smoothstep(r, r * 0.5, d);
        if (w > 0.2) base = Math.min(base, b);
        else near = Math.min(near, b);
        if (w > 0.01) acc += w;
      }
    }
    return { cover: saturate(acc), base: Number.isFinite(base) ? base : near };
  }

  update(dt) {
    const w = this.world.weather;
    const sky = this.world.sky;
    const p = this.world.player.position;

    // Clouds sail with the wind. The grid is sampled in drifted space, so a
    // cloud's cell - and with it the cloud - moves as one rigid sheet.
    this.drift.x += w.windDir.x * w.wind * dt * 7;
    this.drift.y += w.windDir.y * w.wind * dt * 7;

    const cover = w.cloudCover;
    const counts = [0, 0, 0, 0];
    if (cover > 0.02) {
      const ci = Math.floor((p.x + this.drift.x) / CELL);
      const cj = Math.floor((p.z + this.drift.y) / CELL);
      const rings = Math.ceil(RADIUS / CELL);
      // Outward in square rings, not row by row. Under a solid overcast
      // nearly every cell has a cloud in it, so a raster scan filled all
      // eighty instance slots on the first two rows and left the whole rest
      // of the sky empty - a full stratus deck sat in one far corner. Nearest
      // first means the cap only ever drops what is furthest away.
      for (let r = 0; r <= rings; r++) {
        let room = false;
        for (let v = 0; v < 4; v++) if (counts[v] < CAP) room = true;
        if (!room) break;
        for (let j = cj - r; j <= cj + r; j++) {
          const edge = j === cj - r || j === cj + r;
          for (let i = ci - r; i <= ci + r; i += edge ? 1 : 2 * r) {
            if (!this._cell(i, j, cover)) continue;
            const dx = C.x - p.x, dz = C.z - p.z;
            if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
            const v = C.variant;
            if (counts[v] >= CAP) continue;
            QUAT.setFromAxisAngle(UP, C.spin * Math.PI * 2);
            M4.compose(VEC.set(C.x, C.y, C.z), QUAT, SCL.set(C.s, C.sy, C.s));
            this.meshes[v].setMatrixAt(counts[v]++, M4);
          }
        }
      }
    }
    for (let v = 0; v < 4; v++) {
      this.meshes[v].count = counts[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.meshes[v].visible = counts[v] > 0;
    }

    // Lit by the same palette as everything else: bodies take the sun's tint
    // (grey under storm dark), undersides lifted by the horizon colour so
    // they never go mud.
    const dark = 1 - w.cloudDark * 0.45;
    this.mat.color.setRGB(0.92 * dark, 0.93 * dark, 0.95 * dark);
    this.mat.emissive.copy(sky.horizonColor).multiplyScalar(0.5 * saturate(0.25 + sky.dayFactor));
    // A stroke inside the deck lights the whole cloud from within, and that
    // is what you see of most of them.
    if (w.lightning > 0.01) this.mat.emissive.addScalar(w.lightning * 0.55);
  }
}

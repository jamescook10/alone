// Everything that grows.
//
// Trees are built procedurally at boot - one geometry per species - and drawn
// from packed instance pools, so a forest of ten thousand trees is a couple of
// dozen draw calls. Growth happens in the vertex shader: each instance carries
// the world-day it sprouted, so trees get visibly taller while you watch, and
// a seed you push into the soil becomes a sapling and then a tree.

import * as THREE from 'three';
import { makeFoliageMaterial, makeSolidMaterial, grassTexture } from '../gfx/materials.js';
import { Rng, hash3f, clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { BIOME_INFO } from './worldgen.js';

export const SPECIES = {
  OAK: 0, PINE: 1, BIRCH: 2, PALM: 3, ACACIA: 4, CACTUS: 5, WILLOW: 6, SNAG: 7,
  JUNGLE: 8, SPRUCE: 9, BUSH: 10, FERN: 11, SAPLING: 12,
};

export const SPECIES_INFO = [
  { name: 'oak', height: 11, cap: 2600, fruit: 'apple', fruitChance: 0.5, mature: 5.5, burn: 1.0, wood: 4 },
  { name: 'pine', height: 15, cap: 2600, fruit: 'pinecone', fruitChance: 0.3, mature: 6.5, burn: 1.3, wood: 4 },
  { name: 'birch', height: 12, cap: 1800, fruit: null, fruitChance: 0, mature: 4.5, burn: 1.1, wood: 3 },
  { name: 'palm', height: 13, cap: 900, fruit: 'coconut', fruitChance: 0.6, mature: 6, burn: 0.9, wood: 3 },
  { name: 'acacia', height: 9, cap: 900, fruit: null, fruitChance: 0, mature: 6, burn: 1.0, wood: 3 },
  { name: 'cactus', height: 4.5, cap: 700, fruit: 'prickly pear', fruitChance: 0.45, mature: 8, burn: 0.4, wood: 1 },
  { name: 'willow', height: 10, cap: 700, fruit: null, fruitChance: 0, mature: 5, burn: 0.9, wood: 3 },
  { name: 'dead tree', height: 8, cap: 900, fruit: null, fruitChance: 0, mature: 3, burn: 1.8, wood: 3 },
  { name: 'kapok', height: 24, cap: 1400, fruit: 'mango', fruitChance: 0.5, mature: 9, burn: 0.9, wood: 6 },
  { name: 'spruce', height: 17, cap: 2200, fruit: null, fruitChance: 0.15, mature: 7, burn: 1.4, wood: 4 },
  { name: 'bush', height: 1.5, cap: 3000, fruit: 'berries', fruitChance: 0.55, mature: 1.6, burn: 1.5, wood: 1 },
  { name: 'fern', height: 1.1, cap: 2200, fruit: null, fruitChance: 0, mature: 1.2, burn: 1.2, wood: 0 },
  { name: 'sapling', height: 1.0, cap: 400, fruit: null, fruitChance: 0, mature: 1.0, burn: 1.4, wood: 0 },
];

const GROW_VERT_PARS = /* glsl */ `
attribute float aBirth;
attribute float aRate;
attribute vec3 aTint;
uniform float uWorldDay;
varying vec3 vTint;
`;

const GROW_VERT_BODY = /* glsl */ `
{
  float age = max( 0.0, uWorldDay - aBirth );
  float m = clamp( pow( age * aRate, 0.55 ), 0.035, 1.0 );
  transformed *= m;
  vTint = aTint;
}
`;

/* ------------------------------------------------------- geometry builder */

class MeshBuilder {
  constructor() {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.idx = [];
  }
  get count() {
    return this.pos.length / 3;
  }
  vert(x, y, z, nx, ny, nz, c) {
    this.pos.push(x, y, z);
    this.norm.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  /** Tapered tube between two points. */
  tube(x0, y0, z0, x1, y1, z1, r0, r1, sides, c, cTop) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1e-4;
    const ax = dx / len, ay = dy / len, az = dz / len;
    // build an orthonormal basis around the axis
    let ux = 0, uy = 0, uz = 1;
    if (Math.abs(az) > 0.9) { ux = 1; uz = 0; }
    let vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    let vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl; vy /= vl; vz /= vl;
    const wx = ay * vz - az * vy, wy = az * vx - ax * vz, wz = ax * vy - ay * vx;
    const base = this.count;
    const top = cTop || c;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = vx * ca + wx * sa, ny = vy * ca + wy * sa, nz = vz * ca + wz * sa;
      this.vert(x0 + nx * r0, y0 + ny * r0, z0 + nz * r0, nx, ny, nz, c);
      this.vert(x1 + nx * r1, y1 + ny * r1, z1 + nz * r1, nx, ny, nz, top);
    }
    for (let i = 0; i < sides; i++) {
      const a0 = base + i * 2;
      const b0 = base + ((i + 1) % sides) * 2;
      this.tri(a0, a0 + 1, b0 + 1);
      this.tri(a0, b0 + 1, b0);
    }
  }
  /** Low-poly ellipsoid blob, used for leaf masses. */
  blob(cx, cy, cz, rx, ry, rz, rings, seg, c, jitter = 0.18, rng = Math.random) {
    const base = this.count;
    for (let j = 0; j <= rings; j++) {
      const v = (j / rings) * Math.PI;
      const sv = Math.sin(v), cv = Math.cos(v);
      for (let i = 0; i < seg; i++) {
        const u = (i / seg) * Math.PI * 2;
        const jr = 1 + (rng() - 0.5) * jitter * 2;
        const nx = Math.cos(u) * sv, ny = cv, nz = Math.sin(u) * sv;
        const sh = 0.88 + Math.abs(ny) * 0.2;
        this.vert(cx + nx * rx * jr, cy + ny * ry * jr, cz + nz * rz * jr, nx, ny, nz,
          [c[0] * sh, c[1] * sh, c[2] * sh]);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * seg + i;
        const b = base + j * seg + ((i + 1) % seg);
        const cc = a + seg;
        const d = b + seg;
        this.tri(a, cc, d);
        this.tri(a, d, b);
      }
    }
  }
  /** A flat double-sided blade/frond, curving along its length. */
  blade(x, y, z, dirX, dirZ, len, width, droop, segs, c, tipC) {
    const base = this.count;
    const dl = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / dl, dz = dirZ / dl;
    const px = -dz, pz = dx;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const along = t * len;
      const yy = y + Math.sin(t * 1.35) * len * 0.5 - droop * t * t * len;
      const w = width * (1 - t * 0.85) * Math.sin(Math.min(1, t * 3.2 + 0.25) * 1.5);
      const cc = tipC ? [lerp(c[0], tipC[0], t), lerp(c[1], tipC[1], t), lerp(c[2], tipC[2], t)] : c;
      this.vert(x + dx * along - px * w, yy, z + dz * along - pz * w, 0, 1, 0, cc);
      this.vert(x + dx * along + px * w, yy, z + dz * along + pz * w, 0, 1, 0, cc);
    }
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      this.tri(a, a + 1, a + 3);
      this.tri(a, a + 3, a + 2);
    }
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------ tree recipes */

// Bark reflectances sit a third higher than the first pass: at the old
// values, trunks metered as pure black cutouts against any daytime sky.
const BARK = {
  oak: [0.152, 0.112, 0.076],
  pine: [0.126, 0.087, 0.061],
  birch: [0.702, 0.682, 0.634],
  palm: [0.224, 0.177, 0.116],
  acacia: [0.190, 0.152, 0.104],
  cactus: [0.084, 0.155, 0.074],
  dead: [0.204, 0.180, 0.154],
  jungle: [0.176, 0.150, 0.118],
};
const LEAF = {
  oak: [0.108, 0.201, 0.056],
  pine: [0.067, 0.137, 0.070],
  birch: [0.166, 0.263, 0.079],
  palm: [0.123, 0.236, 0.079],
  acacia: [0.184, 0.219, 0.084],
  cactus: [0.123, 0.228, 0.102],
  willow: [0.154, 0.228, 0.091],
  jungle: [0.079, 0.175, 0.056],
  spruce: [0.052, 0.108, 0.063],
  bush: [0.102, 0.184, 0.061],
  fern: [0.096, 0.201, 0.074],
};

/** Recursive branching used by the broadleaf species. */
function branch(bark, leaf, rng, opts, x, y, z, dx, dy, dz, len, rad, depth) {
  const x1 = x + dx * len, y1 = y + dy * len, z1 = z + dz * len;
  const rTop = rad * opts.taper;
  bark.tube(x, y, z, x1, y1, z1, rad, rTop, depth > 2 ? 4 : 5, opts.barkCol);
  // A handful of large canopy masses rather than one per twig: a tree needs a
  // convincing silhouette, and a silhouette is cheap.
  if (opts.leafCol && depth <= 0) {
    const s = len * opts.leafScale;
    leaf.blob(x1, y1 + s * 0.22, z1, s * 1.30, s * 1.02, s * 1.30, 3, 6, opts.leafCol, 0.30, rng);
  }
  if (depth <= 0 || len < opts.minLen) return;
  const n = rng() < opts.trifurcate ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const spread = opts.spread * (0.55 + rng() * 0.9);
    const ang = (i / n) * Math.PI * 2 + rng() * 2.2;
    let ndx = dx + Math.cos(ang) * spread;
    let ndz = dz + Math.sin(ang) * spread;
    let ndy = dy * (0.72 + rng() * 0.30) + opts.upBias;
    const l = Math.hypot(ndx, ndy, ndz) || 1;
    branch(bark, leaf, rng, opts, x1, y1, z1, ndx / l, ndy / l, ndz / l,
      len * (opts.shrink + rng() * 0.14), rTop, depth - 1);
  }
}

function buildSpecies(sp, seed) {
  const rng = new Rng(seed + sp * 977).next;
  const bark = new MeshBuilder();
  const leaf = new MeshBuilder();
  const H = SPECIES_INFO[sp].height;

  switch (sp) {
    case SPECIES.OAK:
      branch(bark, leaf, rng, {
        barkCol: BARK.oak, leafCol: LEAF.oak, taper: 0.76, spread: 0.62, upBias: 0.30,
        shrink: 0.68, minLen: H * 0.10, leafScale: 1.10, trifurcate: 0.45,
      }, 0, 0, 0, 0, 1, 0, H * 0.46, H * 0.045, 2);
      break;
    case SPECIES.BIRCH:
      branch(bark, leaf, rng, {
        barkCol: BARK.birch, leafCol: LEAF.birch, taper: 0.82, spread: 0.34, upBias: 0.62,
        shrink: 0.72, minLen: H * 0.09, leafScale: 0.95, trifurcate: 0.4,
      }, 0, 0, 0, 0, 1, 0, H * 0.44, H * 0.028, 2);
      break;
    case SPECIES.ACACIA:
      branch(bark, leaf, rng, {
        barkCol: BARK.acacia, leafCol: null, taper: 0.72, spread: 0.95, upBias: 0.12,
        shrink: 0.66, minLen: H * 0.14, leafScale: 1.0, trifurcate: 0.5,
      }, 0, 0, 0, 0, 1, 0, H * 0.40, H * 0.05, 3);
      // flat-topped canopy
      for (let i = 0; i < 5; i++) {
        const a = rng() * 6.283;
        const r = rng() * H * 0.42;
        leaf.blob(Math.cos(a) * r, H * (0.78 + rng() * 0.1), Math.sin(a) * r,
          H * 0.30, H * 0.055, H * 0.30, 2, 6, LEAF.acacia, 0.2, rng);
      }
      break;
    case SPECIES.JUNGLE:
      branch(bark, leaf, rng, {
        barkCol: BARK.jungle, leafCol: LEAF.jungle, taper: 0.84, spread: 0.42, upBias: 0.55,
        shrink: 0.70, minLen: H * 0.07, leafScale: 1.15, trifurcate: 0.4,
      }, 0, 0, 0, 0, 1, 0, H * 0.40, H * 0.042, 2);
      // buttress roots
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * 6.283 + rng();
        bark.tube(Math.cos(a) * H * 0.055, 0, Math.sin(a) * H * 0.055, 0, H * 0.10, 0,
          H * 0.016, H * 0.010, 4, BARK.jungle);
      }
      break;
    case SPECIES.WILLOW:
      branch(bark, leaf, rng, {
        barkCol: BARK.oak, leafCol: LEAF.willow, taper: 0.74, spread: 0.72, upBias: 0.22,
        shrink: 0.68, minLen: H * 0.13, leafScale: 0.95, trifurcate: 0.4,
      }, 0, 0, 0, 0, 1, 0, H * 0.34, H * 0.05, 2);
      for (let i = 0; i < 14; i++) {
        const a = rng() * 6.283;
        const r = H * (0.14 + rng() * 0.30);
        leaf.blade(Math.cos(a) * r, H * (0.62 + rng() * 0.22), Math.sin(a) * r,
          Math.cos(a), Math.sin(a), H * 0.30, H * 0.020, 1.9, 4, LEAF.willow);
      }
      break;
    case SPECIES.PINE:
    case SPECIES.SPRUCE: {
      const col = sp === SPECIES.SPRUCE ? LEAF.spruce : LEAF.pine;
      bark.tube(0, 0, 0, 0, H, 0, H * 0.035, H * 0.006, 6, BARK.pine);
      const tiers = sp === SPECIES.SPRUCE ? 7 : 6;
      for (let i = 0; i < tiers; i++) {
        const t = i / (tiers - 1);
        const y = H * (0.16 + t * 0.80);
        const r = H * (0.30 - t * 0.245) * (0.85 + rng() * 0.3);
        const hh = H * 0.16;
        // a squashed cone per tier, drawn as a blob for softer silhouettes
        leaf.blob(0, y + hh * 0.2, 0, r, hh * 0.85, r, 2, 6, col, 0.26, rng);
      }
      leaf.blob(0, H * 0.99, 0, H * 0.035, H * 0.075, H * 0.035, 2, 5, col, 0.2, rng);
      break;
    }
    case SPECIES.PALM: {
      const lean = (rng() - 0.5) * 0.34;
      let px = 0, py = 0, pz = 0;
      const segs = 7;
      for (let i = 0; i < segs; i++) {
        const t = i / segs;
        const t2 = (i + 1) / segs;
        const nx = lean * H * t2 * t2, ny = H * t2, nz = lean * 0.4 * H * t2 * t2;
        bark.tube(px, py, pz, nx, ny, nz, H * 0.030 * (1 - t * 0.4), H * 0.030 * (1 - t2 * 0.4), 5, BARK.palm);
        px = nx; py = ny; pz = nz;
      }
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 6.283 + rng() * 0.4;
        leaf.blade(px, py, pz, Math.cos(a), Math.sin(a), H * 0.46, H * 0.075, 1.1, 5,
          LEAF.palm, [LEAF.palm[0] * 1.5, LEAF.palm[1] * 1.3, LEAF.palm[2] * 1.2]);
      }
      for (let i = 0; i < 3; i++) {
        const a = rng() * 6.283;
        leaf.blob(px + Math.cos(a) * H * 0.03, py - H * 0.03, pz + Math.sin(a) * H * 0.03,
          H * 0.028, H * 0.028, H * 0.028, 1, 5, [0.22, 0.16, 0.07], 0.2, rng);
      }
      break;
    }
    case SPECIES.CACTUS: {
      bark.tube(0, 0, 0, 0, H * 0.86, 0, H * 0.13, H * 0.10, 8, BARK.cactus);
      leaf.blob(0, H * 0.90, 0, H * 0.11, H * 0.10, H * 0.11, 2, 7, BARK.cactus, 0.1, rng);
      const arms = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < arms; i++) {
        const a = rng() * 6.283;
        const y = H * (0.32 + rng() * 0.3);
        const ex = Math.cos(a) * H * 0.26, ez = Math.sin(a) * H * 0.26;
        bark.tube(0, y, 0, ex, y, ez, H * 0.065, H * 0.055, 6, BARK.cactus);
        bark.tube(ex, y, ez, ex, y + H * 0.34, ez, H * 0.058, H * 0.048, 6, BARK.cactus);
        leaf.blob(ex, y + H * 0.37, ez, H * 0.055, H * 0.05, H * 0.055, 2, 6, BARK.cactus, 0.1, rng);
      }
      break;
    }
    case SPECIES.SNAG:
      branch(bark, leaf, rng, {
        barkCol: BARK.dead, leafCol: null, taper: 0.66, spread: 0.80, upBias: 0.34,
        shrink: 0.62, minLen: H * 0.11, leafScale: 0, trifurcate: 0.3,
      }, 0, 0, 0, 0.06, 1, 0.03, H * 0.46, H * 0.045, 3);
      break;
    case SPECIES.BUSH: {
      const n = 4 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const r = rng() * 0.35;
        bark.tube(0, 0, 0, Math.cos(a) * r, 0.55 + rng() * 0.3, Math.sin(a) * r, 0.045, 0.02, 4, BARK.oak);
        leaf.blob(Math.cos(a) * r, 0.75 + rng() * 0.35, Math.sin(a) * r,
          0.44, 0.36, 0.44, 2, 6, LEAF.bush, 0.32, rng);
      }
      break;
    }
    case SPECIES.FERN: {
      const n = 7 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + rng() * 0.5;
        leaf.blade(0, 0.06, 0, Math.cos(a), Math.sin(a), 0.85 + rng() * 0.4, 0.10, 0.55, 4,
          LEAF.fern, [LEAF.fern[0] * 1.4, LEAF.fern[1] * 1.25, LEAF.fern[2] * 1.1]);
      }
      break;
    }
    default: {
      bark.tube(0, 0, 0, 0, 0.8, 0, 0.03, 0.018, 4, BARK.oak);
      leaf.blob(0, 0.95, 0, 0.24, 0.22, 0.24, 2, 5, LEAF.oak, 0.2, rng);
    }
  }
  return {
    bark: bark.count ? bark.toGeometry() : null,
    leaf: leaf.count ? leaf.toGeometry() : null,
  };
}


/**
 * A deliberately crude version of each species, about thirty triangles, used
 * for everything past the nearest ring of chunks. At that distance a tree is
 * a silhouette, and thirty triangles is a perfectly good silhouette.
 */
function buildFarSpecies(sp, seed) {
  const rng = new Rng(seed + sp * 313).next;
  const b = new MeshBuilder();
  const H = SPECIES_INFO[sp].height;
  const conifer = sp === SPECIES.PINE || sp === SPECIES.SPRUCE;
  const bare = sp === SPECIES.SNAG;
  const trunkCol = conifer ? BARK.pine : sp === SPECIES.BIRCH ? BARK.birch : bare ? BARK.dead : BARK.oak;
  const leafCol = conifer ? (sp === SPECIES.SPRUCE ? LEAF.spruce : LEAF.pine)
    : sp === SPECIES.PALM ? LEAF.palm
    : sp === SPECIES.JUNGLE ? LEAF.jungle
    : sp === SPECIES.ACACIA ? LEAF.acacia
    : sp === SPECIES.CACTUS ? BARK.cactus
    : LEAF.oak;
  if (sp === SPECIES.FERN || sp === SPECIES.BUSH) {
    b.blob(0, H * 0.5, 0, H * 0.42, H * 0.42, H * 0.42, 2, 4, leafCol, 0.3, rng);
    return b.toGeometry();
  }
  b.tube(0, 0, 0, 0, H * (bare ? 0.9 : conifer ? 0.95 : 0.6), 0, H * 0.035, H * 0.016, 4, trunkCol);
  if (bare) {
    b.tube(0, H * 0.5, 0, H * 0.26, H * 0.8, 0, H * 0.018, H * 0.006, 3, trunkCol);
    b.tube(0, H * 0.55, 0, -H * 0.22, H * 0.85, H * 0.1, H * 0.018, H * 0.006, 3, trunkCol);
    return b.toGeometry();
  }
  if (conifer) {
    b.blob(0, H * 0.52, 0, H * 0.24, H * 0.44, H * 0.24, 2, 4, leafCol, 0.16, rng);
  } else if (sp === SPECIES.PALM) {
    b.blob(0, H * 0.66, 0, H * 0.34, H * 0.10, H * 0.34, 2, 4, leafCol, 0.30, rng);
  } else if (sp === SPECIES.CACTUS) {
    b.blob(0, H * 0.55, 0, H * 0.14, H * 0.42, H * 0.14, 2, 4, leafCol, 0.10, rng);
  } else {
    b.blob(0, H * 0.72, 0, H * 0.36, H * 0.30, H * 0.36, 2, 4, leafCol, 0.26, rng);
  }
  return b.toGeometry();
}

/* ------------------------------------------------------------ instance pool */

class Pool {
  constructor(geo, mat, capacity, scene, extraAttrs = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.capacity = capacity;
    this.owners = new Array(capacity).fill(null);
    if (extraAttrs) {
      this.birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.rate = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this.birth.setUsage(THREE.DynamicDrawUsage);
      this.rate.setUsage(THREE.DynamicDrawUsage);
      this.tint.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aBirth', this.birth);
      geo.setAttribute('aRate', this.rate);
      geo.setAttribute('aTint', this.tint);
    }
    this.dirty = false;
    scene.add(this.mesh);
  }
  /** Packed allocation: instances always occupy [0, count). */
  alloc(owner) {
    if (this.mesh.count >= this.capacity) return -1;
    const i = this.mesh.count++;
    this.owners[i] = owner;
    this.dirty = true;
    return i;
  }
  /** Swap-remove keeps the buffer packed; the moved instance is reported. */
  free(i) {
    const last = this.mesh.count - 1;
    if (i !== last) {
      this._copy(last, i);
      const movedOwner = this.owners[last];
      this.owners[i] = movedOwner;
      if (movedOwner) movedOwner.onSlotMoved(this, last, i);
    }
    this.owners[last] = null;
    this.mesh.count = last;
    this.dirty = true;
  }
  _copy(from, to) {
    const m = this.mesh.instanceMatrix.array;
    for (let k = 0; k < 16; k++) m[to * 16 + k] = m[from * 16 + k];
    if (this.birth) {
      this.birth.array[to] = this.birth.array[from];
      this.rate.array[to] = this.rate.array[from];
      for (let k = 0; k < 3; k++) this.tint.array[to * 3 + k] = this.tint.array[from * 3 + k];
    }
  }
  setMatrix(i, m) {
    m.toArray(this.mesh.instanceMatrix.array, i * 16);
    this.dirty = true;
  }
  setGrowth(i, birth, rate, tr, tg, tb) {
    if (!this.birth) return;
    this.birth.array[i] = birth;
    this.rate.array[i] = rate;
    this.tint.array[i * 3] = tr;
    this.tint.array[i * 3 + 1] = tg;
    this.tint.array[i * 3 + 2] = tb;
    this.dirty = true;
  }
  commit() {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.birth) {
      this.birth.needsUpdate = true;
      this.rate.needsUpdate = true;
      this.tint.needsUpdate = true;
    }
    this.dirty = false;
  }
}

/* ---------------------------------------------------------------- the flora */

const M4 = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const VEC = new THREE.Vector3();
const SCL = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Flora {
  constructor(world) {
    this.world = world;
    this.scene = world.engine.scene;
    this.growUniform = { uWorldDay: { value: 0 } };

    this.barkMat = makeFoliageMaterial({
      key: 'bark', stiffness: 0.05, sway: 0.35,
      uniforms: this.growUniform,
    });
    this.leafMat = makeFoliageMaterial({
      key: 'leaf', stiffness: 0.11, sway: 1.0, doubleSide: true, translucency: 0.85,
      colorVar: 0.55,
      uniforms: this.growUniform,
    });
    this._patchGrowth(this.barkMat);
    this._patchGrowth(this.leafMat);

    this.rockMat = makeSolidMaterial({ key: 'rock', flat: true, roughness: 0.94 });
    this.fruitMat = makeSolidMaterial({ key: 'fruit', roughness: 0.55 });

    this.barkPools = [];
    this.leafPools = [];
    this.farPools = [];
    for (let sp = 0; sp < SPECIES_INFO.length; sp++) {
      const g = buildSpecies(sp, world.seed);
      const cap = SPECIES_INFO[sp].cap;
      this.barkPools[sp] = g.bark ? new Pool(g.bark, this.barkMat, cap, this.scene) : null;
      this.leafPools[sp] = g.leaf ? new Pool(g.leaf, this.leafMat, cap, this.scene) : null;
      const farPool = new Pool(buildFarSpecies(sp, world.seed), this.leafMat, cap * 2, this.scene);
      farPool.mesh.castShadow = false;
      this.farPools[sp] = farPool;
    }

    // Rocks: one blobby geometry, scaled and rotated per instance.
    const rb = new MeshBuilder();
    const rrng = new Rng(world.seed ^ 0x9a3).next;
    rb.blob(0, 0.25, 0, 0.6, 0.42, 0.55, 2, 5, [0.145, 0.138, 0.128], 0.40, rrng);
    this.rockPool = new Pool(rb.toGeometry(), this.rockMat, 9000, this.scene, false);
    this.rockPool.mesh.castShadow = true;

    // Fruit clusters.
    const fb = new MeshBuilder();
    const frng = new Rng(world.seed ^ 0x77c).next;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * 6.283;
      fb.blob(Math.cos(a) * 0.10, Math.sin(i) * 0.06, Math.sin(a) * 0.10, 0.085, 0.085, 0.085, 2, 5, [1, 1, 1], 0.12, frng);
    }
    this.fruitPool = new Pool(fb.toGeometry(), this.fruitMat, 1400, this.scene);
    this._patchGrowth(this.fruitMat);

    this._buildGrass();

    this.chunks = new Map(); // node -> entry
    this.plantIndex = new Map(); // cell key -> [plant records] for lookup
    this.worldDay = 0;
  }

  _patchGrowth(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      shader.uniforms.uWorldDay = this.growUniform.uWorldDay;
      shader.vertexShader = shader.vertexShader.replace(
        'varying vec3 vWorldPos;',
        'varying vec3 vWorldPos;\n' + GROW_VERT_PARS
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        GROW_VERT_BODY + '\n#include <project_vertex>'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'varying vec3 vWorldPos;',
        'varying vec3 vWorldPos;\nvarying vec3 vTint;'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb *= vTint;'
      );
    };
  }

  _buildGrass() {
    const tex = grassTexture();
    const mat = makeFoliageMaterial({
      key: 'grass', stiffness: 0.55, sway: 2.6, doubleSide: true, translucency: 1.30,
      alphaTest: 0.42, map: tex, uniforms: this.growUniform,
    });
    mat.map.wrapS = mat.map.wrapT = THREE.ClampToEdgeWrapping;
    this.grassMat = mat;
    const g = new THREE.BufferGeometry();
    // three crossed quads
    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    const H = 0.42;
    const W = 0.27;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const dx = Math.cos(a) * W, dz = Math.sin(a) * W;
      const b = pos.length / 3;
      pos.push(-dx, 0, -dz, dx, 0, dz, dx, H, dz, -dx, H, -dz);
      // Normals lean well upward: blades shade like the meadow they stand
      // in, instead of metering as dark side-lit fins against bright ground.
      for (let i = 0; i < 4; i++) nrm.push(-Math.sin(a) * 0.55, 0.78, Math.cos(a) * 0.55);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(1), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.grassPool = new Pool(g, mat, 84000, this.scene);
    this.grassPool.mesh.castShadow = false;
    this.grassPool.mesh.receiveShadow = false;
  }

  /* ------------------------------------------------------------- streaming */

  onChunkLoaded(node, scatter) {
    const entry = {
      node,
      // Only the ring you can actually walk through gets full geometry.
      far: node.lod >= 1,
      visible: true,
      plants: [], // {sp, slotBark, slotLeaf, slotFruit, x,y,z, scale, rot, id, birth, health, fruit}
      rocks: [],
      grass: [],
      onSlotMoved: null,
    };
    entry.onSlotMoved = (pool, from, to) => this._slotMoved(entry, pool, from, to);
    this.chunks.set(node, entry);

    const edits = this.world.edits;
    const P = scatter.plants;
    for (let i = 0; i < P.length; i += 9) {
      const id = P[i + 8] >>> 0;
      if (edits.removedPlants.has(id)) continue;
      this._addPlant(entry, {
        sp: P[i + 3] | 0,
        x: P[i], y: P[i + 1], z: P[i + 2],
        scale: P[i + 4], rot: P[i + 5],
        ageSeed: P[i + 6],
        id,
        health: edits.plantHealth.has(id) ? edits.plantHealth.get(id) : 1,
      });
    }
    // Anything the player planted inside this chunk.
    for (const p of edits.plantedPlants) {
      if (p.x >= node.x && p.x < node.x + node.size && p.z >= node.z && p.z < node.z + node.size) {
        this._addPlant(entry, p);
      }
    }

    const R = scatter.rocks;
    entry.rockSrc = R;
    entry.rockAt = [];
    for (let i = 0; i < R.length; i += 8) {
      const slot = this.rockPool.alloc(entry);
      if (slot < 0) break;
      this.rockPool.setMatrix(slot, this._rockMatrix(R, i));
      entry.rocks.push(slot);
      entry.rockAt.push(i);
    }

    const G = scatter.grass;
    const biomeTint = [0.9, 1.0, 0.8];
    for (let i = 0; i < G.length; i += 6) {
      const slot = this.grassPool.alloc(entry);
      if (slot < 0) break;
      const s = G[i + 3];
      QUAT.setFromAxisAngle(UP, G[i + 4]);
      M4.compose(VEC.set(G[i], G[i + 1], G[i + 2]), QUAT, SCL.set(s, s * (0.8 + s * 0.5), s));
      this.grassPool.setMatrix(slot, M4);
      const type = G[i + 5] | 0;
      const t = type === 0
        ? [0.30 + hash3f(i, node.x | 0, 3) * 0.20, 0.40, 0.20]
        : FLOWER_TINTS[(type - 1) % FLOWER_TINTS.length];
      this.grassPool.setGrowth(slot, -999, 99, t[0], t[1], t[2]);
      entry.grass.push(slot);
    }
  }

  _poolsFor(rec) {
    if (rec.far) return [this.farPools[rec.sp], null];
    return [this.barkPools[rec.sp], this.leafPools[rec.sp]];
  }

  _addPlant(entry, p) {
    const info = SPECIES_INFO[p.sp];
    const far = !!entry.far;
    const bp = far ? this.farPools[p.sp] : this.barkPools[p.sp];
    const lp = far ? null : this.leafPools[p.sp];
    const rec = {
      sp: p.sp, x: p.x, y: p.y, z: p.z, scale: p.scale, rot: p.rot,
      id: p.id, health: p.health !== undefined ? p.health : 1,
      birth: p.birth !== undefined ? p.birth : -(p.ageSeed || 0.5) * info.mature * 3.4,
      rate: 1 / info.mature,
      slotBark: -1, slotLeaf: -1, slotFruit: -1,
      // Never picked reads as "picked infinitely long ago", not "picked at
      // time zero" - otherwise nothing in the world bears fruit until day 1.2.
      fruitTaken: p.fruitTaken !== undefined
        ? p.fruitTaken
        : (p.id !== undefined && this.world.edits.fruitTaken.has(p.id)
            ? this.world.edits.fruitTaken.get(p.id)
            : -1e9),
      far,
    };
    QUAT.setFromAxisAngle(UP, rec.rot);
    M4.compose(VEC.set(rec.x, rec.y, rec.z), QUAT, SCL.set(rec.scale, rec.scale, rec.scale));
    const burnt = 1 - saturate(1 - rec.health);
    const tint = rec.health >= 0.999 ? 1 : Math.max(0.10, rec.health);
    if (bp) {
      rec.slotBark = bp.alloc(entry);
      if (rec.slotBark >= 0) {
        bp.setMatrix(rec.slotBark, M4);
        bp.setGrowth(rec.slotBark, rec.birth, rec.rate, tint, tint * 0.92, tint * 0.88);
      }
    }
    if (lp && rec.health > 0.05) {
      rec.slotLeaf = lp.alloc(entry);
      if (rec.slotLeaf >= 0) {
        lp.setMatrix(rec.slotLeaf, M4);
        const v = 0.82 + hash3f(rec.id & 1023, rec.sp, 7) * 0.36;
        lp.setGrowth(rec.slotLeaf, rec.birth, rec.rate, tint * v, tint * (v * 1.02), tint * (v * 0.9));
      }
    }
    entry.plants.push(rec);

    if (!far && this.fruitReady(rec)) this._attachFruit(entry, rec);
    return rec;
  }

  /** Whether this individual is a bearing tree at all. */
  bearsFruit(rec) {
    const info = SPECIES_INFO[rec.sp];
    if (!info.fruit) return false;
    if (rec.health <= 0.6) return false;
    return hash3f(rec.id & 4095, 11, 3) < info.fruitChance;
  }

  /** Bearing, grown enough, and long enough since it was last stripped. */
  fruitReady(rec) {
    return this.bearsFruit(rec)
      && this.maturity(rec) > 0.55
      && this.worldDay - rec.fruitTaken >= FRUIT_REGROW;
  }

  /** Game-hours until this tree carries fruit again. */
  hoursUntilFruit(rec) {
    return Math.max(0, (FRUIT_REGROW - (this.worldDay - rec.fruitTaken)) * 24);
  }

  /**
   * Fruit used to be attached only when a chunk loaded, so a tree you stripped
   * stayed bare for the rest of the session. Walk the near chunks now and then
   * and let them come back.
   */
  _ripenFruit(dt) {
    this._ripenT = (this._ripenT || 0) - dt;
    if (this._ripenT > 0) return;
    this._ripenT = 2.5;
    for (const entry of this.chunks.values()) {
      if (!entry.visible || entry.far) continue;
      for (const p of entry.plants) {
        if (p.slotFruit >= 0) continue;
        if (this.fruitReady(p)) this._attachFruit(entry, p);
      }
    }
  }

  _attachFruit(entry, rec) {
    const info = SPECIES_INFO[rec.sp];
    const slot = this.fruitPool.alloc(entry);
    if (slot < 0) return;
    const h = info.height * rec.scale;
    const a = rec.rot + 1.1;
    const r = h * 0.16;
    QUAT.setFromAxisAngle(UP, a);
    M4.compose(
      VEC.set(rec.x + Math.cos(a) * r, rec.y + h * (rec.sp === SPECIES.BUSH ? 0.55 : 0.62), rec.z + Math.sin(a) * r),
      QUAT,
      SCL.set(rec.scale, rec.scale, rec.scale)
    );
    this.fruitPool.setMatrix(slot, M4);
    const c = FRUIT_TINTS[info.fruit] || [0.7, 0.2, 0.15];
    this.fruitPool.setGrowth(slot, rec.birth, rec.rate, c[0], c[1], c[2]);
    rec.slotFruit = slot;
  }

  _slotMoved(entry, pool, from, to) {
    // A swap-remove elsewhere relocated one of our instances: fix our records.
    if (pool === this.rockPool) {
      const i = entry.rocks.indexOf(from);
      if (i >= 0) entry.rocks[i] = to;
      return;
    }
    /* grass and plants below */
    if (pool === this.grassPool) {
      const i = entry.grass.indexOf(from);
      if (i >= 0) entry.grass[i] = to;
      return;
    }
    for (const p of entry.plants) {
      const [bp, lp] = this._poolsFor(p);
      if (pool === bp && p.slotBark === from) p.slotBark = to;
      else if (lp && pool === lp && p.slotLeaf === from) p.slotLeaf = to;
      else if (pool === this.fruitPool && p.slotFruit === from) p.slotFruit = to;
    }
  }

  onChunkUnloaded(node) {
    const entry = this.chunks.get(node);
    if (!entry) return;
    for (const p of entry.plants) this._freePlant(entry, p);
    for (const s of entry.rocks) this.rockPool.free(s);
    entry.rockSrc = null;
    entry.rockAt = null;
    for (const s of entry.grass) this.grassPool.free(s);
    entry.plants.length = 0;
    entry.rocks.length = 0;
    entry.grass.length = 0;
    this.chunks.delete(node);
  }

  _freePlant(entry, p) {
    const [bp, lp] = this._poolsFor(p);
    if (p.slotBark >= 0 && bp) bp.free(p.slotBark);
    if (p.slotLeaf >= 0 && lp) lp.free(p.slotLeaf);
    if (p.slotFruit >= 0) this.fruitPool.free(p.slotFruit);
    p.slotBark = p.slotLeaf = p.slotFruit = -1;
  }

  /**
   * Hide a chunk's plants without releasing their slots. Used when a coarse
   * chunk is superseded by its four finer children.
   */
  setChunkVisible(node, vis) {
    const entry = this.chunks.get(node);
    if (!entry || entry.visible === vis) return;
    entry.visible = vis;
    for (const p of entry.plants) {
      const [bp, lp] = this._poolsFor(p);
      if (p.slotBark >= 0) this._setSlotVisible(bp, p.slotBark, vis, p);
      if (p.slotLeaf >= 0) this._setSlotVisible(lp, p.slotLeaf, vis, p);
      if (p.slotFruit >= 0) this._setSlotVisible(this.fruitPool, p.slotFruit, vis, p);
    }
    for (let k = 0; k < entry.rocks.length; k++) {
      this.rockPool.setMatrix(entry.rocks[k],
        vis ? this._rockMatrix(entry.rockSrc, entry.rockAt[k]) : HIDDEN);
    }
  }

  _setSlotVisible(pool, slot, vis, p) {
    if (!pool) return;
    if (vis) {
      QUAT.setFromAxisAngle(UP, p.rot);
      M4.compose(VEC.set(p.x, p.y, p.z), QUAT, SCL.set(p.scale, p.scale, p.scale));
      pool.setMatrix(slot, M4);
    } else {
      pool.setMatrix(slot, HIDDEN);
    }
  }

  _rockMatrix(R, i) {
    EUL.set(R[i + 4], R[i + 5], R[i + 6]);
    QUAT.setFromEuler(EUL);
    const s = R[i + 3];
    return M4.compose(VEC.set(R[i], R[i + 1] - s * 0.15, R[i + 2]), QUAT, SCL.set(s, s * 0.8, s));
  }

  /* ------------------------------------------------------------ interaction */

  /** Maturity of a plant right now, 0..1. */
  maturity(p) {
    const age = Math.max(0, this.worldDay - p.birth);
    return clamp(Math.pow(age * p.rate, 0.55), 0.035, 1);
  }

  height(p) {
    return SPECIES_INFO[p.sp].height * p.scale * this.maturity(p);
  }

  /** Find the plant nearest a point, within range. */
  nearest(x, y, z, range = 4, want = null) {
    let best = null;
    let bestD = range * range;
    for (const entry of this.chunks.values()) {
      if (!entry.visible || entry.far) continue;
      for (const p of entry.plants) {
        const dx = p.x - x, dz = p.z - z;
        const h = this.height(p);
        const dy = clamp(y, p.y, p.y + h) - y;
        const d = dx * dx + dz * dz + dy * dy;
        if (d < bestD) {
          if (want === 'fruit' && p.slotFruit < 0) continue;
          bestD = d;
          best = { entry, plant: p };
        }
      }
    }
    return best;
  }

  /** All plants within a radius - used by fire spread and by animals. */
  within(x, z, radius, out = []) {
    const r2 = radius * radius;
    for (const entry of this.chunks.values()) {
      if (!entry.visible) continue;
      for (const p of entry.plants) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < r2) out.push({ entry, plant: p });
      }
    }
    return out;
  }

  pickFruit(hit) {
    const p = hit.plant;
    if (p.slotFruit < 0) return null;
    this.fruitPool.free(p.slotFruit);
    p.slotFruit = -1;
    p.fruitTaken = this.worldDay;
    this.world.edits.fruitTaken.set(p.id, this.worldDay);
    return SPECIES_INFO[p.sp].fruit;
  }

  /** Chop a plant down: it disappears and yields wood. */
  fell(hit) {
    const p = hit.plant;
    this._freePlant(hit.entry, p);
    const i = hit.entry.plants.indexOf(p);
    if (i >= 0) hit.entry.plants.splice(i, 1);
    this.world.edits.removedPlants.add(p.id);
    return { wood: Math.round(SPECIES_INFO[p.sp].wood * this.maturity(p)), species: p.sp };
  }

  /** Scorch a plant. health 0 removes its leaves and blackens the trunk. */
  damage(hit, amount) {
    const p = hit.plant;
    p.health = clamp(p.health - amount, 0, 1);
    this.world.edits.plantHealth.set(p.id, p.health);
    const tint = Math.max(0.10, p.health);
    const [bp, lp] = this._poolsFor(p);
    if (bp && p.slotBark >= 0) bp.setGrowth(p.slotBark, p.birth, p.rate, tint, tint * 0.92, tint * 0.88);
    if (lp && p.slotLeaf >= 0) {
      if (p.health < 0.25) {
        lp.free(p.slotLeaf);
        p.slotLeaf = -1;
      } else {
        lp.setGrowth(p.slotLeaf, p.birth, p.rate, tint, tint, tint * 0.85);
      }
    }
    if (p.health < 0.5 && p.slotFruit >= 0) {
      this.fruitPool.free(p.slotFruit);
      p.slotFruit = -1;
    }
    return p.health;
  }

  /** Push a seed into the ground. It becomes a sapling and grows from there. */
  plant(x, z, species) {
    const y = this.world.terrain.heightAt(x, z);
    const id = (Math.random() * 0xfffffff) >>> 0;
    const rec = {
      sp: species, x, y, z,
      scale: 0.85 + Math.random() * 0.4,
      rot: Math.random() * 6.2831853,
      id,
      health: 1,
      birth: this.worldDay,
      planted: true,
    };
    this.world.edits.plantedPlants.push(rec);
    // Attach it to whichever loaded chunk contains it, so it appears at once.
    for (const entry of this.chunks.values()) {
      const n = entry.node;
      if (x >= n.x && x < n.x + n.size && z >= n.z && z < n.z + n.size && entry.visible) {
        return this._addPlant(entry, rec);
      }
    }
    return rec;
  }

  update(dt) {
    this.worldDay = this.world.sky.day + this.world.sky.time;
    this.growUniform.uWorldDay.value = this.worldDay;
    if (dt > 0) this._ripenFruit(dt);
    this.barkPools.forEach((p) => p && p.commit());
    this.leafPools.forEach((p) => p && p.commit());
    this.farPools.forEach((p) => p && p.commit());
    this.rockPool.commit();
    this.grassPool.commit();
    this.fruitPool.commit();
  }
}

// Game-days before a stripped tree carries fruit again. A day is 25 real
// minutes, so this is a little over ten minutes: long enough to be worth
// coming back for, short enough to happen within one sitting.
export const FRUIT_REGROW = 0.45;

const UP = new THREE.Vector3(0, 1, 0);
const EUL = new THREE.Euler();

const FLOWER_TINTS = [
  [2.2, 1.4, 1.9],
  [2.4, 2.0, 0.9],
  [1.4, 1.5, 2.6],
  [2.6, 1.6, 1.1],
];

const FRUIT_TINTS = {
  apple: [1.9, 0.35, 0.28],
  berries: [0.55, 0.35, 1.5],
  coconut: [0.65, 0.52, 0.34],
  mango: [2.1, 1.05, 0.22],
  pinecone: [0.6, 0.42, 0.28],
  'prickly pear': [1.7, 0.42, 0.85],
};

// Everything that grows.
//
// Trees are built procedurally at boot - one geometry per species - and drawn
// from packed instance pools, so a forest of ten thousand trees is a couple of
// dozen draw calls. Growth happens in the vertex shader: each instance carries
// the world-day it sprouted, so trees get visibly taller while you watch, and
// a seed you push into the soil becomes a sapling and then a tree.
//
// The flat-shaded restyle retired the baked textured trees: the in-code
// builders below already make exactly the chunky faceted canopies the look
// wants, at a fraction of the triangles and with zero texture fetches.

import * as THREE from 'three';
import { makeFoliageMaterial, makeSolidMaterial } from '../gfx/materials.js';
import { Rng, hash3f, clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { BIOME, BIOME_INFO, SPECIES, SPECIES_INFO } from './worldgen.js';

// The species table itself lives in biomes.js, next to the per-biome mixes
// that decide what grows where, so the oracle and the geometry can never
// disagree. Re-exported here because everything else already imports it from
// flora.
export { SPECIES, SPECIES_INFO };

const GROW_VERT_PARS = /* glsl */ `
attribute float aBirth;
attribute float aRate;
attribute vec3 aTint;
attribute float aSpawn;
attribute vec2 aLod;
uniform float uWorldDay;
uniform float uFarReach;
varying vec3 vTint;
`;

const GROW_VERT_BODY = /* glsl */ `
{
  float age = max( 0.0, uWorldDay - aBirth );
  float m = clamp( pow( age * aRate, 0.55 ), 0.035, 1.0 );
  // Streamed-in instances scale up from the ground over half a second or so
  // instead of popping. aSpawn is the world-day the slot appeared on screen
  // (or -1e9 for anything that must arrive full-size).
  float fs = clamp( ( uWorldDay - aSpawn ) * 2400.0, 0.0, 1.0 );

  // Detail is a continuous function of THIS instance's distance to the eye,
  // never of the chunk it happens to sit in. That is the whole point: a chunk
  // is a unit of streaming, and when it was also the unit of detail, crossing
  // a threshold rebuilt a 128 m square of trees in full view of the player.
  //
  // aLod.x is the distance a far silhouette has faded in by (-1 for near
  // geometry, which is simply present); aLod.y is the distance it is gone by.
  // Both edges are pure functions of world and camera position, so standing
  // still shows nothing at all no matter what the streamer does behind it -
  // and every allocation and release the CPU makes happens out where this
  // factor is already zero. The default (-1, 1e9) means "always full size",
  // which is what rocks, grass and fruit want without opting in.
  vec3 iOrigin = vec3( 0.0 );
  #ifdef USE_INSTANCING
    iOrigin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
  #endif
  iOrigin += vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
  float dCam = distance( iOrigin, cameraPosition );
  float isFar = step( 0.0, aLod.x );
  float dOut = aLod.y * mix( 1.0, uFarReach, isFar );
  float kIn = mix( 1.0, smoothstep( aLod.x * 0.76, aLod.x * 0.86, dCam ), isFar );
  float kOut = 1.0 - smoothstep( dOut * 0.86, dOut, dCam );

  transformed *= m * ( fs * ( 2.0 - fs ) ) * kIn * kOut;
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

// Palette authored in sRGB pastels and converted to linear once - soft warm
// barks and spring greens to sit against the sandy ochres of the ground.
const P = (r, g, b) => {
  const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const BARK = {
  oak: P(0.45, 0.35, 0.27),
  pine: P(0.40, 0.31, 0.24),
  birch: P(0.90, 0.88, 0.83),
  palm: P(0.56, 0.45, 0.32),
  acacia: P(0.50, 0.39, 0.29),
  cactus: P(0.40, 0.62, 0.36),
  dead: P(0.63, 0.56, 0.49),
  jungle: P(0.47, 0.39, 0.31),
  baobab: P(0.66, 0.58, 0.48),
  euc: P(0.82, 0.76, 0.68),
  banana: P(0.52, 0.60, 0.36),
  bamboo: P(0.72, 0.76, 0.42),
  mangrove: P(0.38, 0.32, 0.27),
  cypress: P(0.52, 0.38, 0.30),
  joshua: P(0.46, 0.38, 0.30),
  olive: P(0.52, 0.48, 0.40),
  aspen: P(0.83, 0.83, 0.76),
  fern: P(0.44, 0.36, 0.28),
  straw: P(0.80, 0.70, 0.36),
};
const LEAF = {
  oak: P(0.50, 0.70, 0.40),
  pine: P(0.33, 0.52, 0.38),
  birch: P(0.64, 0.78, 0.42),
  palm: P(0.44, 0.69, 0.40),
  acacia: P(0.60, 0.70, 0.37),
  cactus: P(0.44, 0.68, 0.40),
  willow: P(0.54, 0.71, 0.44),
  jungle: P(0.32, 0.58, 0.32),
  spruce: P(0.27, 0.45, 0.34),
  bush: P(0.46, 0.67, 0.38),
  fern: P(0.44, 0.69, 0.36),
  // The new country needs colours the temperate palette never had: the
  // grey-green of a hot dry hillside, the near-black of a mangrove, the gold
  // of a larch in autumn and the bleached straw of a steppe.
  baobab: P(0.56, 0.66, 0.36),
  euc: P(0.55, 0.68, 0.50),
  banana: P(0.46, 0.70, 0.32),
  bamboo: P(0.56, 0.76, 0.40),
  mangrove: P(0.26, 0.46, 0.30),
  cypress: P(0.40, 0.56, 0.38),
  joshua: P(0.48, 0.62, 0.42),
  agave: P(0.52, 0.68, 0.50),
  olive: P(0.62, 0.68, 0.52),
  sage: P(0.62, 0.66, 0.50),
  tussock: P(0.74, 0.72, 0.44),
  dwarf: P(0.52, 0.64, 0.40),
  treefern: P(0.38, 0.64, 0.36),
  larch: P(0.66, 0.74, 0.36),
  reed: P(0.58, 0.68, 0.38),
  kelp: P(0.30, 0.42, 0.26),
  moss: P(0.44, 0.62, 0.34),
  wheat: P(0.86, 0.76, 0.38),
  aspen: P(0.68, 0.80, 0.44),
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
    case SPECIES.BAOBAB: {
      // The silhouette everyone knows: an absurd bottle of a trunk with a
      // handful of bare-looking branches on top.
      const seg = 5;
      let py = 0;
      for (let i = 0; i < seg; i++) {
        const t0 = i / seg, t1 = (i + 1) / seg;
        const r0 = H * (0.20 - t0 * 0.135) * (1 + Math.sin(t0 * 3.1) * 0.06);
        const r1 = H * (0.20 - t1 * 0.135);
        bark.tube(0, H * 0.62 * t0, 0, 0, H * 0.62 * t1, 0, r0, r1, 8, BARK.baobab);
        py = H * 0.62 * t1;
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.283 + rng() * 0.6;
        const ex = Math.cos(a) * H * 0.34, ez = Math.sin(a) * H * 0.34;
        bark.tube(0, py, 0, ex, py + H * 0.24, ez, H * 0.035, H * 0.014, 5, BARK.baobab);
        leaf.blob(ex, py + H * 0.28, ez, H * 0.20, H * 0.09, H * 0.20, 2, 6, LEAF.baobab, 0.3, rng);
      }
      break;
    }
    case SPECIES.EUCALYPT: {
      // Tall, pale, and open enough to see the sky through - the opposite of
      // an oak, which is why it reads as somewhere else entirely.
      bark.tube(0, 0, 0, H * 0.04, H * 0.66, 0, H * 0.030, H * 0.014, 6, BARK.euc);
      branch(bark, leaf, rng, {
        barkCol: BARK.euc, leafCol: LEAF.euc, taper: 0.78, spread: 0.55, upBias: 0.52,
        shrink: 0.70, minLen: H * 0.09, leafScale: 0.62, trifurcate: 0.3,
      }, H * 0.04, H * 0.66, 0, 0.05, 1, 0, H * 0.24, H * 0.016, 2);
      break;
    }
    case SPECIES.BANANA: {
      bark.tube(0, 0, 0, 0, H * 0.42, 0, H * 0.075, H * 0.05, 6, BARK.banana);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283 + rng() * 0.5;
        leaf.blade(0, H * (0.40 + rng() * 0.12), 0, Math.cos(a), Math.sin(a),
          H * 0.62, H * 0.16, 1.5, 5, LEAF.banana,
          [LEAF.banana[0] * 1.35, LEAF.banana[1] * 1.2, LEAF.banana[2] * 1.1]);
      }
      break;
    }
    case SPECIES.BAMBOO: {
      // A clump of culms, not one stem: bamboo grows in thickets and the
      // thicket is the thing you actually see.
      const culms = 5 + Math.floor(rng() * 4);
      for (let k = 0; k < culms; k++) {
        const a = rng() * 6.283;
        const rr = rng() * 0.34;
        const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
        const hh = H * (0.55 + rng() * 0.45);
        const lean = (rng() - 0.5) * 0.13;
        const nodes = 5;
        for (let i = 0; i < nodes; i++) {
          const t0 = i / nodes, t1 = (i + 1) / nodes;
          bark.tube(bx + lean * hh * t0 * t0, hh * t0, bz, bx + lean * hh * t1 * t1, hh * t1, bz,
            H * 0.011 * (1 - t0 * 0.35), H * 0.011 * (1 - t1 * 0.35), 4, BARK.bamboo);
          if (i >= 2) {
            const la = a + i * 1.9;
            leaf.blade(bx + lean * hh * t1 * t1, hh * t1, bz, Math.cos(la), Math.sin(la),
              H * 0.13, H * 0.012, 0.7, 3, LEAF.bamboo);
          }
        }
      }
      break;
    }
    case SPECIES.MANGROVE: {
      // Stilt roots first, canopy second: a mangrove stands clear of its own
      // water, which is the only reason it can live there.
      const legs = 6;
      for (let i = 0; i < legs; i++) {
        const a = (i / legs) * 6.283 + rng() * 0.4;
        bark.tube(Math.cos(a) * H * 0.30, -H * 0.06, Math.sin(a) * H * 0.30,
          Math.cos(a) * H * 0.05, H * 0.30, Math.sin(a) * H * 0.05,
          H * 0.020, H * 0.026, 4, BARK.mangrove);
      }
      branch(bark, leaf, rng, {
        barkCol: BARK.mangrove, leafCol: LEAF.mangrove, taper: 0.74, spread: 0.78, upBias: 0.26,
        shrink: 0.66, minLen: H * 0.14, leafScale: 1.0, trifurcate: 0.5,
      }, 0, H * 0.30, 0, 0, 1, 0, H * 0.28, H * 0.045, 2);
      break;
    }
    case SPECIES.CYPRESS: {
      bark.tube(0, 0, 0, 0, H * 0.9, 0, H * 0.055, H * 0.008, 7, BARK.cypress);
      // Buttressed base and the knees that ring a bald cypress in swamp water.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.283 + rng() * 0.5;
        bark.tube(Math.cos(a) * H * 0.075, 0, Math.sin(a) * H * 0.075, 0, H * 0.13, 0,
          H * 0.018, H * 0.010, 4, BARK.cypress);
        const kr = H * (0.14 + rng() * 0.16);
        bark.tube(Math.cos(a) * kr, -0.1, Math.sin(a) * kr, Math.cos(a) * kr, H * 0.045, Math.sin(a) * kr,
          H * 0.014, H * 0.006, 4, BARK.cypress);
      }
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const y = H * (0.34 + t * 0.60);
        const r = H * (0.26 - t * 0.20);
        leaf.blob(0, y, 0, r, H * 0.09, r, 2, 6, LEAF.cypress, 0.3, rng);
      }
      break;
    }
    case SPECIES.JOSHUA: {
      bark.tube(0, 0, 0, 0, H * 0.42, 0, H * 0.075, H * 0.055, 6, BARK.joshua);
      const arms = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < arms; i++) {
        const a = (i / arms) * 6.283 + rng() * 0.7;
        const ex = Math.cos(a) * H * 0.24, ez = Math.sin(a) * H * 0.24;
        const ey = H * (0.58 + rng() * 0.22);
        bark.tube(0, H * 0.42, 0, ex, ey, ez, H * 0.045, H * 0.032, 5, BARK.joshua);
        for (let k = 0; k < 6; k++) {
          const b = (k / 6) * 6.283;
          leaf.blade(ex, ey, ez, Math.cos(b), Math.sin(b), H * 0.15, H * 0.020, -0.4, 2, LEAF.joshua);
        }
      }
      break;
    }
    case SPECIES.AGAVE: {
      const n = 9 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + rng() * 0.3;
        leaf.blade(0, 0.05, 0, Math.cos(a), Math.sin(a), H * 0.95, H * 0.13, -0.55, 3,
          LEAF.agave, [LEAF.agave[0] * 0.7, LEAF.agave[1] * 0.8, LEAF.agave[2] * 0.7]);
      }
      break;
    }
    case SPECIES.OLIVE: {
      branch(bark, leaf, rng, {
        barkCol: BARK.olive, leafCol: LEAF.olive, taper: 0.70, spread: 0.85, upBias: 0.30,
        shrink: 0.64, minLen: H * 0.16, leafScale: 0.95, trifurcate: 0.55,
      }, 0, 0, 0, 0.09, 1, -0.05, H * 0.34, H * 0.075, 2);
      break;
    }
    case SPECIES.SAGE: {
      const n = 5 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const r = rng() * 0.22;
        leaf.blob(Math.cos(a) * r, H * (0.45 + rng() * 0.4), Math.sin(a) * r,
          H * 0.34, H * 0.30, H * 0.34, 2, 5, LEAF.sage, 0.36, rng);
      }
      break;
    }
    case SPECIES.TUSSOCK:
    case SPECIES.REED:
    case SPECIES.WHEAT: {
      const isReed = sp === SPECIES.REED;
      const isWheat = sp === SPECIES.WHEAT;
      const col = isReed ? LEAF.reed : isWheat ? LEAF.wheat : LEAF.tussock;
      const n = isWheat ? 9 : 12 + Math.floor(rng() * 6);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + rng() * 0.6;
        const r = rng() * H * (isWheat ? 0.12 : 0.20);
        const lean = isReed || isWheat ? 0.10 : 0.55;
        leaf.blade(Math.cos(a) * r, 0.02, Math.sin(a) * r, Math.cos(a), Math.sin(a),
          H * (0.75 + rng() * 0.35), H * (isWheat ? 0.030 : 0.045), lean, 3,
          col, [col[0] * 1.3, col[1] * 1.25, col[2] * 1.1]);
      }
      if (isWheat) {
        // An ear on the top of each stalk, so a field reads as a crop.
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * 6.283;
          leaf.blob(Math.cos(a) * H * 0.06, H * 0.92, Math.sin(a) * H * 0.06,
            H * 0.045, H * 0.13, H * 0.045, 2, 4, BARK.straw, 0.18, rng);
        }
      }
      break;
    }
    case SPECIES.DWARF_BIRCH: {
      const n = 4 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const r = rng() * H * 0.30;
        bark.tube(0, 0, 0, Math.cos(a) * r, H * (0.45 + rng() * 0.3), Math.sin(a) * r,
          H * 0.035, H * 0.016, 4, BARK.birch);
        leaf.blob(Math.cos(a) * r, H * 0.62, Math.sin(a) * r,
          H * 0.30, H * 0.24, H * 0.30, 2, 5, LEAF.dwarf, 0.34, rng);
      }
      break;
    }
    case SPECIES.TREE_FERN: {
      bark.tube(0, 0, 0, 0, H * 0.62, 0, H * 0.048, H * 0.036, 6, BARK.fern);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 6.283 + rng() * 0.4;
        leaf.blade(0, H * 0.62, 0, Math.cos(a), Math.sin(a), H * 0.52, H * 0.085, 0.9, 5,
          LEAF.treefern, [LEAF.treefern[0] * 1.4, LEAF.treefern[1] * 1.25, LEAF.treefern[2] * 1.1]);
      }
      break;
    }
    case SPECIES.LARCH: {
      bark.tube(0, 0, 0, 0, H, 0, H * 0.032, H * 0.005, 6, BARK.pine);
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        const y = H * (0.14 + t * 0.82);
        const r = H * (0.26 - t * 0.215) * (0.8 + rng() * 0.4);
        // Sparser and airier than a spruce, and gold rather than blue-green.
        leaf.blob(0, y, 0, r, H * 0.075, r, 2, 5, LEAF.larch, 0.34, rng);
      }
      break;
    }
    case SPECIES.KELP: {
      // Long fronds streaming off a holdfast. The foliage wind sway in the
      // shader does the rest: kelp waves because everything green does.
      const strands = 4 + Math.floor(rng() * 3);
      for (let k = 0; k < strands; k++) {
        const a = rng() * 6.283;
        const r = rng() * 0.4;
        const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
        const hh = H * (0.6 + rng() * 0.5);
        bark.tube(bx, 0, bz, bx + Math.cos(a) * 0.5, hh, bz + Math.sin(a) * 0.5,
          H * 0.012, H * 0.008, 4, LEAF.kelp);
        for (let i = 1; i < 5; i++) {
          const t = i / 5;
          const b = a + i * 2.4;
          leaf.blade(bx + Math.cos(a) * 0.5 * t, hh * t, bz + Math.sin(a) * 0.5 * t,
            Math.cos(b), Math.sin(b), H * 0.22, H * 0.035, 0.35, 3, LEAF.kelp);
        }
      }
      break;
    }
    case SPECIES.MOSS: {
      const n = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const r = rng() * 0.35;
        leaf.blob(Math.cos(a) * r, H * 0.30, Math.sin(a) * r,
          H * 0.72, H * 0.34, H * 0.72, 2, 6, LEAF.moss, 0.42, rng);
      }
      break;
    }
    case SPECIES.ASPEN: {
      branch(bark, leaf, rng, {
        barkCol: BARK.aspen, leafCol: LEAF.aspen, taper: 0.86, spread: 0.26, upBias: 0.76,
        shrink: 0.72, minLen: H * 0.10, leafScale: 0.80, trifurcate: 0.3,
      }, 0, 0, 0, 0, 1, 0, H * 0.46, H * 0.024, 2);
      break;
    }
    case SPECIES.DEAD_PALM: {
      const lean = (rng() - 0.5) * 0.5;
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i < 6; i++) {
        const t = i / 6, t2 = (i + 1) / 6;
        const nx = lean * H * t2 * t2, ny = H * t2, nz = 0;
        bark.tube(px, py, pz, nx, ny, nz, H * 0.032 * (1 - t * 0.4), H * 0.032 * (1 - t2 * 0.4), 5, BARK.dead);
        px = nx; py = ny; pz = nz;
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * 6.283 + rng();
        leaf.blade(px, py, pz, Math.cos(a), Math.sin(a), H * 0.34, H * 0.055, 2.4, 4, BARK.dead);
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


// Far silhouettes, one line of data each. Everything past the near ring is a
// shape against the sky and nothing more, so the only questions worth asking
// are "what colour" and "what outline".
const FAR = {
  [SPECIES.OAK]: ['round', BARK.oak, LEAF.oak],
  [SPECIES.PINE]: ['conifer', BARK.pine, LEAF.pine],
  [SPECIES.BIRCH]: ['round', BARK.birch, LEAF.birch],
  [SPECIES.PALM]: ['palm', BARK.palm, LEAF.palm],
  [SPECIES.ACACIA]: ['flat', BARK.acacia, LEAF.acacia],
  [SPECIES.CACTUS]: ['column', BARK.cactus, BARK.cactus],
  [SPECIES.WILLOW]: ['round', BARK.oak, LEAF.willow],
  [SPECIES.SNAG]: ['bare', BARK.dead, BARK.dead],
  [SPECIES.JUNGLE]: ['round', BARK.jungle, LEAF.jungle],
  [SPECIES.SPRUCE]: ['conifer', BARK.pine, LEAF.spruce],
  [SPECIES.BUSH]: ['tuft', BARK.oak, LEAF.bush],
  [SPECIES.FERN]: ['tuft', BARK.fern, LEAF.fern],
  [SPECIES.SAPLING]: ['tuft', BARK.oak, LEAF.oak],
  [SPECIES.BAOBAB]: ['fat', BARK.baobab, LEAF.baobab],
  [SPECIES.EUCALYPT]: ['round', BARK.euc, LEAF.euc],
  [SPECIES.BANANA]: ['palm', BARK.banana, LEAF.banana],
  [SPECIES.BAMBOO]: ['column', BARK.bamboo, LEAF.bamboo],
  [SPECIES.MANGROVE]: ['round', BARK.mangrove, LEAF.mangrove],
  [SPECIES.CYPRESS]: ['conifer', BARK.cypress, LEAF.cypress],
  [SPECIES.JOSHUA]: ['flat', BARK.joshua, LEAF.joshua],
  [SPECIES.AGAVE]: ['tuft', BARK.joshua, LEAF.agave],
  [SPECIES.OLIVE]: ['round', BARK.olive, LEAF.olive],
  [SPECIES.SAGE]: ['tuft', BARK.olive, LEAF.sage],
  [SPECIES.TUSSOCK]: ['tuft', BARK.straw, LEAF.tussock],
  [SPECIES.DWARF_BIRCH]: ['tuft', BARK.birch, LEAF.dwarf],
  [SPECIES.TREE_FERN]: ['palm', BARK.fern, LEAF.treefern],
  [SPECIES.LARCH]: ['conifer', BARK.pine, LEAF.larch],
  [SPECIES.REED]: ['tuft', BARK.straw, LEAF.reed],
  [SPECIES.KELP]: ['tuft', LEAF.kelp, LEAF.kelp],
  [SPECIES.MOSS]: ['tuft', LEAF.moss, LEAF.moss],
  [SPECIES.WHEAT]: ['tuft', BARK.straw, LEAF.wheat],
  [SPECIES.ASPEN]: ['round', BARK.aspen, LEAF.aspen],
  [SPECIES.DEAD_PALM]: ['bare', BARK.dead, BARK.dead],
};

/**
 * A deliberately crude silhouette, about thirty triangles, used for everything
 * past the nearest ring of chunks. At that distance a tree is a shape against
 * the sky and thirty triangles is a perfectly good shape.
 *
 * There is one of these per *form*, not per species: built at unit height with
 * white foliage, then scaled and tinted per instance. Thirty-three species
 * would otherwise have meant thirty-three more instanced meshes in the render
 * list every time the far ring crossed a biome boundary; eight forms cover the
 * same ground for a fifth of the draw calls.
 */
const FAR_FORMS = ['round', 'conifer', 'palm', 'column', 'flat', 'tuft', 'bare', 'fat'];

// Sized per form, not one number for all eight. Three of them carry most of
// the world - 'round' is every broadleaf, 'conifer' every needle tree, 'tuft'
// every bush, fern and sward plant - and a flat 7000 each ran those three dry
// from the air while the other five sat nearly empty. That starvation is why
// whole hillsides of pale broadleaf trees used to appear only once you were
// almost on top of them.
// Plant record stride in the worker's scatter buffer. Mirrors PLANT_STRIDE in
// terrainWorker.js, which cannot be imported here - that module installs a
// self.onmessage handler at load and must never run on the main thread.
const PLANT_STRIDE = 10;

/**
 * Cull distance by rank, matched to what each LOD tier actually carries.
 *
 * A point at distance D is certainly inside a *split* node of size S when
 * D + 0.707 S < 2.1 S, i.e. D < 1.393 S. Scatter is generated for lod <= 3, so
 * a point within 1.393 * 1024 = 1426 m is guaranteed to sit in a lod<=2 leaf,
 * and one within 1.393 * 2048 = 2853 m in a lod<=3 leaf. lod 2 keeps the
 * lowest-ranked 30% and lod 3 the lowest 9%, so the ranks each tier drops are
 * culled *inside* the radius where that tier is guaranteed to exist:
 *
 *   rank > 0.30   gone by  690 m   (lod<=1 reaches 713 m)
 *   rank > 0.09   gone by 1400 m   (lod<=2 reaches 1426 m)
 *   the rest      gone by 2800 m   (lod<=3 reaches 2853 m)
 *
 * That is what makes a split or a merge free: it can only ever add or remove
 * instances the shader has already scaled to nothing.
 */
function cullFor(q) {
  return q > 0.30 ? 690 : q > 0.09 ? 1400 : 2800;
}

const FAR_CAP = {
  round: 24000, conifer: 24000, tuft: 24000,
  palm: 8000, column: 8000, flat: 8000, bare: 8000, fat: 8000,
};

// Relative to the tinted foliage colour. A far trunk is two pixels of darker
// something underneath a canopy, and that is all it ever needs to be.
const FAR_TRUNK = [0.55, 0.48, 0.40];
const FAR_LEAF = [1, 1, 1];

function buildFarForm(form, seed) {
  const rng = new Rng(seed + form.length * 313 + form.charCodeAt(0) * 7).next;
  const b = new MeshBuilder();
  const H = 1;

  if (form === 'tuft') {
    b.blob(0, H * 0.5, 0, H * 0.44, H * 0.42, H * 0.44, 2, 4, FAR_LEAF, 0.3, rng);
    return b.toGeometry();
  }
  if (form === 'bare') {
    b.tube(0, 0, 0, 0, H * 0.9, 0, H * 0.035, H * 0.016, 4, FAR_TRUNK);
    b.tube(0, H * 0.5, 0, H * 0.26, H * 0.8, 0, H * 0.018, H * 0.006, 3, FAR_TRUNK);
    b.tube(0, H * 0.55, 0, -H * 0.22, H * 0.85, H * 0.1, H * 0.018, H * 0.006, 3, FAR_TRUNK);
    return b.toGeometry();
  }
  if (form === 'fat') {
    b.tube(0, 0, 0, 0, H * 0.6, 0, H * 0.19, H * 0.07, 6, FAR_TRUNK);
    b.blob(0, H * 0.78, 0, H * 0.42, H * 0.14, H * 0.42, 2, 5, FAR_LEAF, 0.24, rng);
    return b.toGeometry();
  }
  b.tube(0, 0, 0, 0, H * (form === 'conifer' || form === 'column' ? 0.95 : 0.6), 0,
    H * 0.035, H * 0.016, 4, FAR_TRUNK);
  if (form === 'conifer') {
    // Two stacked cones rather than one ellipsoid: a single blob read as a
    // floating diamond right at the distance where the near geometry - seven
    // tiered skirts - hands over to it.
    b.blob(0, H * 0.42, 0, H * 0.26, H * 0.30, H * 0.26, 2, 4, FAR_LEAF, 0.16, rng);
    b.blob(0, H * 0.74, 0, H * 0.16, H * 0.26, H * 0.16, 2, 4, FAR_LEAF, 0.16, rng);
  } else if (form === 'palm') {
    b.blob(0, H * 0.66, 0, H * 0.34, H * 0.10, H * 0.34, 2, 4, FAR_LEAF, 0.30, rng);
  } else if (form === 'column') {
    b.blob(0, H * 0.55, 0, H * 0.14, H * 0.42, H * 0.14, 2, 4, FAR_LEAF, 0.10, rng);
  } else if (form === 'flat') {
    b.blob(0, H * 0.80, 0, H * 0.40, H * 0.09, H * 0.40, 2, 5, FAR_LEAF, 0.22, rng);
  } else {
    b.blob(0, H * 0.72, 0, H * 0.36, H * 0.30, H * 0.36, 2, 4, FAR_LEAF, 0.26, rng);
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
      // Filled with "long ago" so a slot nobody stamps arrives full-size.
      this.spawn = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e9), 1);
      // Fade-in and cull distances. (-1, 1e9) means "near geometry, never
      // culled by reach", which is what rocks, grass and fruit want - and it
      // also keeps the shader's smoothstep off equal edges, which is
      // undefined in GLSL. Every mesh drawn with a growth-patched material
      // must be a Pool, because the shader now requires this attribute.
      const lod = new Float32Array(capacity * 2);
      for (let i = 0; i < capacity; i++) {
        lod[i * 2] = -1;
        lod[i * 2 + 1] = 1e9;
      }
      this.lod = new THREE.InstancedBufferAttribute(lod, 2);
      this.birth.setUsage(THREE.DynamicDrawUsage);
      this.rate.setUsage(THREE.DynamicDrawUsage);
      this.tint.setUsage(THREE.DynamicDrawUsage);
      this.spawn.setUsage(THREE.DynamicDrawUsage);
      this.lod.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aBirth', this.birth);
      geo.setAttribute('aRate', this.rate);
      geo.setAttribute('aTint', this.tint);
      geo.setAttribute('aSpawn', this.spawn);
      geo.setAttribute('aLod', this.lod);
    }
    this.dirty = false;
    // Touched-slot range since the last commit, kept separately for the
    // matrix and the growth attributes. Uploading only this slice matters:
    // the grass pool's matrices alone are over five megabytes, and walking
    // through a forest used to re-send all of it whenever any slot changed.
    this._mLo = Infinity; this._mHi = -1;
    this._gLo = Infinity; this._gHi = -1;
    scene.add(this.mesh);
  }
  _touchM(i) {
    if (i < this._mLo) this._mLo = i;
    if (i > this._mHi) this._mHi = i;
  }
  _touchG(i) {
    if (i < this._gLo) this._gLo = i;
    if (i > this._gHi) this._gHi = i;
  }
  /** Slots still available. Emphatically not `free`, which removes one. */
  headroom() {
    return this.capacity - this.mesh.count;
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
    this._touchM(to);
    if (this.birth) {
      this.birth.array[to] = this.birth.array[from];
      this.rate.array[to] = this.rate.array[from];
      this.spawn.array[to] = this.spawn.array[from];
      // The cull distances travel with the instance. An instance that
      // inherited a stranger's would blink at a fixed radius, with no error
      // and no bad count - the same silent class of bug as free()/headroom().
      this.lod.array[to * 2] = this.lod.array[from * 2];
      this.lod.array[to * 2 + 1] = this.lod.array[from * 2 + 1];
      for (let k = 0; k < 3; k++) this.tint.array[to * 3 + k] = this.tint.array[from * 3 + k];
      this._touchG(to);
    }
  }
  setMatrix(i, m) {
    m.toArray(this.mesh.instanceMatrix.array, i * 16);
    this._touchM(i);
    this.dirty = true;
  }
  setGrowth(i, birth, rate, tr, tg, tb) {
    if (!this.birth) return;
    this.birth.array[i] = birth;
    this.rate.array[i] = rate;
    this.tint.array[i * 3] = tr;
    this.tint.array[i * 3 + 1] = tg;
    this.tint.array[i * 3 + 2] = tb;
    this._touchG(i);
    this.dirty = true;
  }
  /** World-day this slot streamed onto the screen; -1e9 = arrive full-size. */
  setSpawn(i, day) {
    if (!this.spawn) return;
    this.spawn.array[i] = day;
    this._touchG(i);
    this.dirty = true;
  }
  /** Fade-in distance (-1 for near geometry) and cull distance, in metres. */
  setLod(i, dIn, dOut) {
    if (!this.lod) return;
    this.lod.array[i * 2] = dIn;
    this.lod.array[i * 2 + 1] = dOut;
    this._touchG(i);
    this.dirty = true;
  }
  commit() {
    // A world with thirty-three species keeps most of its pools empty most of
    // the time. Hiding them outright keeps them out of the render list and out
    // of the shadow pass instead of relying on a zero-instance early-out.
    this.mesh.visible = this.mesh.count > 0;
    if (!this.dirty) return;
    // One update range spanning the touched slots. A single ripened fruit
    // used to cost the whole buffer; now it costs sixty-four bytes.
    if (this._mHi >= this._mLo) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(this._mLo * 16, (this._mHi - this._mLo + 1) * 16);
      im.needsUpdate = true;
    }
    if (this.birth && this._gHi >= this._gLo) {
      const n = this._gHi - this._gLo + 1;
      this.birth.clearUpdateRanges();
      this.birth.addUpdateRange(this._gLo, n);
      this.birth.needsUpdate = true;
      this.rate.clearUpdateRanges();
      this.rate.addUpdateRange(this._gLo, n);
      this.rate.needsUpdate = true;
      this.spawn.clearUpdateRanges();
      this.spawn.addUpdateRange(this._gLo, n);
      this.spawn.needsUpdate = true;
      this.lod.clearUpdateRanges();
      this.lod.addUpdateRange(this._gLo * 2, n * 2);
      this.lod.needsUpdate = true;
      this.tint.clearUpdateRanges();
      this.tint.addUpdateRange(this._gLo * 3, n * 3);
      this.tint.needsUpdate = true;
    }
    this._mLo = Infinity; this._mHi = -1;
    this._gLo = Infinity; this._gHi = -1;
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
    // uFarReach eases the silhouette cull radius under pool pressure; the CPU
    // sweeps and the shader read the same number so they can never disagree.
    this.growUniform = { uWorldDay: { value: 0 }, uFarReach: { value: 1 } };
    this.farReach = 1;
    this.farReachTarget = 1;

    this.barkMat = makeFoliageMaterial({
      key: 'bark', stiffness: 0.05, sway: 0.35,
      uniforms: this.growUniform,
    });
    this.leafMat = makeFoliageMaterial({
      key: 'leaf', stiffness: 0.11, sway: 1.0, doubleSide: true, translucency: 0.55,
      uniforms: this.growUniform,
    });
    this._patchGrowth(this.barkMat);
    this._patchGrowth(this.leafMat);

    this.rockMat = makeSolidMaterial({ key: 'rock' });
    this.fruitMat = makeSolidMaterial({ key: 'fruit' });

    this.barkPools = [];
    this.leafPools = [];
    for (let sp = 0; sp < SPECIES_INFO.length; sp++) {
      const cap = SPECIES_INFO[sp].cap;
      const g = buildSpecies(sp, world.seed);
      this.barkPools[sp] = g.bark ? new Pool(g.bark, this.barkMat, cap, this.scene) : null;
      this.leafPools[sp] = g.leaf ? new Pool(g.leaf, this.leafMat, cap, this.scene) : null;
    }

    // One far pool per silhouette form, shared by every species that has that
    // outline; the per-instance tint and scale carry the difference. Sized for
    // the view from the aeroplane, not from the ground: at altitude every
    // tree-bearing chunk is on screen at once, and 7000 slots of 'round' ran
    // out with half the broadleaf forest missing - which is why whole hills
    // of oaks used to appear only when you were nearly on top of them.
    this.farPools = {};
    for (const form of FAR_FORMS) {
      const pool = new Pool(buildFarForm(form, world.seed), this.leafMat, FAR_CAP[form], this.scene);
      pool.mesh.castShadow = false;
      this.farPools[form] = pool;
    }
    // Kept as a flat list purely so the smoke test and the draw-call probe
    // can count what is actually on screen.
    this.farBarkPools = FAR_FORMS.map((f) => this.farPools[f]);

    // Rocks: one blobby geometry, scaled, rotated and tinted per instance. The
    // tint rides the same per-instance attribute the growth shader uses, which
    // is why the rock material is patched too - a boulder in a lava field has
    // to be black and one in badlands red, or the ground and the stones on it
    // stop belonging to the same place.
    const rb = new MeshBuilder();
    const rrng = new Rng(world.seed ^ 0x9a3).next;
    rb.blob(0, 0.25, 0, 0.6, 0.42, 0.55, 2, 5, [1, 1, 1], 0.40, rrng);
    this.rockPool = new Pool(rb.toGeometry(), this.rockMat, 9000, this.scene);
    this._patchGrowth(this.rockMat);
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
    // Solid-colour geometry blades - no texture, no alpha test, so early-Z
    // works and a meadow stops being an overdraw problem. Five single
    // triangles in a loose fan read as a tuft from a metre away.
    const mat = makeFoliageMaterial({
      key: 'grass', stiffness: 0.55, sway: 2.6, doubleSide: true, translucency: 0.9,
      uniforms: this.growUniform,
    });
    // Without the growth patch the per-instance tint never reaches the
    // shader, and every tuft renders in the raw cream base colour.
    this._patchGrowth(mat);
    this.grassMat = mat;
    const g = new THREE.BufferGeometry();
    const pos = [];
    const nrm = [];
    const col = [];
    const idx = [];
    const BLADES = 5;
    for (let k = 0; k < BLADES; k++) {
      const a = (k / BLADES) * Math.PI * 2 + k * 0.7;
      const r = 0.05 + (k % 3) * 0.045;
      const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
      const lean = 0.10 + (k % 2) * 0.08;
      const h = 0.34 + ((k * 37) % 10) * 0.02;
      const w = 0.035;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      const b = pos.length / 3;
      pos.push(
        bx - px, 0, bz - pz,
        bx + px, 0, bz + pz,
        bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean
      );
      // Normals lean well upward: blades shade like the meadow they stand
      // in, instead of metering as dark side-lit fins against bright ground.
      for (let i = 0; i < 3; i++) nrm.push(-Math.sin(a) * 0.5, 0.8, Math.cos(a) * 0.5);
      // Dark base to light tip, so tufts read as dense without a texture.
      col.push(0.55, 0.60, 0.45, 0.55, 0.60, 0.45, 1.15, 1.2, 0.95);
      idx.push(b, b + 1, b + 2);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.grassPool = new Pool(g, mat, 84000, this.scene);
    this.grassPool.mesh.castShadow = false;
    this.grassPool.mesh.receiveShadow = false;
  }

  /* ------------------------------------------------------------- streaming */

  /**
   * Distance from the player to the nearest part of a chunk, in three
   * dimensions. Height counts: from three hundred metres up the ground below
   * you is three hundred metres away, and full-detail trees on it are wasted
   * geometry - worse, ignoring altitude meant the whole near ring stayed
   * full-detail while flying, which is exactly where the budget is tightest.
   */
  _chunkDist(node) {
    const p = this.world.player ? this.world.player.position : { x: 0, y: 0, z: 0 };
    const dx = Math.max(node.x - p.x, 0, p.x - (node.x + node.size));
    const dz = Math.max(node.z - p.z, 0, p.z - (node.z + node.size));
    const dy = Math.max(0, p.y - (node.maxY || 0));
    return Math.hypot(dx, dz, dy);
  }

  onChunkLoaded(node, scatter, fade = true) {
    const entry = {
      node,
      // A coarse chunk is scenery: rank-thinned silhouettes and nothing else.
      // It carries no plant records at all, because `within` and `nearest`
      // walk every record of every chunk on every frame and there are a
      // hundred thousand trees out there.
      coarse: node.lod >= 2,
      fade,
      visible: true,
      plants: [], // {sp, slotBark, slotLeaf, slotFar, slotFruit, x,y,z, scale, rot, id, ...}
      rocks: [],
      grass: [],
      onSlotMoved: null,
    };
    entry.onSlotMoved = (pool, from, to) => this._slotMoved(entry, pool, from, to);
    // Cull bounds over the chunk's plants, so _dressFar can skip a chunk that
    // is wholly inside or wholly outside its own ring without walking it.
    entry.cullMin = Infinity;
    entry.cullMax = 0;
    entry.dressed = false;
    entry.hasNear = false;
    this.chunks.set(node, entry);

    const edits = this.world.edits;
    const P = scatter.plants;
    for (let i = 0; i < P.length; i += PLANT_STRIDE) {
      const id = P[i + 8] >>> 0;
      if (edits.removedPlants.has(id)) continue;
      this._addPlant(entry, {
        sp: P[i + 3] | 0,
        x: P[i], y: P[i + 1], z: P[i + 2],
        scale: P[i + 4], rot: P[i + 5],
        ageSeed: P[i + 6],
        id,
        q: P[i + 9],
        health: edits.plantHealth.has(id) ? edits.plantHealth.get(id) : 1,
      });
    }
    // Anything the player planted inside this chunk.
    for (const p of edits.plantedPlants) {
      if (p.x >= node.x && p.x < node.x + node.size && p.z >= node.z && p.z < node.z + node.size) {
        this._addPlant(entry, p);
      }
    }

    const spawnDay = fade ? this.worldDay : -1e9;
    const R = scatter.rocks;
    entry.rockSrc = R;
    entry.rockAt = [];
    for (let i = 0; i < R.length; i += 8) {
      const slot = this.rockPool.alloc(entry);
      if (slot < 0) break;
      this.rockPool.setMatrix(slot, this._rockMatrix(R, i));
      const rc = rockTint(R[i + 7] | 0);
      const v = 0.86 + hash3f(R[i] | 0, R[i + 2] | 0, 5) * 0.28;
      this.rockPool.setGrowth(slot, -999, 99, rc[0] * v, rc[1] * v, rc[2] * v);
      this.rockPool.setSpawn(slot, spawnDay);
      entry.rocks.push(slot);
      entry.rockAt.push(i);
    }

    const G = scatter.grass;
    for (let i = 0; i < G.length; i += 7) {
      const slot = this.grassPool.alloc(entry);
      if (slot < 0) break;
      const s = G[i + 3];
      QUAT.setFromAxisAngle(UP, G[i + 4]);
      M4.compose(VEC.set(G[i], G[i + 1], G[i + 2]), QUAT, SCL.set(s, s * (0.8 + s * 0.5), s));
      this.grassPool.setMatrix(slot, M4);
      const type = G[i + 5] | 0;
      // The tint multiplies the blade's base-to-tip vertex gradient. Grass is
      // not one colour anywhere on Earth: a savanna is straw, a moor is rust,
      // a meadow is spring green, and the difference is most of what tells you
      // where you are from a hundred metres away.
      const t = type === 0
        ? grassTint(G[i + 6] | 0, hash3f(i, node.x | 0, 3))
        : FLOWER_TINTS[(type - 1) % FLOWER_TINTS.length];
      this.grassPool.setGrowth(slot, -999, 99, t[0], t[1], t[2]);
      this.grassPool.setSpawn(slot, spawnDay);
      entry.grass.push(slot);
    }
  }

  /** The near pools: full species geometry. Nothing branches on a tier now. */
  _poolsFor(rec) {
    return [this.barkPools[rec.sp], this.leafPools[rec.sp]];
  }

  _farPoolFor(sp) {
    return this.farPools[FAR[sp][0]];
  }

  /**
   * The instance scale for a plant. Near geometry is built at the species'
   * real height, so it is just the per-plant scale; the shared far silhouettes
   * are unit height and carry the species height here instead.
   */
  _scaleOf(rec, far) {
    return far ? rec.scale * SPECIES_INFO[rec.sp].height : rec.scale;
  }

  _matrixOf(rec, far) {
    const isc = this._scaleOf(rec, far);
    QUAT.setFromAxisAngle(UP, rec.rot);
    return M4.compose(VEC.set(rec.x, rec.y, rec.z), QUAT, SCL.set(isc, isc, isc));
  }

  /**
   * Record only. No instance is allocated here: _dressFar and _dressNear own
   * every slot, and they only ever act at a distance where the shader has
   * already scaled that detail level to nothing. That is what makes a chunk
   * arriving, changing LOD or leaving invisible to the player.
   */
  _addPlant(entry, p) {
    const info = SPECIES_INFO[p.sp];
    const rec = {
      sp: p.sp, x: p.x, y: p.y, z: p.z, scale: p.scale, rot: p.rot,
      id: p.id, health: p.health !== undefined ? p.health : 1,
      birth: p.birth !== undefined ? p.birth : -(p.ageSeed || 0.5) * info.mature * 3.4,
      rate: 1 / info.mature,
      slotBark: -1, slotLeaf: -1, slotFar: -1, slotFruit: -1,
      // Never picked reads as "picked infinitely long ago", not "picked at
      // time zero" - otherwise nothing in the world bears fruit until day 1.2.
      fruitTaken: p.fruitTaken !== undefined
        ? p.fruitTaken
        : (p.id !== undefined && this.world.edits.fruitTaken.has(p.id)
            ? this.world.edits.fruitTaken.get(p.id)
            : -1e9),
    };
    const h = info.height * rec.scale;
    // Where this individual hands over from full geometry to a silhouette.
    // Floored at 175 m because the sun's shadow box is 220 m square, reaching
    // 156 m into its corners, and the shadow pass runs an unpatched depth
    // material that never sees the growth shader - hand over any closer and
    // the tree retracts while its shadow stays on the ground.
    rec.hand = clamp(15 * h, 175, 320);
    // ...and where the silhouette itself goes. Priced on rank so that the
    // trees a coarse chunk drops are exactly the ones already gone by the time
    // that chunk is reached, and on height so a fern is not still drawn at a
    // kilometre. The jitter stops a whole species vanishing on one radius.
    rec.cull = Math.min(cullFor(p.q === undefined ? 0 : p.q), 210 * h)
      * (0.86 + 0.14 * hash3f(rec.id & 1023, 17, 5));
    if (rec.cull < entry.cullMin) entry.cullMin = rec.cull;
    if (rec.cull > entry.cullMax) entry.cullMax = rec.cull;
    entry.plants.push(rec);
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
      if (!entry.visible || entry.coarse) continue;
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
    // Regrowing fruit swells back over the fade too, instead of snapping on.
    this.fruitPool.setSpawn(slot, entry.fade ? this.worldDay : -1e9);
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
      else if (p.slotFar === from && pool === this._farPoolFor(p.sp)) p.slotFar = to;
    }
  }

  /**
   * Release every slot this chunk owns: grouped by pool, highest slot first.
   *
   * `Pool.free` is a swap-remove - it moves the pool's last instance down into
   * the freed slot and tells that instance's owner where it went. Freeing in
   * allocation order meant that whenever the moved instance belonged to *this*
   * chunk, the slot list being iterated was rewritten under the loop to a slot
   * already released, and it was then freed a second time. That drove the
   * pool's count below zero (a flight showed palm at -7 and tuft at -13) and
   * scrambled every instance above it. Descending order cannot move one of our
   * own slots into another of our own, because the higher one is always gone
   * first; clearing the records before freeing makes the callback a no-op too.
   */
  onChunkUnloaded(node) {
    const entry = this.chunks.get(node);
    if (!entry) return;
    const byPool = new Map();
    const add = (pool, slot) => {
      if (!pool || slot < 0) return;
      let a = byPool.get(pool);
      if (!a) byPool.set(pool, (a = []));
      a.push(slot);
    };
    for (const p of entry.plants) {
      const [bp, lp] = this._poolsFor(p);
      add(bp, p.slotBark);
      add(lp, p.slotLeaf);
      add(this._farPoolFor(p.sp), p.slotFar);
      add(this.fruitPool, p.slotFruit);
      p.slotBark = p.slotLeaf = p.slotFar = p.slotFruit = -1;
    }
    for (const s of entry.rocks) add(this.rockPool, s);
    for (const s of entry.grass) add(this.grassPool, s);
    entry.plants.length = 0;
    entry.rocks.length = 0;
    entry.grass.length = 0;
    entry.rockSrc = null;
    entry.rockAt = null;
    for (const [pool, slots] of byPool) {
      slots.sort((a, b) => b - a);
      for (const s of slots) pool.free(s);
    }
    this.chunks.delete(node);
  }

  _freePlant(entry, p) {
    const [bp, lp] = this._poolsFor(p);
    // Highest slot first within a pool, for the swap-remove reason above.
    const fp = this._farPoolFor(p.sp);
    if (p.slotBark >= 0 && bp) bp.free(p.slotBark);
    if (p.slotLeaf >= 0 && lp) lp.free(p.slotLeaf);
    if (p.slotFar >= 0 && fp) fp.free(p.slotFar);
    if (p.slotFruit >= 0) this.fruitPool.free(p.slotFruit);
    p.slotBark = p.slotLeaf = p.slotFar = p.slotFruit = -1;
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
      if (p.slotFar >= 0) this._setSlotVisible(this._farPoolFor(p.sp), p.slotFar, vis, p);
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
      const isc = pool === this.fruitPool ? p.scale : this._scaleOf(p, pool === this._farPoolFor(p.sp));
      QUAT.setFromAxisAngle(UP, p.rot);
      M4.compose(VEC.set(p.x, p.y, p.z), QUAT, SCL.set(isc, isc, isc));
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
      if (!entry.visible || entry.coarse) continue;
      const n = entry.node;
      if (x + range < n.x || x - range > n.x + n.size
        || z + range < n.z || z - range > n.z + n.size) continue;
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
      // Coarse chunks are scenery - they cannot burn, be felled or be picked,
      // and there are tens of thousands of trees on them. Fire calls this
      // every frame per burning plant, so both rejects are load-bearing.
      if (!entry.visible || entry.coarse) continue;
      const n = entry.node;
      if (x + radius < n.x || x - radius > n.x + n.size
        || z + radius < n.z || z - radius > n.z + n.size) continue;
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
    if (p.slotFar >= 0) {
      // The silhouette carries its whole colour on the tint, so a scorched
      // tree has to be re-tinted there as well or it stays green at range.
      const fc = FAR[p.sp][2];
      this._farPoolFor(p.sp).setGrowth(p.slotFar, p.birth, p.rate,
        fc[0] * tint, fc[1] * tint, fc[2] * tint);
    }
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
    // Rank 0: a seed you pushed in yourself is the last thing that should
    // vanish with distance.
    rec.q = 0;
    // Attach it to whichever loaded chunk contains it, so it appears at once.
    for (const entry of this.chunks.values()) {
      const n = entry.node;
      if (x >= n.x && x < n.x + n.size && z >= n.z && z < n.z + n.size && entry.visible) {
        return this._addPlant(entry, rec);
      }
    }
    return rec;
  }

  /**
   * Chunks don't reload as you walk, so promote/demote their detail tier by
   * rebuilding from the scatter the node still holds. Hysteresis (170/220)
   * keeps a chunk from thrashing at the boundary.
   */
  /**
   * Whether the pools could actually stock this chunk at the given tier.
   *
   * A retier frees the chunk's slots and immediately asks for new ones, so if
   * the destination pool is full the trees simply vanish and only come back on
   * a later retry - which is what "trees disappear and pop in again" was. The
   * chunk's own slots come back to their pools when it is freed, so they count
   * toward what is available.
   */
  /**
   * The distance at which a plant's silhouette is released, priced on the
   * plant's rank so that split and merge are free.
   *
   * A point at distance D is certainly inside a *split* node of size S when
   * D + 0.707 S < 2.1 S, i.e. D < 1.393 S. So everything within 713 m is in a
   * lod<=1 leaf and everything within 1426 m is in a lod<=2 leaf. The trees a
   * coarse chunk drops are exactly the ranks above KEEP (0.30), and those are
   * culled by 690 m - inside the 713 m guarantee. The ones it keeps are gone
   * by 1400 m, inside 1426. So a chunk changing LOD only ever adds or removes
   * instances the shader has already scaled to zero.
   */
  _dressFar(dt) {
    this._farT = (this._farT || 0) - dt;
    if (this._farT > 0) return;
    this._farT = 0.15;
    const p = this.world.player.position;
    let allocs = 900;
    let frees = 1200;
    const reach = this.farReach;
    for (const entry of this.chunks.values()) {
      if (!entry.visible || !entry.plants.length) continue;
      const n = entry.node;
      // Whole-chunk reject first: a chunk entirely inside its plants' cull
      // radii has nothing to do, and one entirely outside has nothing left.
      const dx = Math.max(n.x - p.x, 0, p.x - (n.x + n.size));
      const dz = Math.max(n.z - p.z, 0, p.z - (n.z + n.size));
      const dy = Math.max(0, p.y - (n.maxY || 0));
      const dNear = Math.hypot(dx, dz, dy);
      if (entry.dressed && dNear > entry.cullMax * reach * 1.14) continue;
      const far = Math.hypot(
        Math.max(Math.abs(p.x - n.x), Math.abs(p.x - (n.x + n.size))),
        Math.max(Math.abs(p.z - n.z), Math.abs(p.z - (n.z + n.size))),
        dy
      );
      if (entry.dressed && far < entry.cullMin * reach) continue;
      let dressed = true;
      for (const rec of entry.plants) {
        const d = Math.hypot(rec.x - p.x, rec.y - p.y, rec.z - p.z);
        const cull = rec.cull * reach;
        if (rec.slotFar < 0) {
          if (d < cull * 1.02 && allocs > 0) {
            const pool = this._farPoolFor(rec.sp);
            const slot = pool.alloc(entry);
            if (slot < 0) { dressed = false; continue; }
            allocs--;
            rec.slotFar = slot;
            pool.setMatrix(slot, this._matrixOf(rec, true));
            // Far geometry is white, so the tint is the reflectance itself.
            const fc = FAR[rec.sp][2];
            const t = rec.health >= 0.999 ? 1 : Math.max(0.10, rec.health);
            pool.setGrowth(slot, rec.birth, rec.rate, fc[0] * t, fc[1] * t, fc[2] * t);
            pool.setLod(slot, rec.hand, rec.cull);
            pool.setSpawn(slot, this.worldDay);
          } else if (d < cull * 1.02) {
            dressed = false;
          }
        } else if (d > cull * 1.14 && frees > 0) {
          frees--;
          this._farPoolFor(rec.sp).free(rec.slotFar);
          rec.slotFar = -1;
        }
      }
      entry.dressed = dressed;
    }
  }

  /** Full geometry, allocated per plant as it comes inside its hand-over. */
  _dressNear(dt) {
    this._nearT = (this._nearT || 0) - dt;
    if (this._nearT > 0) return;
    this._nearT = 0.1;
    const p = this.world.player.position;
    const v = this.world.player.velocity;
    // Look ahead of the aeroplane: at 128 m/s a tenth-second tick is 13 m, and
    // a promotion that lands late is a tree that grows in front of you.
    const ex = p.x + (v ? v.x : 0) * 0.45;
    const ey = p.y + (v ? v.y : 0) * 0.45;
    const ez = p.z + (v ? v.z : 0) * 0.45;
    let promotes = 64;
    let demotes = 96;
    for (const entry of this.chunks.values()) {
      if (entry.coarse || !entry.visible || !entry.plants.length) continue;
      const n = entry.node;
      const dx = Math.max(n.x - ex, 0, ex - (n.x + n.size));
      const dz = Math.max(n.z - ez, 0, ez - (n.z + n.size));
      const dy = Math.max(0, ey - (n.maxY || 0));
      if (Math.hypot(dx, dz, dy) > 360) {
        // Far outside the near ring: demote anything still dressed.
        if (!entry.hasNear) continue;
      }
      let hasNear = false;
      for (const rec of entry.plants) {
        const d = Math.hypot(rec.x - ex, rec.y - ey, rec.z - ez);
        if (rec.slotBark < 0) {
          if (d < rec.hand * 1.02 && promotes > 0) {
            promotes--;
            this._promote(entry, rec);
          }
        } else if (d > rec.hand * 1.12 && demotes > 0) {
          demotes--;
          this._demote(entry, rec);
        }
        if (rec.slotBark >= 0) hasNear = true;
      }
      entry.hasNear = hasNear;
    }
  }

  /** Give a plant its full geometry. It arrives where kOut is already zero. */
  _promote(entry, rec) {
    const bp = this.barkPools[rec.sp];
    const lp = this.leafPools[rec.sp];
    const tint = rec.health >= 0.999 ? 1 : Math.max(0.10, rec.health);
    const m = this._matrixOf(rec, false);
    if (bp) {
      const slot = bp.alloc(entry);
      if (slot < 0) return;
      rec.slotBark = slot;
      bp.setMatrix(slot, m);
      bp.setGrowth(slot, rec.birth, rec.rate, tint, tint * 0.92, tint * 0.88);
      bp.setLod(slot, -1, rec.hand);
      bp.setSpawn(slot, -1e9);
    }
    if (lp && rec.health > 0.05) {
      const slot = lp.alloc(entry);
      if (slot >= 0) {
        rec.slotLeaf = slot;
        lp.setMatrix(slot, m);
        const v = 0.82 + hash3f(rec.id & 1023, rec.sp, 7) * 0.36;
        lp.setGrowth(slot, rec.birth, rec.rate, tint * v, tint * (v * 1.02), tint * (v * 0.9));
        lp.setLod(slot, -1, rec.hand);
        lp.setSpawn(slot, -1e9);
      }
    }
    if (this.fruitReady(rec)) this._attachFruit(entry, rec);
  }

  _demote(entry, rec) {
    const [bp, lp] = this._poolsFor(rec);
    if (rec.slotBark >= 0 && bp) bp.free(rec.slotBark);
    if (rec.slotLeaf >= 0 && lp) lp.free(rec.slotLeaf);
    if (rec.slotFruit >= 0) this.fruitPool.free(rec.slotFruit);
    rec.slotBark = rec.slotLeaf = rec.slotFruit = -1;
  }

  /**
   * The pressure valve. Bamboo carries twice the trees per square kilometre of
   * forest and puts them all in one silhouette form, so no fixed capacity
   * covers every biome. Easing the cull radius instead bounds the instance
   * count by area - quadratically - and does it continuously, so the outer
   * edge of the ring creeps in rather than a hillside blinking out. The shader
   * reads the same number, so allocation and release still happen where the
   * rendered scale is zero.
   */
  _pressure(dt) {
    let occ = 0;
    for (const form of FAR_FORMS) {
      const pool = this.farPools[form];
      occ = Math.max(occ, pool.mesh.count / pool.capacity);
    }
    const want = occ > 0.9 ? 0.55 : occ < 0.7 ? 1 : this.farReachTarget;
    this.farReachTarget = want;
    this.farReach += clamp(want - this.farReach, -0.35 * dt, 0.35 * dt);
    this.growUniform.uFarReach.value = this.farReach;
  }

  update(dt) {
    this.worldDay = this.world.sky.day + this.world.sky.time;
    this.growUniform.uWorldDay.value = this.worldDay;
    if (dt > 0) this._ripenFruit(dt);
    if (dt > 0) {
      this._pressure(dt);
      this._dressFar(dt);
      this._dressNear(dt);
    }
    this.barkPools.forEach((p) => p && p.commit());
    this.leafPools.forEach((p) => p && p.commit());
    for (const form of FAR_FORMS) this.farPools[form].commit();
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

/**
 * Ground-cover colour per biome. These multiply the tuft's own base-to-tip
 * gradient, so they read as a tint rather than as a paint: the first number is
 * the red the tips take, and the pair after it the green and blue.
 */
const GRASS_TINTS = {
  [BIOME.MEADOW]: [0.30, 0.56, 0.20],
  [BIOME.PRAIRIE]: [0.46, 0.52, 0.18],
  [BIOME.GRASSLAND]: [0.34, 0.52, 0.20],
  [BIOME.SAVANNA]: [0.62, 0.48, 0.14],
  [BIOME.STEPPE]: [0.58, 0.50, 0.18],
  [BIOME.SHRUBLAND]: [0.50, 0.48, 0.22],
  [BIOME.DRY_FOREST]: [0.48, 0.50, 0.18],
  [BIOME.MOOR]: [0.50, 0.40, 0.20],
  [BIOME.BOG]: [0.40, 0.44, 0.22],
  [BIOME.MARSH]: [0.32, 0.52, 0.22],
  [BIOME.SWAMP]: [0.28, 0.48, 0.20],
  [BIOME.MANGROVE]: [0.24, 0.44, 0.22],
  [BIOME.TUNDRA]: [0.48, 0.44, 0.26],
  [BIOME.TAIGA]: [0.30, 0.46, 0.24],
  [BIOME.SNOW]: [0.62, 0.66, 0.66],
  [BIOME.POLAR_DESERT]: [0.56, 0.56, 0.52],
  [BIOME.GLACIER]: [0.66, 0.72, 0.78],
  [BIOME.DESERT]: [0.66, 0.54, 0.20],
  [BIOME.DUNES]: [0.70, 0.58, 0.22],
  [BIOME.ROCKY_DESERT]: [0.60, 0.50, 0.20],
  [BIOME.SALT_FLAT]: [0.68, 0.64, 0.48],
  [BIOME.BADLANDS]: [0.62, 0.44, 0.18],
  [BIOME.LAVA_FIELD]: [0.32, 0.46, 0.26],
  [BIOME.RAINFOREST]: [0.24, 0.52, 0.20],
  [BIOME.CLOUD_FOREST]: [0.26, 0.50, 0.24],
  [BIOME.BAMBOO]: [0.34, 0.56, 0.20],
  [BIOME.KARST]: [0.36, 0.54, 0.20],
  [BIOME.CROPLAND]: [0.54, 0.52, 0.16],
  [BIOME.OASIS]: [0.34, 0.56, 0.20],
  [BIOME.ALPINE]: [0.38, 0.50, 0.26],
  [BIOME.BEACH]: [0.52, 0.54, 0.24],
  [BIOME.BLACK_SAND]: [0.40, 0.46, 0.28],
};
const DEFAULT_GRASS = [0.32, 0.50, 0.20];

function grassTint(biome, jitter) {
  const t = GRASS_TINTS[biome] || DEFAULT_GRASS;
  // A little scatter in the red channel alone keeps a sward from banding.
  return [t[0] + jitter * 0.12 - 0.06, t[1], t[2]];
}

/** Loose stone takes the colour of the bedrock it broke off. */
function rockTint(biome) {
  const info = BIOME_INFO[biome];
  // BIOME_INFO already holds linear reflectances and the blob geometry is
  // white, so the tint *is* the reflectance.
  return (info && info.rock) || DEFAULT_ROCK;
}
// The lilac-grey the single hand-picked rock colour used to be, in linear.
const DEFAULT_ROCK = [0.318, 0.297, 0.377];

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

// The world oracle.
//
// Every question about the world - "how high is the ground here?", "is this a
// desert?", "is there a river?", "is there a town?" - is answered by a pure
// function of (x, z) and the world seed. Nothing is stored, so the world is
// infinite in every direction and identical for everyone holding the same seed.
//
// This module must stay free of three.js imports: it runs inside Web Workers.

import { Noise, Rng, hash3i, hash3f, clamp, lerp, saturate, smoothstep, spline } from '../core/noise.js';

export const SEA_LEVEL = 0;

/* ------------------------------------------------------------------ biomes */

export const BIOME = {
  DEEP_OCEAN: 0,
  OCEAN: 1,
  REEF: 2,
  BEACH: 3,
  GRASSLAND: 4,
  FOREST: 5,
  RAINFOREST: 6,
  TAIGA: 7,
  TUNDRA: 8,
  SNOW: 9,
  DESERT: 10,
  SAVANNA: 11,
  SWAMP: 12,
  ALPINE: 13,
  SCREE: 14,
  MEADOW: 15,
};

export const BIOME_COUNT = 16;

// Ground colours, authored in sRGB as the pastel the player should actually
// see and converted to linear once below. Warm sandy ochres, spring greens,
// lilac-grey rock, off-white snow - the flat-illustration palette.
export const BIOME_INFO = [
  { name: 'Abyss',      col: [0.20, 0.27, 0.36], col2: [0.16, 0.22, 0.31], trees: 0.0,  grass: 0.0,  rocks: 0.5, flowers: 0 },
  { name: 'Seabed',     col: [0.72, 0.66, 0.48], col2: [0.62, 0.57, 0.42], trees: 0.0,  grass: 0.1,  rocks: 0.6, flowers: 0 },
  { name: 'Reef',       col: [0.83, 0.76, 0.54], col2: [0.52, 0.72, 0.62], trees: 0.0,  grass: 0.5,  rocks: 1.2, flowers: 0.4 },
  { name: 'Shore',      col: [0.89, 0.80, 0.58], col2: [0.83, 0.73, 0.51], trees: 0.02, grass: 0.05, rocks: 0.35, flowers: 0.02 },
  { name: 'Grassland',  col: [0.56, 0.73, 0.36], col2: [0.66, 0.79, 0.42], trees: 0.10, grass: 1.0,  rocks: 0.16, flowers: 0.7 },
  { name: 'Forest',     col: [0.42, 0.63, 0.32], col2: [0.50, 0.70, 0.37], trees: 0.85, grass: 0.7,  rocks: 0.22, flowers: 0.35 },
  { name: 'Rainforest', col: [0.31, 0.58, 0.30], col2: [0.38, 0.66, 0.34], trees: 1.35, grass: 0.9,  rocks: 0.14, flowers: 0.5 },
  { name: 'Taiga',      col: [0.48, 0.63, 0.41], col2: [0.55, 0.67, 0.46], trees: 0.75, grass: 0.4,  rocks: 0.35, flowers: 0.15 },
  { name: 'Tundra',     col: [0.70, 0.67, 0.51], col2: [0.77, 0.72, 0.57], trees: 0.05, grass: 0.35, rocks: 0.5, flowers: 0.12 },
  { name: 'Snowfield',  col: [0.93, 0.94, 0.97], col2: [0.86, 0.89, 0.94], trees: 0.03, grass: 0.02, rocks: 0.4, flowers: 0 },
  { name: 'Desert',     col: [0.91, 0.76, 0.49], col2: [0.85, 0.68, 0.42], trees: 0.02, grass: 0.06, rocks: 0.3, flowers: 0.03 },
  { name: 'Savanna',    col: [0.80, 0.71, 0.38], col2: [0.86, 0.77, 0.44], trees: 0.12, grass: 0.8,  rocks: 0.2, flowers: 0.2 },
  { name: 'Wetland',    col: [0.44, 0.62, 0.35], col2: [0.50, 0.65, 0.39], trees: 0.35, grass: 1.2,  rocks: 0.08, flowers: 0.45 },
  { name: 'Alpine',     col: [0.66, 0.64, 0.70], col2: [0.73, 0.71, 0.76], trees: 0.10, grass: 0.25, rocks: 0.9, flowers: 0.3 },
  { name: 'Scree',      col: [0.60, 0.58, 0.65], col2: [0.53, 0.51, 0.58], trees: 0.0,  grass: 0.03, rocks: 1.4, flowers: 0.02 },
  { name: 'Meadow',     col: [0.59, 0.76, 0.37], col2: [0.68, 0.82, 0.44], trees: 0.18, grass: 1.4,  rocks: 0.1, flowers: 1.6 },
];
// sRGB -> linear, once, in place (this module runs in workers, so no three).
for (const info of BIOME_INFO) {
  for (const key of ['col', 'col2']) {
    info[key] = info[key].map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  }
}

export const SETTLEMENT = { NONE: 0, HAMLET: 1, VILLAGE: 2, TOWN: 3, CITY: 4 };
export const SETTLEMENT_INFO = [
  { name: '', radius: 0 },
  { name: 'hamlet', radius: 70 },
  { name: 'village', radius: 130 },
  { name: 'town', radius: 300 },
  { name: 'city', radius: 620 },
];

const LAKE_CELL = 2300;
const TOWN_CELL = 4200;
const CTX_TILE = 384;

/* ------------------------------------------------------------------- oracle */

export class WorldGen {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.n = {
      warp: new Noise(seed + 1),
      warp2: new Noise(seed + 2),
      cont: new Noise(seed + 3),
      mount: new Noise(seed + 4),
      mreg: new Noise(seed + 5),
      hills: new Noise(seed + 6),
      detail: new Noise(seed + 7),
      river: new Noise(seed + 8),
      riverW: new Noise(seed + 9),
      temp: new Noise(seed + 10),
      moist: new Noise(seed + 11),
      ocean: new Noise(seed + 12),
      trench: new Noise(seed + 13),
      ero: new Noise(seed + 14),
      patch: new Noise(seed + 15),
      cloud: new Noise(seed + 16),
    };
    this._lakeCells = new Map();
    this._townCells = new Map();
    this._ctxCache = new Map();
    this._ctxOrder = [];
    this._s = {}; // scratch sample object
  }

  /* ---------------------------------------------------------- domain warp */

  _warp(x, z, out) {
    const n = this.n;
    const wx = n.warp.fbm2(x * 0.00016 + 41.7, z * 0.00016 - 12.3, 3);
    const wz = n.warp2.fbm2(x * 0.00016 - 7.1, z * 0.00016 + 88.9, 3);
    out[0] = x + wx * 780;
    out[1] = z + wz * 780;
    return out;
  }

  /* ------------------------------------------------------- continent base */

  /** Continentalness in [-1, 1]. Negative is ocean. */
  continent(x, z) {
    const w = this._warp(x, z, TMP2);
    return this.n.cont.fbm2(w[0] * 0.000072, w[1] * 0.000072, 5, 2.02, 0.52);
  }

  /**
   * Low-frequency "smooth" terrain, ignoring detail, rivers and lakes.
   * River surfaces are derived from this so that water always runs downhill.
   */
  baseHeight(x, z) {
    const n = this.n;
    const w = this._warp(x, z, TMP2);
    const wx = w[0];
    const wz = w[1];
    const cont = n.cont.fbm2(wx * 0.000072, wz * 0.000072, 5, 2.02, 0.52);
    let h = spline(CONT_SPLINE, cont);

    // Where erosion is high the land is worn flat; where low, it is rugged.
    const ero = n.ero.fbm2(wx * 0.00031, wz * 0.00031, 3) * 0.5 + 0.5;
    const rugged = 0.35 + 0.9 * (1 - ero);

    // Mountain belts follow their own low-frequency mask, so ranges have a
    // direction and a beginning and an end rather than being noise everywhere.
    const region = n.mreg.fbm2(wx * 0.00019, wz * 0.00019, 3) * 0.5 + 0.5;
    const mMask = smoothstep(0.085, 0.42, cont) * smoothstep(0.30, 0.62, region);
    if (mMask > 0.001) {
      const ridge = n.mount.ridged2(wx * 0.00040, wz * 0.00040, 5, 2.07, 0.5);
      h += Math.pow(ridge, 1.28) * 1560 * mMask * rugged;
      const peaks = n.mount.ridged2(wx * 0.00135 + 5.5, wz * 0.00135 - 3.3, 4);
      h += peaks * 210 * mMask * smoothstep(160, 620, h);
    }

    // Rolling hills on land.
    const land = smoothstep(-30, 20, h);
    h += n.hills.fbm2(wx * 0.00105, wz * 0.00105, 4) * 44 * land * rugged;

    // Ocean floor: mid-ocean ridges plus rare deep trenches.
    const oc = smoothstep(0.06, -0.30, cont);
    if (oc > 0.001) {
      const ridge = n.ocean.ridged2(wx * 0.00028, wz * 0.00028, 4);
      h += (ridge - 0.30) * 300 * oc;
      const tr = 1 - smoothstep(0.0, 0.055, Math.abs(n.trench.fbm2(wx * 0.000085, wz * 0.000085, 3)));
      h -= tr * tr * 980 * oc;
    }
    return h;
  }

  /* ------------------------------------------------------------- contexts */

  /**
   * Per-tile cache of the "sparse" world features near a point: lakes, towns
   * and roads. Terrain sampling hits this once per vertex, so it has to be
   * cheap; building it is comparatively expensive but happens rarely.
   */
  context(x, z) {
    const tx = Math.floor(x / CTX_TILE);
    const tz = Math.floor(z / CTX_TILE);
    const key = tx * 4194304 + tz;
    let c = this._ctxCache.get(key);
    if (c) return c;
    c = this._buildContext(tx, tz);
    this._ctxCache.set(key, c);
    this._ctxOrder.push(key);
    if (this._ctxOrder.length > 2048) {
      const drop = this._ctxOrder.splice(0, 512);
      for (const k of drop) this._ctxCache.delete(k);
    }
    return c;
  }

  _buildContext(tx, tz) {
    const x0 = tx * CTX_TILE;
    const z0 = tz * CTX_TILE;
    const cx = x0 + CTX_TILE * 0.5;
    const cz = z0 + CTX_TILE * 0.5;
    const lakes = [];
    const towns = [];
    const roads = [];

    const lr = Math.ceil((CTX_TILE * 0.5 + 340) / LAKE_CELL);
    const li = Math.floor(cx / LAKE_CELL);
    const lj = Math.floor(cz / LAKE_CELL);
    for (let j = -lr; j <= lr; j++) {
      for (let i = -lr; i <= lr; i++) {
        const lake = this.lakeCell(li + i, lj + j);
        if (lake && dist2(lake.x, lake.z, cx, cz) < sq(lake.r + CTX_TILE)) lakes.push(lake);
      }
    }

    const tr = Math.ceil((CTX_TILE * 0.5 + 900) / TOWN_CELL) + 1;
    const ti = Math.floor(cx / TOWN_CELL);
    const tj = Math.floor(cz / TOWN_CELL);
    for (let j = -tr; j <= tr; j++) {
      for (let i = -tr; i <= tr; i++) {
        const t = this.townCell(ti + i, tj + j);
        if (!t) continue;
        if (dist2(t.x, t.z, cx, cz) < sq(t.radius * 1.35 + CTX_TILE)) towns.push(t);
        for (const link of t.links) {
          if (segDist2(t.x, t.z, link.x, link.z, cx, cz) < sq(CTX_TILE + 40)) {
            roads.push({ ax: t.x, az: t.z, bx: link.x, bz: link.z, ah: t.h, bh: link.h, w: Math.max(t.roadW, link.roadW) });
          }
        }
      }
    }
    return { lakes, towns, roads };
  }

  /* ---------------------------------------------------------------- lakes */

  lakeCell(i, j) {
    const key = i * 4194304 + j;
    let c = this._lakeCells.get(key);
    if (c !== undefined) return c;
    const h = hash3i(i, j, this.seed ^ 0x51ab);
    c = null;
    if ((h & 255) < 96) {
      const rx = ((h >>> 8) & 1023) / 1023;
      const rz = ((h >>> 18) & 1023) / 1023;
      const x = (i + 0.15 + rx * 0.7) * LAKE_CELL;
      const z = (j + 0.15 + rz * 0.7) * LAKE_CELL;
      const bh = this.baseHeight(x, z);
      if (bh > 8 && bh < 780) {
        const r = 60 + hash3f(i, j, this.seed ^ 0x77) * 230;
        c = { x, z, r, level: bh + 1.0, depth: 5 + hash3f(i, j, this.seed ^ 0x99) * 20 };
      }
    }
    this._lakeCells.set(key, c);
    return c;
  }

  /* ----------------------------------------------------------- settlements */

  townCell(i, j) {
    const key = i * 4194304 + j;
    let c = this._townCells.get(key);
    if (c !== undefined) return c;
    c = this._makeTown(i, j);
    this._townCells.set(key, c);
    return c;
  }

  _makeTown(i, j, shallow = false) {
    const h = hash3i(i, j, this.seed ^ 0x2f19);
    const roll = h & 1023;
    let kind = SETTLEMENT.NONE;
    if (roll < 300) kind = SETTLEMENT.HAMLET;
    else if (roll < 560) kind = SETTLEMENT.VILLAGE;
    else if (roll < 700) kind = SETTLEMENT.TOWN;
    else if (roll < 730) kind = SETTLEMENT.CITY;
    if (kind === SETTLEMENT.NONE) return null;

    const rx = ((h >>> 10) & 2047) / 2047;
    const rz = ((h >>> 21) & 2047) / 2047;
    let x = (i + 0.12 + rx * 0.76) * TOWN_CELL;
    let z = (j + 0.12 + rz * 0.76) * TOWN_CELL;

    // Nudge the site toward buildable ground: settlements avoid cliffs and sea.
    let bh = this.baseHeight(x, z);
    let best = { x, z, h: bh, score: this._siteScore(x, z, bh) };
    for (let k = 0; k < 6; k++) {
      const a = hash3f(i, j, this.seed + 300 + k) * 6.2831853;
      const d = 220 + hash3f(i, j, this.seed + 900 + k) * 900;
      const nx = x + Math.cos(a) * d;
      const nz = z + Math.sin(a) * d;
      const nh = this.baseHeight(nx, nz);
      const s = this._siteScore(nx, nz, nh);
      if (s > best.score) best = { x: nx, z: nz, h: nh, score: s };
    }
    if (best.score <= 0) return null;
    x = best.x;
    z = best.z;
    bh = best.h;

    const radius = SETTLEMENT_INFO[kind].radius * (0.8 + hash3f(i, j, this.seed ^ 0xa1) * 0.5);
    const town = {
      i, j, kind, x, z, h: bh, radius,
      name: townName(hash3i(i, j, this.seed ^ 0xbee5)),
      roadW: kind >= SETTLEMENT.TOWN ? 7.5 : kind === SETTLEMENT.VILLAGE ? 5.5 : 4.0,
      links: [],
      seed: hash3i(i, j, this.seed ^ 0x1234),
    };
    if (shallow) return town;

    // Roads: connect to the nearest settlements in the neighbouring cells.
    const cands = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const o = this._townCellShallow(i + di, j + dj);
        if (o) cands.push(o);
      }
    }
    cands.sort((a, b) => dist2(a.x, a.z, x, z) - dist2(b.x, b.z, x, z));
    const nLinks = kind >= SETTLEMENT.TOWN ? 3 : 2;
    for (const o of cands.slice(0, nLinks)) town.links.push(o);
    return town;
  }

  _townCellShallow(i, j) {
    const key = 'S' + (i * 4194304 + j);
    let c = this._townCells.get(key);
    if (c !== undefined) return c;
    c = this._makeTown(i, j, true);
    this._townCells.set(key, c);
    return c;
  }

  _siteScore(x, z, h) {
    if (h < 3 || h > 560) return -1;
    const d = 34;
    const h1 = this.baseHeight(x + d, z);
    const h2 = this.baseHeight(x - d, z);
    const h3 = this.baseHeight(x, z + d);
    const h4 = this.baseHeight(x, z - d);
    const slope = (Math.abs(h1 - h2) + Math.abs(h3 - h4)) / (2 * d);
    let s = 1 - clamp(slope * 6, 0, 1);
    s += (1 - clamp(Math.abs(h - 60) / 400, 0, 1)) * 0.4; // prefer lowlands
    return s;
  }

  /* ---------------------------------------------------------------- rivers */

  /**
   * River presence at (x,z).
   * Returns strength in [0,1] and the water surface level of the channel.
   */
  river(x, z, baseH, out) {
    const n = this.n;
    const wx = x + n.warp.fbm2(x * 0.00052 + 3.3, z * 0.00052 - 9.1, 2) * 190;
    const wz = z + n.warp2.fbm2(x * 0.00052 - 5.7, z * 0.00052 + 2.4, 2) * 190;
    const f = n.river.fbm2(wx * 0.000104, wz * 0.000104, 4, 2.03, 0.5);
    const d = Math.abs(f);
    // Rivers widen as the land falls toward the sea.
    const size = n.riverW.fbm2(x * 0.00021, z * 0.00021, 2) * 0.5 + 0.5;
    const lowland = smoothstep(320, 10, baseH);
    const w = (0.0055 + 0.0125 * size) * (0.45 + 0.95 * lowland);
    let s = 1 - smoothstep(w * 0.30, w, d);
    // No rivers under the sea, and they fade out on high peaks.
    s *= smoothstep(-1.0, 7.0, baseH) * smoothstep(1150, 780, baseH);
    out.strength = s;
    out.width = w;
    out.level = baseH - 1.6;
    return s;
  }

  /* ---------------------------------------------------------------- height */

  /** Terrain surface elevation in metres. */
  height(x, z) {
    return this.sample(x, z, this._s).height;
  }

  /**
   * Full terrain sample. `out` is reused to avoid allocation in hot loops.
   * Fields: height, waterLevel (-Infinity if dry), riverStrength, biome,
   * temperature, moisture, slope-independent extras.
   */
  sample(x, z, out = {}, lod = 0) {
    const n = this.n;
    const w = this._warp(x, z, TMP2);
    const wx = w[0];
    const wz = w[1];
    const cont = n.cont.fbm2(wx * 0.000072, wz * 0.000072, 5, 2.02, 0.52);
    let h = spline(CONT_SPLINE, cont);

    const ero = n.ero.fbm2(wx * 0.00031, wz * 0.00031, 3) * 0.5 + 0.5;
    const rugged = 0.35 + 0.9 * (1 - ero);
    const region = n.mreg.fbm2(wx * 0.00019, wz * 0.00019, 3) * 0.5 + 0.5;
    const mMask = smoothstep(0.085, 0.42, cont) * smoothstep(0.30, 0.62, region);
    let mountain = 0;
    if (mMask > 0.001) {
      const ridge = n.mount.ridged2(wx * 0.00040, wz * 0.00040, 5, 2.07, 0.5);
      mountain = Math.pow(ridge, 1.28) * 1560 * mMask * rugged;
      h += mountain;
      const peaks = n.mount.ridged2(wx * 0.00135 + 5.5, wz * 0.00135 - 3.3, 4);
      const pk = peaks * 210 * mMask * smoothstep(160, 620, h);
      mountain += pk;
      h += pk;
    }

    const land = smoothstep(-30, 20, h);
    h += n.hills.fbm2(wx * 0.00105, wz * 0.00105, 4) * 44 * land * rugged;

    const oc = smoothstep(0.06, -0.30, cont);
    if (oc > 0.001) {
      const ridge = n.ocean.ridged2(wx * 0.00028, wz * 0.00028, 4);
      h += (ridge - 0.30) * 300 * oc;
      const tr = 1 - smoothstep(0.0, 0.055, Math.abs(n.trench.fbm2(wx * 0.000085, wz * 0.000085, 3)));
      h -= tr * tr * 980 * oc;
    }

    const baseH = h;

    // Medium and fine detail. Suppressed underwater (silt smooths the seabed).
    // Distant chunks skip the finest layers - they are sub-pixel anyway.
    const detailAmp = lerp(0.35, 1.0, land);
    if (lod < 5) h += n.detail.fbm2(x * 0.0062, z * 0.0062, 3) * 8.5 * detailAmp * rugged;
    if (lod < 3) h += n.detail.fbm2(x * 0.026 + 13.0, z * 0.026 - 4.0, 2) * 1.9 * detailAmp;
    if (lod < 2) h += n.patch.fbm2(x * 0.11, z * 0.11, 2) * 0.34 * land;

    const ctx = this.context(x, z);

    /* -- settlements flatten and terrace the ground they sit on ----------- */
    let townInfluence = 0;
    let townRef = null;
    for (let i = 0; i < ctx.towns.length; i++) {
      const t = ctx.towns[i];
      const d = Math.sqrt(dist2(t.x, t.z, x, z));
      const inf = 1 - smoothstep(t.radius * 0.72, t.radius * 1.3, d);
      if (inf > townInfluence) {
        townInfluence = inf;
        townRef = t;
      }
    }
    if (townInfluence > 0 && townRef) {
      // Gentle terraces so cities are walkable but still follow the land.
      const terrace = 6;
      const target = Math.round(townRef.h / terrace) * terrace +
        n.hills.fbm2(x * 0.0016, z * 0.0016, 2) * 5 * (1 - townInfluence);
      h = lerp(h, target, townInfluence * 0.94);
    }

    /* -- roads are cut into the hillside ---------------------------------- */
    let road = 0;
    for (let i = 0; i < ctx.roads.length; i++) {
      const r = ctx.roads[i];
      const t = segT(r.ax, r.az, r.bx, r.bz, x, z);
      const px = lerp(r.ax, r.bx, t);
      const pz = lerp(r.az, r.bz, t);
      const d = Math.sqrt(dist2(px, pz, x, z));
      const on = 1 - smoothstep(r.w, r.w * 2.4, d);
      if (on > road) {
        road = on;
        if (on > 0.01) {
          const rh = lerp(r.ah, r.bh, t) + (this.baseHeight(px, pz) - lerp(r.ah, r.bh, t)) * 0.55;
          h = lerp(h, rh, on * 0.85);
        }
      }
    }

    /* -- lakes carve bowls and hold still water --------------------------- */
    let waterLevel = -Infinity;
    let lakeAmt = 0;
    for (let i = 0; i < ctx.lakes.length; i++) {
      const L = ctx.lakes[i];
      const d = Math.sqrt(dist2(L.x, L.z, x, z));
      const edge = L.r * (0.82 + 0.2 * n.patch.fbm2(x * 0.0035 + L.x * 0.01, z * 0.0035, 2));
      if (d < edge * 1.25) {
        const k = 1 - smoothstep(edge * 0.72, edge * 1.18, d);
        if (k > 0) {
          const bowl = L.level - L.depth * Math.sqrt(Math.max(0, 1 - sq(d / (edge * 1.05))));
          h = lerp(h, Math.min(h, bowl), k);
          if (k > 0.06 && h < L.level) {
            waterLevel = Math.max(waterLevel, L.level);
            lakeAmt = Math.max(lakeAmt, k);
          }
        }
      }
    }

    /* -- rivers ------------------------------------------------------------ */
    let riverStrength = 0;
    TMPR.level = baseH - 1.6;
    if (baseH > -4 && baseH < 1220) {
      const rv = this.river(x, z, baseH, TMPR);
      if (rv > 0.002) {
        const depth = 0.9 + 5.5 * rv;
        const bed = TMPR.level - depth;
        const k = smoothstep(0.0, 0.85, rv);
        h = lerp(h, Math.min(h, bed), k);
        riverStrength = rv;
        if (h < TMPR.level && rv > 0.05) waterLevel = Math.max(waterLevel, TMPR.level);
      }
    }

    if (h < SEA_LEVEL) waterLevel = Math.max(waterLevel, SEA_LEVEL);

    /* -- climate ----------------------------------------------------------- */
    // The raw fbm distribution clusters around the middle, which would make
    // every biome temperate. Expanding it gives the world real deserts and
    // real ice.
    const tBase = 15 + 25 * expand(n.temp.fbm2(x * 0.000058, z * 0.000058, 3), 0.62) +
      3.5 * n.temp.fbm2(x * 0.00042, z * 0.00042, 2);
    const temperature = tBase - Math.max(0, h) * 0.0068;
    let moisture = 0.5 + 0.55 * expand(n.moist.fbm2(x * 0.00014, z * 0.00014, 4), 0.6);
    moisture = saturate(moisture + smoothstep(0.15, -0.25, cont) * 0.18 + riverStrength * 0.25 + lakeAmt * 0.2);

    out.height = h;
    out.baseHeight = baseH;
    out.waterLevel = waterLevel;
    out.riverStrength = riverStrength;
    out.riverLevel = TMPR.level;
    out.lake = lakeAmt;
    out.continent = cont;
    out.mountain = mountain;
    out.temperature = temperature;
    out.moisture = moisture;
    out.town = townInfluence > 0.05 ? townRef : null;
    out.townInfluence = townInfluence;
    out.road = road;
    out.biome = this.classify(h, waterLevel, temperature, moisture, riverStrength, out);
    return out;
  }

  classify(h, waterLevel, temp, moist, river, s) {
    if (h < -220) return BIOME.DEEP_OCEAN;
    if (h < -12) return h > -30 && temp > 20 && moist > 0.4 ? BIOME.REEF : BIOME.OCEAN;
    if (h < 0) return temp > 21 ? BIOME.REEF : BIOME.OCEAN;
    if (h < 2.6 && waterLevel === SEA_LEVEL) return BIOME.BEACH;
    if (h > 1550 || (h > 1150 && temp < 2)) return BIOME.SNOW;
    if (h > 980) return temp < 0 ? BIOME.SNOW : BIOME.SCREE;
    if (h > 720) return BIOME.ALPINE;
    if (temp < -6) return BIOME.SNOW;
    if (temp < 0.5) return moist > 0.42 ? BIOME.TAIGA : BIOME.TUNDRA;
    if (temp < 6) return moist > 0.46 ? BIOME.TAIGA : BIOME.TUNDRA;
    if (temp > 26 && moist < 0.34) return BIOME.DESERT;
    if (temp > 21 && moist > 0.74) return BIOME.RAINFOREST;
    if (moist > 0.80 && h < 90) return BIOME.SWAMP;
    if (river > 0.02 && moist > 0.55 && h < 260) return BIOME.MEADOW;
    if (temp > 19 && moist < 0.44) return BIOME.SAVANNA;
    if (moist > 0.56) return BIOME.FOREST;
    if (moist > 0.44) return BIOME.MEADOW;
    return BIOME.GRASSLAND;
  }

  /* ------------------------------------------------------------- utilities */

  /** Surface normal via central differences. */
  normal(x, z, eps = 1.0, out = [0, 1, 0]) {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    const nx = hL - hR;
    const ny = 2 * eps;
    const nz = hD - hU;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l;
    out[1] = ny / l;
    out[2] = nz / l;
    return out;
  }

  slope(x, z, eps = 1.5) {
    const n = this.normal(x, z, eps, TMP3);
    return 1 - n[1];
  }

  /** Water surface elevation at a point, or -Infinity where there is none. */
  waterLevel(x, z) {
    return this.sample(x, z, this._s).waterLevel;
  }

  /** Downhill flow direction of a river at a point (unit 2D vector). */
  flowDir(x, z, out = [0, 0]) {
    const e = 26;
    const a = this.baseHeight(x + e, z) - this.baseHeight(x - e, z);
    const b = this.baseHeight(x, z + e) - this.baseHeight(x, z - e);
    const l = Math.hypot(a, b) || 1;
    out[0] = -a / l;
    out[1] = -b / l;
    return out;
  }

  /** The settlement whose footprint contains this point, if any. */
  townAt(x, z) {
    const ctx = this.context(x, z);
    let best = null;
    let bestD = Infinity;
    for (const t of ctx.towns) {
      const d = dist2(t.x, t.z, x, z);
      if (d < sq(t.radius * 1.25) && d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** All settlements whose centre lies within `range` of a point. */
  townsNear(x, z, range = 3000) {
    const out = [];
    const r = Math.ceil(range / TOWN_CELL) + 1;
    const i0 = Math.floor(x / TOWN_CELL);
    const j0 = Math.floor(z / TOWN_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const t = this.townCell(i0 + i, j0 + j);
        if (t && dist2(t.x, t.z, x, z) < range * range) out.push(t);
      }
    }
    return out;
  }

  /**
   * Find a pleasant place to wake up: dry land near the coast or a river,
   * gentle slope, temperate, with a view. Searched deterministically.
   */
  findSpawn(maxTries = 900) {
    const rng = new Rng(this.seed ^ 0xc0ffee);
    let best = null;
    let bestScore = -Infinity;
    const s = {};
    for (let i = 0; i < maxTries; i++) {
      const a = rng.float(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * 26000;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      this.sample(x, z, s);
      if (s.height < 3 || s.height > 320) continue;
      if (s.waterLevel > -Infinity) continue;
      const slope = this.slope(x, z, 3);
      if (slope > 0.28) continue;
      let score = 0;
      score += 3 - Math.abs(s.temperature - 17) * 0.22;
      score += (1 - slope * 3) * 1.4;
      score += s.moisture * 1.1;
      // A little elevation for the view, but not a mountain.
      score += (1 - Math.abs(s.height - 45) / 200) * 1.2;
      if (s.biome === BIOME.FOREST || s.biome === BIOME.MEADOW || s.biome === BIOME.GRASSLAND) score += 1.6;
      if (s.town) score -= 4;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, y: s.height };
      }
    }
    if (!best) {
      // Fall back to a spiral search for any dry land at all.
      for (let i = 0; i < 4000; i++) {
        const a = i * 2.399963;
        const r = 40 * Math.sqrt(i);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = this.height(x, z);
        if (h > 2) return { x, z, y: h };
      }
      return { x: 0, z: 0, y: Math.max(2, this.height(0, 0)) };
    }
    return best;
  }
}

/* ------------------------------------------------------------------ helpers */

const CONT_SPLINE = [
  [-1.0, -880],
  [-0.66, -620],
  [-0.42, -330],
  [-0.24, -125],
  [-0.13, -34],
  [-0.055, -6],
  [-0.012, 1.4],
  [0.03, 5.5],
  [0.09, 15],
  [0.20, 42],
  [0.38, 115],
  [0.60, 270],
  [0.82, 450],
  [1.0, 620],
];

const TMP2 = [0, 0];
const TMP3 = [0, 0, 0];
const TMPR = { strength: 0, width: 0, level: 0 };

function sq(v) {
  return v * v;
}
/** Push a roughly-gaussian noise value out toward its extremes. */
function expand(v, p) {
  return v < 0 ? -Math.pow(-v, p) : Math.pow(v, p);
}
function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
function segT(ax, az, bx, bz, px, pz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-6) return 0;
  return clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
}
function segDist2(ax, az, bx, bz, px, pz) {
  const t = segT(ax, az, bx, bz, px, pz);
  return dist2(ax + (bx - ax) * t, az + (bz - az) * t, px, pz);
}

const NAME_A = ['Ald', 'Bram', 'Cald', 'Dun', 'Elm', 'Fern', 'Gled', 'Haw', 'Ives', 'Kirk', 'Lark', 'Mar', 'North', 'Oak', 'Pen', 'Quill', 'Red', 'Stone', 'Thorn', 'Under', 'Vale', 'West', 'Yar'];
const NAME_B = ['bury', 'ford', 'holm', 'wick', 'dale', 'ridge', 'field', 'brook', 'mere', 'stead', 'gate', 'haven', 'combe', 'cross', 'hollow', 'moor'];

export function townName(h) {
  const a = NAME_A[h % NAME_A.length];
  const b = NAME_B[(h >>> 8) % NAME_B.length];
  return a + b;
}

export { clamp, lerp, saturate, smoothstep, spline };

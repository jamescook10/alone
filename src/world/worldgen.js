// The world oracle.
//
// Every question about the world - "how high is the ground here?", "is this a
// desert?", "is there a river?", "is there a town?" - is answered by a pure
// function of (x, z) and the world seed. Nothing is stored, so the world is
// infinite in every direction and identical for everyone holding the same seed.
//
// This module must stay free of three.js imports: it runs inside Web Workers.
//
// The shape of a place is decided in two passes. First a *landform province* -
// a field with a wavelength of tens of kilometres - decides what kind of
// country this is: flat plain, rolling downs, plateau, tower karst, sand sea,
// drowned archipelago, volcanic waste, or (rarely) a real mountain range. Then
// the usual noise stack is scaled by that province. Mountains used to be
// everywhere because nothing said they should not be; now they need a mountain
// belt *and* a high-relief province, which together cover a few per cent of the
// map. Everywhere else is honestly, deliberately flat.

import { Noise, Rng, hash3i, hash3f, worley2, clamp, lerp, saturate, smoothstep, spline } from '../core/noise.js';
import { BIOME, BIOME_INFO, SPECIES, SPECIES_INFO, speciesFor, s2l, NO_ROAD, SUBMERGED } from './biomes.js';

export { BIOME, BIOME_INFO, SPECIES, SPECIES_INFO, speciesFor, s2l, NO_ROAD, SUBMERGED };

export const SEA_LEVEL = 0;
export const BIOME_COUNT = BIOME_INFO.length;

export const SETTLEMENT = { NONE: 0, HAMLET: 1, VILLAGE: 2, TOWN: 3, CITY: 4 };
export const SETTLEMENT_INFO = [
  { name: '', radius: 0 },
  { name: 'hamlet', radius: 70 },
  { name: 'village', radius: 130 },
  { name: 'town', radius: 300 },
  { name: 'city', radius: 620 },
];

/** Road surfaces, weakest to strongest. The ground colour follows this. */
export const SURFACE = { NONE: 0, DIRT: 1, GRAVEL: 2, TARMAC: 3 };

/**
 * The things people left standing outside the towns. Each one is only ever
 * placed where it would make sense: lighthouses on headlands, temples in the
 * jungle, research huts on the ice, airstrips on genuinely flat ground.
 */
export const SITE = {
  FARMSTEAD: 1, BARN: 2, WINDMILL: 3, LIGHTHOUSE: 4, FISHING_HUT: 5, JETTY: 6,
  SHIPWRECK: 7, WATCHTOWER: 8, CHAPEL: 9, STONE_CIRCLE: 10, QUARRY: 11,
  MINE: 12, RADIO_MAST: 13, FORT: 14, TEMPLE: 15, RESEARCH: 16, AIRSTRIP: 17,
  PLANE_WRECK: 18, CABIN: 19, CAMP: 20, WATER_TOWER: 21, WELL: 22, RUIN: 23,
  TRAIN: 24, HARBOUR: 25,
};

export const SITE_INFO = {
  [SITE.FARMSTEAD]: { name: 'farmstead', radius: 30 },
  [SITE.BARN]: { name: 'barn', radius: 16 },
  [SITE.WINDMILL]: { name: 'windmill', radius: 12 },
  [SITE.LIGHTHOUSE]: { name: 'lighthouse', radius: 14 },
  [SITE.FISHING_HUT]: { name: 'fishing hut', radius: 12 },
  [SITE.JETTY]: { name: 'jetty', radius: 18 },
  [SITE.SHIPWRECK]: { name: 'wreck', radius: 24 },
  [SITE.WATCHTOWER]: { name: 'watchtower', radius: 10 },
  [SITE.CHAPEL]: { name: 'ruined chapel', radius: 14 },
  [SITE.STONE_CIRCLE]: { name: 'standing stones', radius: 16 },
  [SITE.QUARRY]: { name: 'quarry', radius: 34 },
  [SITE.MINE]: { name: 'mine head', radius: 20 },
  [SITE.RADIO_MAST]: { name: 'radio mast', radius: 14 },
  [SITE.FORT]: { name: 'desert fort', radius: 26 },
  [SITE.TEMPLE]: { name: 'overgrown temple', radius: 26 },
  [SITE.RESEARCH]: { name: 'research station', radius: 20 },
  [SITE.AIRSTRIP]: { name: 'airstrip', radius: 95 },
  [SITE.PLANE_WRECK]: { name: 'crashed aeroplane', radius: 18 },
  [SITE.CABIN]: { name: 'cabin', radius: 12 },
  [SITE.CAMP]: { name: 'abandoned camp', radius: 12 },
  [SITE.WATER_TOWER]: { name: 'water tower', radius: 10 },
  [SITE.WELL]: { name: 'well', radius: 10 },
  [SITE.RUIN]: { name: 'ruin', radius: 18 },
  [SITE.TRAIN]: { name: 'stopped train', radius: 40 },
  [SITE.HARBOUR]: { name: 'harbour', radius: 34 },
};

const LAKE_CELL = 2300;
const TOWN_CELL = 4200;
const SITE_CELL = 1250;
const CTX_TILE = 384;
// Landform provinces have wavelengths of ten kilometres and up, so evaluating
// them per vertex would be pure waste. They are sampled on this lattice and
// bilinearly interpolated - still a pure function of (x, z), so all five
// meshing workers agree to the last bit.
const LF_CELL = 288;

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
      // landform province fields
      lfw: new Noise(seed + 21),
      relief: new Noise(seed + 22),
      hilly: new Noise(seed + 23),
      style: new Noise(seed + 24),
      isle: new Noise(seed + 25),
      dune: new Noise(seed + 26),
      karst: new Noise(seed + 27),
    };
    this._lakeCells = new Map();
    this._townCells = new Map();
    this._siteCells = new Map();
    this._ctxCache = new Map();
    this._ctxOrder = [];
    this._lfCache = new Map();
    this._lfOrder = [];
    this._s = {}; // scratch sample object
    this._q = {}; // scratch shallow sample
  }

  /* ------------------------------------------------------------- landforms */

  /**
   * The province fields at a point, all in [0,1]:
   *
   *   relief   how mountainous - deliberately rare, see the curve below
   *   hill     how rolling; the common source of everyday relief
   *   mesa     flat-topped benches and cliff risers (plateau, badlands)
   *   karst    isolated limestone towers
   *   frac     coastal fragmentation: turns a smooth coast into islands
   *   basin    flat floors that collect water, salt and peat
   *   volc     volcanic waste: lava plains with the odd cone
   */
  landform(x, z, out = {}) {
    const gx = Math.floor(x / LF_CELL);
    const gz = Math.floor(z / LF_CELL);
    const fx = x / LF_CELL - gx;
    const fz = z / LF_CELL - gz;
    const a = this._lfAt(gx, gz);
    const b = this._lfAt(gx + 1, gz);
    const c = this._lfAt(gx, gz + 1);
    const d = this._lfAt(gx + 1, gz + 1);
    for (let i = 0; i < LF_KEYS.length; i++) {
      const k = LF_KEYS[i];
      const top = a[k] + (b[k] - a[k]) * fx;
      const bot = c[k] + (d[k] - c[k]) * fx;
      out[k] = top + (bot - top) * fz;
    }
    return out;
  }

  _lfAt(gi, gj) {
    const key = gi * 4194304 + gj;
    let v = this._lfCache.get(key);
    if (v !== undefined) return v;
    v = this._lfBuild(gi * LF_CELL, gj * LF_CELL);
    this._lfCache.set(key, v);
    this._lfOrder.push(key);
    if (this._lfOrder.length > 32768) {
      const drop = this._lfOrder.splice(0, 8192);
      for (const k of drop) this._lfCache.delete(k);
    }
    return v;
  }

  _lfBuild(x, z) {
    const n = this.n;
    // Warp the province fields hard so their boundaries are ragged coastline
    // shapes rather than the smooth blobs of raw fbm.
    const wx = x + n.lfw.fbm2(x * 0.0000068 + 4.1, z * 0.0000068 - 2.7, 2) * 14000;
    const wz = z + n.lfw.fbm2(x * 0.0000068 - 9.3, z * 0.0000068 + 6.5, 2) * 14000;

    // Relief. fbm is roughly gaussian about 0.5; this curve throws away the
    // bottom third and then squares what is left, so the median province has
    // relief 0.05 - genuinely flat - and only the top couple of per cent are
    // mountains. That single line is why the world stopped being all peaks.
    const r0 = n.relief.fbm2(wx * 0.0000095, wz * 0.0000095, 3) * 0.5 + 0.5;
    const relief = Math.pow(saturate((r0 - 0.30) / 0.70), 2.4);

    // Hilliness is independent of relief, so you get flat country inside a
    // mountain province (a valley floor) and rolling downs with no mountains
    // anywhere near them.
    const h0 = n.hilly.fbm2(wx * 0.000038 + 11.3, wz * 0.000038 - 4.4, 3) * 0.5 + 0.5;
    const hill = smoothstep(0.34, 0.80, h0);

    // One "style" field picks between the exotic landforms, so a region is a
    // sand sea or a karst or a lava field - never a muddle of all three.
    const st = n.style.fbm2(wx * 0.0000125 - 21.7, wz * 0.0000125 + 13.9, 3) * 0.5 + 0.5;
    const band = (lo, hi) => smoothstep(lo, lo + 0.04, st) * smoothstep(hi, hi - 0.04, st);

    const isl = n.isle.fbm2(wx * 0.000030 + 7.7, wz * 0.000030 - 3.1, 2) * 0.5 + 0.5;

    const out = {
      relief,
      hill,
      // Plateaux want low-to-middling relief; a mesa inside a mountain range
      // would just be noise on noise.
      mesa: band(0.06, 0.26) * (1 - smoothstep(0.25, 0.6, relief)),
      karst: band(0.72, 0.86) * (0.35 + 0.65 * hill),
      volc: band(0.82, 1.10),
      frac: smoothstep(0.55, 0.92, isl) * (1 - smoothstep(0.3, 0.7, relief)),
      basin: band(0.26, 0.42) * (1 - smoothstep(0.15, 0.45, relief)),
      dune: band(0.56, 0.74),
    };
    return out;
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
    return this._shape(x, z, TMPS, 9).cont;
  }

  /**
   * The shape of the ground before rivers, lakes and anything people built:
   * continent, province relief, hills and the exotic landforms. Both
   * `baseHeight` (used by rivers, roads and site scoring) and the full
   * `sample` go through here, so the two can never drift apart.
   *
   * `lod` suppresses the finest detail octaves on distant chunks.
   */
  _shape(x, z, o, lod = 0) {
    const n = this.n;
    const w = this._warp(x, z, TMP2);
    const wx = w[0];
    const wz = w[1];
    const lf = this.landform(x, z, o.lf || (o.lf = {}));

    let cont = n.cont.fbm2(wx * 0.000072, wz * 0.000072, 5, 2.02, 0.52);
    // Archipelago provinces drown the shelf and then punch islands back
    // through it, which scatters land instead of simply making more of it.
    if (lf.frac > 0.01) {
      const coast = smoothstep(0.42, 0.02, Math.abs(cont));
      const k = lf.frac * coast;
      cont += (-0.10 + n.isle.fbm2(wx * 0.00058, wz * 0.00058, 3) * 0.42) * k;
    }
    let h = spline(CONT_SPLINE, cont);

    // Erosion worn-ness, then the province's own ruggedness on top.
    const ero = n.ero.fbm2(wx * 0.00031, wz * 0.00031, 3) * 0.5 + 0.5;
    const rugged = (0.30 + 0.85 * (1 - ero)) * (0.40 + 1.05 * lf.hill);

    // Mountains need a belt *and* a high-relief province. Both together are
    // rare, which is the point: on most of the world this term is zero.
    const region = n.mreg.fbm2(wx * 0.00019, wz * 0.00019, 3) * 0.5 + 0.5;
    const mAmt = smoothstep(0.10, 0.45, lf.relief);
    const mMask = smoothstep(0.06, 0.38, cont) * smoothstep(0.32, 0.64, region) * mAmt;
    let mountain = 0;
    if (mMask > 0.001) {
      const ridge = n.mount.ridged2(wx * 0.00040, wz * 0.00040, 5, 2.07, 0.5);
      // Rare enough to be worth being enormous: a range that does exist runs
      // to two and a half thousand metres, with snow and scree on top of it.
      mountain = Math.pow(ridge, 1.25) * 2600 * mMask * (0.55 + 0.55 * rugged);
      h += mountain;
      const peaks = n.mount.ridged2(wx * 0.00135 + 5.5, wz * 0.00135 - 3.3, 4);
      const pk = peaks * 320 * mMask * smoothstep(160, 620, h);
      mountain += pk;
      h += pk;
    }

    // Everyday relief. On a plain province this is a few metres of swell over
    // a kilometre - which is what a plain actually looks like.
    const land = smoothstep(-30, 20, h);
    const hillAmp = 5 + 66 * lf.hill * lf.hill + 46 * lf.relief;
    h += n.hills.fbm2(wx * 0.00105, wz * 0.00105, 4) * hillAmp * land * (0.45 + 0.55 * rugged);

    // Ocean floor: mid-ocean ridges plus rare deep trenches.
    const oc = smoothstep(0.06, -0.30, cont);
    if (oc > 0.001) {
      const ridge = n.ocean.ridged2(wx * 0.00028, wz * 0.00028, 4);
      h += (ridge - 0.30) * 300 * oc;
      const tr = 1 - smoothstep(0.0, 0.055, Math.abs(n.trench.fbm2(wx * 0.000085, wz * 0.000085, 3)));
      h -= tr * tr * 980 * oc;
    }

    /* -- basins: flat floors that collect water, salt and peat ------------ */
    if (lf.basin > 0.02 && land > 0.02) {
      const k = lf.basin * land * 0.85;
      // Squash the relief toward a low, level floor rather than digging a
      // hole: a basin is flat, not deep.
      h = lerp(h, 6 + h * 0.14, k);
    }

    /* -- plateaux and badlands: flat benches with cliff risers ------------ */
    if (lf.mesa > 0.02 && land > 0.05) {
      const step = 32;
      const q = h / step;
      const fl = Math.floor(q);
      // Sharpen the fractional part so the transition between benches reads
      // as a cliff instead of a ramp.
      const terraced = (fl + smoothstep(0.36, 0.64, q - fl)) * step;
      h = lerp(h, terraced, lf.mesa * 0.8 * land);
    }

    /* -- tower karst ------------------------------------------------------ */
    if (lf.karst > 0.03 && land > 0.2) {
      const k = n.karst.ridged2(wx * 0.00165, wz * 0.00165, 3, 2.1, 0.46);
      // Cubed, so the towers are isolated spikes rather than a rolling ridge.
      h += k * k * k * 230 * lf.karst * land;
    }

    /* -- volcanic cones over a lava plain --------------------------------- */
    if (lf.volc > 0.04 && cont > 0.02) {
      const W = worley2(x / 3400, z / 3400, this.seed ^ 0x5c07, TMPW);
      const cone = Math.max(0, 1 - W.f1 * 3.6);
      const up = Math.pow(cone, 1.8) * 720 * lf.volc;
      // A crater in the very middle, so a cone is unmistakably a volcano.
      const crater = Math.max(0, 1 - W.f1 * 22);
      h += up - crater * crater * 120 * lf.volc;
      mountain = Math.max(mountain, up);
    }

    /* -- climate, before the fine detail (dunes need to know it) ---------- */
    // The raw fbm is near-gaussian, so left alone it would put four fifths of
    // the world between 5 and 25 °C and the game would have no Arctic and no
    // Sahara. `rank` flattens it into an even [0,1] and the splines below then
    // say, explicitly and in quantiles, what fraction of the world should be
    // how cold and how wet.
    // Climate belts are continental. At the frequencies this used to run at,
    // a ten-kilometre walk moved you 13 °C on average and up to 60 at worst -
    // you crossed every climate on Earth in half an hour and there was nothing
    // left to travel for. These are roughly six times slower, so where you are
    // is a place rather than a coincidence.
    //
    // The second, fine term is not a second climate: it is small and short so
    // it only frays the edge where a threshold happens to fall, which is what
    // keeps a boundary a mottled band instead of a drawn line.
    const tSea = spline(TEMP_SPLINE, rank(n.temp.fbm2(x * 0.0000042, z * 0.0000042, 2))) +
      1.0 * n.temp.fbm2(x * 0.0014, z * 0.0014, 2);
    let moist = saturate(spline(MOIST_SPLINE, rank(n.moist.fbm2(x * 0.0000085, z * 0.0000085, 2)))
      + 0.035 * n.moist.fbm2(x * 0.0019, z * 0.0019, 2));
    // Coasts are wetter than continental interiors.
    moist = saturate(moist + smoothstep(0.15, -0.25, cont) * 0.16);

    /* -- sand seas: wind-aligned dune ridges ------------------------------ */
    const arid = saturate((tSea - 17) / 12) * saturate((0.42 - moist) / 0.28);
    const duneAmt = lf.dune * arid * land;
    if (duneAmt > 0.02) {
      // Sampling the noise on a squashed, rotated frame is what gives dunes
      // their long parallel crests instead of a bumpy field.
      const ax = x * 0.9397 + z * 0.3420;
      const az = -x * 0.3420 + z * 0.9397;
      const d1 = n.dune.billow2(ax * 0.0055, az * 0.00072, 2) * 0.5 + 0.5;
      const d2 = n.dune.billow2(ax * 0.00105 + 30, az * 0.00021 - 7, 2) * 0.5 + 0.5;
      h += (d1 * 14 + d2 * 46) * duneAmt;
    }

    const baseH = h;

    // Medium and fine detail. Suppressed underwater (silt smooths the seabed)
    // and on flat provinces, where a bumpy field would undo the whole point.
    const detailAmp = lerp(0.35, 1.0, land) * (0.34 + 0.66 * lf.hill + 0.5 * lf.relief);
    if (lod < 5) h += n.detail.fbm2(x * 0.0062, z * 0.0062, 3) * 8.5 * detailAmp * rugged;
    if (lod < 3) h += n.detail.fbm2(x * 0.026 + 13.0, z * 0.026 - 4.0, 2) * 1.9 * detailAmp;
    if (lod < 2) h += n.patch.fbm2(x * 0.11, z * 0.11, 2) * 0.34 * land;

    o.h = h;
    o.baseH = baseH;
    o.cont = cont;
    o.mountain = mountain;
    o.land = land;
    o.rugged = rugged;
    o.tSea = tSea;
    o.moist0 = moist;
    o.dune = duneAmt;
    return o;
  }

  /**
   * Low-frequency "smooth" terrain, ignoring detail, rivers and lakes.
   * River surfaces are derived from this so that water always runs downhill.
   */
  baseHeight(x, z) {
    return this._shape(x, z, TMPS, 9).baseH;
  }

  /* ------------------------------------------------------------- contexts */

  /**
   * Per-tile cache of the "sparse" world features near a point: lakes, towns,
   * roads, railways and outlying sites. Terrain sampling hits this once per
   * vertex, so it has to be cheap; building it is comparatively expensive but
   * happens rarely.
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
    const rails = [];
    const sites = [];

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
            roads.push({
              ax: t.x, az: t.z, bx: link.x, bz: link.z, ah: t.h, bh: link.h,
              w: Math.max(t.roadW, link.roadW),
              surface: Math.min(Math.max(t.surface, link.surface), t.surfaceCap, link.surfaceCap),
            });
          }
        }
        for (const link of t.railLinks) {
          if (segDist2(t.x, t.z, link.x, link.z, cx, cz) < sq(CTX_TILE + 60)) {
            rails.push({ ax: t.x, az: t.z, bx: link.x, bz: link.z, ah: t.h, bh: link.h, w: 4.2 });
          }
        }
      }
    }

    const sr = Math.ceil((CTX_TILE * 0.5 + 190) / SITE_CELL) + 1;
    const si = Math.floor(cx / SITE_CELL);
    const sj = Math.floor(cz / SITE_CELL);
    for (let j = -sr; j <= sr; j++) {
      for (let i = -sr; i <= sr; i++) {
        const s = this.siteCell(si + i, sj + j);
        if (s && dist2(s.x, s.z, cx, cz) < sq(s.radius * 1.4 + CTX_TILE)) sites.push(s);
      }
    }

    return { lakes, towns, roads, rails, sites };
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
      const sh = this._shape(x, z, TMPS2, 9);
      const bh = sh.baseH;
      // Dry country holds no standing water; a basin province holds plenty.
      const wet = sh.moist0 + sh.lf.basin * 0.35;
      if (bh > 8 && bh < 780 && wet > 0.34) {
        const r = 60 + hash3f(i, j, this.seed ^ 0x77) * 230 * (0.6 + sh.lf.basin);
        c = { x, z, r, level: bh + 1.0, depth: 5 + hash3f(i, j, this.seed ^ 0x99) * 20 };
      }
    }
    this._lakeCells.set(key, c);
    return c;
  }

  /* ----------------------------------------------------------- settlements */

  /**
   * How readily people would settle a spot, 0..1. Deserts, jungles, ice and
   * bare rock score near zero, which is why cities cluster on temperate
   * lowland and why the deep desert holds nothing bigger than a fort.
   */
  habitability(x, z, sh) {
    const s = sh || this._shape(x, z, TMPS2, 9);
    const h = s.baseH;
    if (h < 2 || h > 900) return 0;
    const temp = s.tSea - Math.max(0, h) * 0.0068;
    const moist = s.moist0;
    let k = 1;
    k *= 1 - smoothstep(24, 34, temp);          // too hot
    k *= smoothstep(-9, 2, temp);               // too cold
    k *= smoothstep(0.10, 0.30, moist);         // too dry
    k *= 1 - smoothstep(0.86, 0.99, moist) * 0.7; // swamp
    k *= 1 - smoothstep(0.25, 0.7, s.lf.relief) * 0.8;
    k *= 1 - s.lf.volc * 0.75;
    k *= 1 - smoothstep(400, 850, h) * 0.8;
    return saturate(k);
  }

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

    // Nudge the site toward buildable ground: settlements avoid cliffs, sea
    // and country nobody would farm.
    let best = { x, z, h: 0, score: -1 };
    for (let k = 0; k < 7; k++) {
      let nx = x, nz = z;
      if (k > 0) {
        const a = hash3f(i, j, this.seed + 300 + k) * 6.2831853;
        const d = 220 + hash3f(i, j, this.seed + 900 + k) * 1100;
        nx = x + Math.cos(a) * d;
        nz = z + Math.sin(a) * d;
      }
      const sh = this._shape(nx, nz, TMPS3, 9);
      const s = this._siteScore(nx, nz, sh);
      if (s > best.score) best = { x: nx, z: nz, h: sh.baseH, score: s, hab: this.habitability(nx, nz, sh) };
    }
    if (best.score <= 0) return null;
    x = best.x;
    z = best.z;
    const bh = best.h;
    const hab = best.hab;

    // Hostile country shrinks what people managed to build there: a city needs
    // farmland around it, a hamlet only needs a reason to stop.
    if (hab < 0.06) return null;
    if (kind === SETTLEMENT.CITY && hab < 0.62) kind = SETTLEMENT.TOWN;
    if (kind === SETTLEMENT.TOWN && hab < 0.34) kind = SETTLEMENT.VILLAGE;
    if (kind >= SETTLEMENT.VILLAGE && hab < 0.16) kind = SETTLEMENT.HAMLET;

    // Two separate questions. `surface` is what this settlement is important
    // enough to justify; `surfaceCap` is the best the country underfoot will
    // carry. A road is then as good as its more important end allows and its
    // rougher end permits - which is why the lane out of a city stays tarmac
    // all the way to the hamlet, and why nothing is tarmac in the jungle.
    const shHere = this._shape(x, z, TMPS3, 9);
    const biome = this._quickBiome(shHere);
    let surface = kind >= SETTLEMENT.TOWN ? SURFACE.TARMAC
      : kind === SETTLEMENT.VILLAGE ? SURFACE.GRAVEL : SURFACE.DIRT;
    const info = BIOME_INFO[biome];
    let surfaceCap = info.road === 'dirt' ? SURFACE.DIRT
      : info.road === 'gravel' ? SURFACE.GRAVEL
      : info.road === 'tarmac' ? SURFACE.TARMAC : SURFACE.DIRT;
    if (NO_ROAD.has(biome)) surfaceCap = SURFACE.DIRT;
    if (hab < 0.30) surfaceCap = Math.min(surfaceCap, SURFACE.GRAVEL);
    if (hab < 0.14) surfaceCap = SURFACE.DIRT;
    surface = Math.min(surface, surfaceCap);

    const radius = SETTLEMENT_INFO[kind].radius * (0.8 + hash3f(i, j, this.seed ^ 0xa1) * 0.5);
    const town = {
      i, j, kind, x, z, h: bh, radius, hab, surface, surfaceCap, biome,
      name: townName(hash3i(i, j, this.seed ^ 0xbee5)),
      roadW: kind >= SETTLEMENT.TOWN ? 7.5 : kind === SETTLEMENT.VILLAGE ? 5.5 : 4.0,
      links: [],
      railLinks: [],
      // Only a settlement worth serving gets a railway, and only where the
      // ground would carry one.
      rail: kind >= SETTLEMENT.TOWN && hab > 0.4,
      coastal: bh < 24,
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

    // Railways only ever run between the two nearest rail towns, so the
    // network stays a network instead of a cobweb.
    if (town.rail) {
      const rails = cands.filter((o) => o.rail);
      for (const o of rails.slice(0, 2)) town.railLinks.push(o);
    }
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

  _siteScore(x, z, sh) {
    const h = sh.baseH;
    if (h < 3 || h > 700) return -1;
    const d = 34;
    const h1 = this.baseHeight(x + d, z);
    const h2 = this.baseHeight(x - d, z);
    const h3 = this.baseHeight(x, z + d);
    const h4 = this.baseHeight(x, z - d);
    const slope = (Math.abs(h1 - h2) + Math.abs(h3 - h4)) / (2 * d);
    let s = 1 - clamp(slope * 6, 0, 1);
    s += (1 - clamp(Math.abs(h - 60) / 400, 0, 1)) * 0.4; // prefer lowlands
    s += this.habitability(x, z, sh) * 1.6;
    return s;
  }

  /** Local ground steepness from the smooth base height, 0 flat .. ~1 cliff. */
  baseSlope(x, z, d = 20) {
    const h1 = this.baseHeight(x + d, z);
    const h2 = this.baseHeight(x - d, z);
    const h3 = this.baseHeight(x, z + d);
    const h4 = this.baseHeight(x, z - d);
    return (Math.abs(h1 - h2) + Math.abs(h3 - h4)) / (2 * d);
  }

  /* ------------------------------------------------------------ landmarks */

  /**
   * One possible outlying site per cell. Almost every kind is gated on the
   * country it would stand in, which is the whole point: a lighthouse belongs
   * on a headland, a temple under a jungle canopy, a research hut on the ice.
   * Anything that does not fit returns null and the cell stays empty.
   */
  siteCell(i, j) {
    const key = i * 4194304 + j;
    let c = this._siteCells.get(key);
    if (c !== undefined) return c;
    c = this._makeSite(i, j);
    this._siteCells.set(key, c);
    return c;
  }

  _makeSite(i, j) {
    const h = hash3i(i, j, this.seed ^ 0x71c3);
    if ((h & 1023) > 430) return null; // most of the world is empty

    const rx = ((h >>> 10) & 1023) / 1023;
    const rz = ((h >>> 20) & 1023) / 1023;
    const x = (i + 0.1 + rx * 0.8) * SITE_CELL;
    const z = (j + 0.1 + rz * 0.8) * SITE_CELL;

    const sh = this._shape(x, z, TMPS2, 9);
    const gh = sh.baseH;
    const biome = this._quickBiome(sh);
    const temp = sh.tSea - Math.max(0, gh) * 0.0068;
    const moist = sh.moist0;
    const lf = sh.lf;
    const r = hash3f(i, j, this.seed ^ 0x3a1);
    const r2 = hash3f(i, j, this.seed ^ 0x9d2);

    // Never on top of a settlement.
    if (this._nearTown(x, z, 520)) return null;

    let kind = 0;
    const slope = this.baseSlope(x, z, 24);

    // An airstrip is checked first and on its own terms. It is the only place
    // in the world with an aeroplane in it, so it is worth bending the rules
    // for - and a strip is graded flat by the people who cut it, which is why
    // it only asks for ground that is *nearly* level rather than level.
    // People put aerodromes where people were: a strip out on the moor is a
    // lucky find, a strip on the edge of a town is where you would look. Both
    // exist, and following a road to one is a much better way to find your
    // first aeroplane than walking fifteen kilometres in a straight line.
    const served = this._bigTownNear(x, z, 3200);
    // Near a town people would clear trees and grade a slope for it; out in
    // the wilds the ground has to have been flat and open already.
    const strippable = AIRSTRIP_GROUND.has(biome) || (served && CLEARABLE_GROUND.has(biome));
    if (gh > 4 && strippable && slope < (served ? 0.11 : 0.07) && r > (served ? 0.26 : 0.80)) {
      kind = SITE.AIRSTRIP;
    } else if (gh < -42) {
      // Too deep to see, so there is nothing to put there.
      return null;
    } else if (gh < -3) {
      // Shallow water: a hull on the bottom, visible from the surface.
      kind = r < 0.16 ? SITE.SHIPWRECK : 0;
    } else if (gh < 2.2) {
      // The strand line: wrecks, jetties and the huts of people who fished.
      if (r < 0.30) kind = SITE.SHIPWRECK;
      else if (r < 0.52) kind = SITE.JETTY;
      else if (r < 0.72) kind = SITE.FISHING_HUT;
      else if (r < 0.82 && moist > 0.3) kind = SITE.HARBOUR;
    } else if (gh < 34 && slope > 0.10 && this._nearSea(x, z, 190)) {
      // A headland with the sea below it: exactly where a light goes.
      kind = SITE.LIGHTHOUSE;
    } else if (biome === BIOME.GLACIER || biome === BIOME.POLAR_DESERT || biome === BIOME.SNOW) {
      kind = r < 0.45 ? SITE.RESEARCH : r < 0.62 ? SITE.PLANE_WRECK : 0;
    } else if (biome === BIOME.RAINFOREST || biome === BIOME.CLOUD_FOREST || biome === BIOME.KARST || biome === BIOME.BAMBOO) {
      // No roads out here, so no roadside anything - only what the forest grew
      // over after the people stopped coming.
      kind = r < 0.34 ? SITE.TEMPLE : r < 0.55 ? SITE.RUIN : r < 0.66 ? SITE.PLANE_WRECK : 0;
    } else if (biome === BIOME.DESERT || biome === BIOME.DUNES || biome === BIOME.ROCKY_DESERT || biome === BIOME.SALT_FLAT || biome === BIOME.BADLANDS) {
      if (r < 0.22) kind = SITE.FORT;
      else if (r < 0.40) kind = SITE.WELL;
      else if (r < 0.54) kind = SITE.PLANE_WRECK;
      else if (r < 0.72) kind = SITE.RUIN;
    } else if (biome === BIOME.MANGROVE || biome === BIOME.SWAMP || biome === BIOME.BOG || biome === BIOME.MARSH) {
      kind = r < 0.42 ? SITE.FISHING_HUT : r < 0.58 ? SITE.RUIN : 0;
    } else if (biome === BIOME.LAVA_FIELD) {
      kind = r < 0.34 ? SITE.RESEARCH : r < 0.5 ? SITE.RUIN : 0;
    } else if (biome === BIOME.TAIGA || biome === BIOME.TUNDRA) {
      kind = r < 0.42 ? SITE.CABIN : r < 0.58 ? SITE.CAMP : r < 0.70 ? SITE.MINE : 0;
    } else if (biome === BIOME.ALPINE || biome === BIOME.SCREE || lf.relief > 0.4) {
      kind = r < 0.30 ? SITE.MINE : r < 0.48 ? SITE.RADIO_MAST : r < 0.62 ? SITE.WATCHTOWER : 0;
    } else if (biome === BIOME.MOOR) {
      kind = r < 0.30 ? SITE.STONE_CIRCLE : r < 0.50 ? SITE.QUARRY : r < 0.66 ? SITE.CABIN : 0;
    } else if (biome === BIOME.SAVANNA || biome === BIOME.DRY_FOREST || biome === BIOME.STEPPE) {
      if (r < 0.24) kind = SITE.CAMP;
      else if (r < 0.40) kind = SITE.RUIN;
      else if (r < 0.58) kind = SITE.WATER_TOWER;
    } else if (slope < 0.06 && temp > 2) {
      // Temperate, workable country: this is where people actually farmed.
      if (r < 0.28) kind = SITE.FARMSTEAD;
      else if (r < 0.44) kind = SITE.BARN;
      else if (r < 0.55) kind = SITE.CHAPEL;
      else if (r < 0.64) kind = SITE.WINDMILL;
      else if (r < 0.74) kind = SITE.WATER_TOWER;
      else if (r < 0.88) kind = SITE.RUIN;
    }
    if (!kind) return null;

    // Final sanity: nothing stands on a cliff, and nothing but a wreck sits
    // in the water.
    const wet = gh < SEA_LEVEL + 0.4;
    const seaOK = kind === SITE.SHIPWRECK || kind === SITE.JETTY || kind === SITE.HARBOUR;
    if (wet && !seaOK) return null;
    // A strip is graded flat by whoever cut it, so it gets the same allowance
    // the choice above already granted it; a lighthouse and a mine head are
    // supposed to be on something steep.
    const maxSlope = kind === SITE.AIRSTRIP ? 0.12
      : (kind === SITE.LIGHTHOUSE || kind === SITE.MINE) ? 0.55 : 0.22;
    if (!wet && slope > maxSlope) return null;

    const info = SITE_INFO[kind];
    return {
      i, j, kind, x, z, h: gh, biome,
      radius: info.radius,
      name: info.name,
      yaw: r2 * 6.2831853,
      seed: hash3i(i, j, this.seed ^ 0x4b8f) >>> 0,
      // A pad is levelled under anything with a floor; wrecks and stones are
      // left to lie on whatever they landed on.
      pad: kind !== SITE.SHIPWRECK && kind !== SITE.PLANE_WRECK && kind !== SITE.STONE_CIRCLE && kind !== SITE.RUIN,
    };
  }

  /** The nearest town or city within range, if any. */
  _bigTownNear(x, z, range) {
    const r = Math.ceil(range / TOWN_CELL) + 1;
    const i0 = Math.floor(x / TOWN_CELL);
    const j0 = Math.floor(z / TOWN_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const t = this._townCellShallow(i0 + i, j0 + j);
        if (t && t.kind >= SETTLEMENT.TOWN && dist2(t.x, t.z, x, z) < range * range) return t;
      }
    }
    return null;
  }

  _nearTown(x, z, range) {
    const r = Math.ceil(range / TOWN_CELL) + 1;
    const i0 = Math.floor(x / TOWN_CELL);
    const j0 = Math.floor(z / TOWN_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const t = this._townCellShallow(i0 + i, j0 + j);
        if (t && dist2(t.x, t.z, x, z) < sq(range + t.radius)) return true;
      }
    }
    return false;
  }

  /** Is there open sea within `range`? Used to place coastal things. */
  _nearSea(x, z, range) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 6.2831853;
      if (this.baseHeight(x + Math.cos(a) * range, z + Math.sin(a) * range) < SEA_LEVEL - 3) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- rivers */

  /**
   * River presence at (x,z).
   * Returns strength in [0,1] and the water surface level of the channel.
   */
  river(x, z, baseH, out, moist = 0.6) {
    const n = this.n;
    const wx = x + n.warp.fbm2(x * 0.00052 + 3.3, z * 0.00052 - 9.1, 2) * 190;
    const wz = z + n.warp2.fbm2(x * 0.00052 - 5.7, z * 0.00052 + 2.4, 2) * 190;
    const f = n.river.fbm2(wx * 0.000104, wz * 0.000104, 4, 2.03, 0.5);
    const d = Math.abs(f);
    // Rivers widen as the land falls toward the sea, and dry country has
    // fewer and thinner ones - a permanent river through a sand sea would be
    // the single most obviously wrong thing in the game.
    const size = n.riverW.fbm2(x * 0.00021, z * 0.00021, 2) * 0.5 + 0.5;
    const lowland = smoothstep(320, 10, baseH);
    const wet = smoothstep(0.20, 0.52, moist);
    const w = (0.0055 + 0.0125 * size) * (0.45 + 0.95 * lowland) * (0.25 + 0.85 * wet);
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
   * A cheap sample: shape, climate and biome, with no settlements, roads,
   * lakes or rivers. Used by the placement passes, which must not recurse
   * back into the context they are building.
   */
  quickSample(x, z, out = {}) {
    const sh = this._shape(x, z, out.__sh || (out.__sh = {}), 9);
    out.height = sh.baseH;
    out.temperature = sh.tSea - Math.max(0, sh.baseH) * 0.0068;
    out.moisture = sh.moist0;
    out.biome = this._quickBiome(sh);
    return out;
  }

  /** Biome from a `_shape` result alone - no water bodies, no settlements. */
  _quickBiome(sh) {
    QB.height = sh.baseH;
    QB.waterLevel = sh.baseH < SEA_LEVEL ? SEA_LEVEL : -Infinity;
    QB.temperature = sh.tSea - Math.max(0, sh.baseH) * 0.0068;
    QB.moisture = sh.moist0;
    QB.riverStrength = 0;
    QB.lake = 0;
    QB.mountain = sh.mountain;
    QB.dune = sh.dune;
    QB.lf = sh.lf;
    QB.townInfluence = 0;
    QB.farm = 0;
    QB.town = null;
    return this.classify(QB);
  }

  /**
   * Full terrain sample. `out` is reused to avoid allocation in hot loops.
   */
  sample(x, z, out = {}, lod = 0) {
    const n = this.n;
    const sh = this._shape(x, z, out.__sh || (out.__sh = {}), lod);
    let h = sh.h;
    const baseH = sh.baseH;
    const cont = sh.cont;
    const lf = sh.lf;

    const ctx = this.context(x, z);

    /* -- settlements flatten and terrace the ground they sit on ----------- */
    let townInfluence = 0;
    let townRef = null;
    let farm = 0;
    for (let i = 0; i < ctx.towns.length; i++) {
      const t = ctx.towns[i];
      const d = Math.sqrt(dist2(t.x, t.z, x, z));
      const inf = 1 - smoothstep(t.radius * 0.72, t.radius * 1.3, d);
      if (inf > townInfluence) {
        townInfluence = inf;
        townRef = t;
      }
      // A ring of worked land outside the walls, where the country allows it.
      if (t.hab > 0.4 && t.kind >= SETTLEMENT.VILLAGE) {
        const f = smoothstep(t.radius * 0.9, t.radius * 1.25, d) * (1 - smoothstep(t.radius * 2.0, t.radius * 3.1, d));
        if (f > farm) farm = f * t.hab;
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
    let roadSurface = SURFACE.NONE;
    for (let i = 0; i < ctx.roads.length; i++) {
      const r = ctx.roads[i];
      const t = segT(r.ax, r.az, r.bx, r.bz, x, z);
      const px = lerp(r.ax, r.bx, t);
      const pz = lerp(r.az, r.bz, t);
      const d = Math.sqrt(dist2(px, pz, x, z));
      const on = 1 - smoothstep(r.w, r.w * 2.4, d);
      if (on > road) {
        road = on;
        roadSurface = r.surface;
        if (on > 0.01) {
          const rh = lerp(r.ah, r.bh, t) + (this.baseHeight(px, pz) - lerp(r.ah, r.bh, t)) * 0.55;
          h = lerp(h, rh, on * 0.85);
        }
      }
    }

    /* -- railways ride a level embankment --------------------------------- */
    let rail = 0;
    for (let i = 0; i < ctx.rails.length; i++) {
      const r = ctx.rails[i];
      const t = segT(r.ax, r.az, r.bx, r.bz, x, z);
      const px = lerp(r.ax, r.bx, t);
      const pz = lerp(r.az, r.bz, t);
      const d = Math.sqrt(dist2(px, pz, x, z));
      const on = 1 - smoothstep(r.w, r.w * 3.4, d);
      if (on > rail) {
        rail = on;
        if (on > 0.01) {
          // Flatter than a road: rails will not climb, so the embankment
          // leans harder on the straight line between the two stations.
          const rh = lerp(r.ah, r.bh, t) + (this.baseHeight(px, pz) - lerp(r.ah, r.bh, t)) * 0.34;
          h = lerp(h, rh + 0.6, on * 0.92);
        }
      }
    }

    /* -- outlying sites level their own small pad ------------------------- */
    let site = 0;
    let siteRef = null;
    for (let i = 0; i < ctx.sites.length; i++) {
      const S = ctx.sites[i];
      if (!S.pad) continue;
      const d = Math.sqrt(dist2(S.x, S.z, x, z));
      const on = 1 - smoothstep(S.radius * 0.55, S.radius * 1.15, d);
      if (on > site) {
        site = on;
        siteRef = S;
      }
    }
    if (site > 0.01 && siteRef) h = lerp(h, siteRef.h, site * 0.9);

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
      const rv = this.river(x, z, baseH, TMPR, sh.moist0);
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
    const temperature = sh.tSea - Math.max(0, h) * 0.0068;
    const moisture = saturate(sh.moist0 + riverStrength * 0.25 + lakeAmt * 0.2);

    out.height = h;
    out.baseHeight = baseH;
    out.waterLevel = waterLevel;
    out.riverStrength = riverStrength;
    out.riverLevel = TMPR.level;
    out.lake = lakeAmt;
    out.continent = cont;
    out.mountain = sh.mountain;
    out.dune = sh.dune;
    out.temperature = temperature;
    out.moisture = moisture;
    out.lf = lf;
    out.town = townInfluence > 0.05 ? townRef : null;
    out.townInfluence = townInfluence;
    out.farm = farm;
    out.road = road;
    out.roadSurface = roadSurface;
    out.rail = rail;
    out.site = site > 0.05 ? siteRef : null;
    out.siteInfluence = site;
    out.biome = this.classify(out);
    return out;
  }

  /**
   * Which country is this? Ordered from the most decisive facts (under water,
   * buried in ice) down to the fine distinctions between grasslands.
   */
  classify(s) {
    const h = s.height;
    const temp = s.temperature;
    const moist = s.moisture;
    const lf = s.lf || ZERO_LF;
    const wl = s.waterLevel;

    // Effective moisture. Cold ground keeps far more of what falls on it, which
    // is why the Sahara and the Kazakh steppe get comparable rainfall and look
    // nothing alike. Each temperature band below then reads `m` against its own
    // thresholds, so "dry" means something different in the tropics than it
    // does in Lapland - which is the whole reason the same two noise fields can
    // produce both a sand sea and a peat bog.
    const m = moist + smoothstep(30, 4, temp) * 0.16;

    /* --- salt water ----------------------------------------------------- */
    if (h < SEA_LEVEL) {
      if (h < -220) return BIOME.DEEP_OCEAN;
      if (h > -26 && temp > 21 && moist > 0.35) return BIOME.REEF;
      if (h > -24 && temp > 3 && temp < 15) return BIOME.KELP;
      return BIOME.OCEAN;
    }

    /* --- what people put here ------------------------------------------- */
    if (s.townInfluence > 0.45 && s.town && s.town.kind >= SETTLEMENT.TOWN) return BIOME.URBAN;
    if (s.farm > 0.35 && temp > 2 && temp < 30) return BIOME.CROPLAND;

    /* --- ice ------------------------------------------------------------- */
    if (temp < -13) return moist > 0.30 ? BIOME.GLACIER : BIOME.POLAR_DESERT;
    if (h > 1550 || (h > 1150 && temp < 2)) return moist > 0.42 ? BIOME.GLACIER : BIOME.SNOW;

    /* --- the strand ------------------------------------------------------ */
    // Land this low is the coast. (The old test asked for waterLevel to be sea
    // level, which by construction it never is on dry ground - so the beach
    // biome never fired at all and palms had nowhere to grow. The sand at the
    // water's edge came from the ground shader, which hid the bug nicely.)
    if (h < 3.0 && s.lake < 0.05 && wl < h + 0.2) {
      if (lf.volc > 0.35) return BIOME.BLACK_SAND;
      if (temp > 21 && m > 0.55) return BIOME.MANGROVE;
      if (temp < -2) return BIOME.SNOW;
      return BIOME.BEACH;
    }

    /* --- volcanic waste --------------------------------------------------- */
    if (lf.volc > 0.30 && moist < 0.80) return BIOME.LAVA_FIELD;

    /* --- bare high ground ------------------------------------------------- */
    if (h > 980) return temp < 0 ? BIOME.SNOW : BIOME.SCREE;
    if (h > 700 && lf.relief > 0.2) {
      if (temp > 13 && m > 0.60) return BIOME.CLOUD_FOREST;
      return BIOME.ALPINE;
    }

    /* --- standing water and the ground beside it -------------------------- */
    // Wetland is about drainage, not rainfall: flat ground that cannot shed
    // what falls on it. Raw moisture is the right measure here.
    if (moist > 0.62 && h < 150 && (s.lake > 0.05 || s.riverStrength > 0.05 || lf.basin > 0.34)) {
      if (temp > 21) return BIOME.SWAMP;
      if (temp > 7) return BIOME.MARSH;
      if (temp > -4) return BIOME.BOG;
    }

    /* --- tropical ---------------------------------------------------------- */
    if (temp > 20) {
      if (m < 0.30) return this._arid(s, lf, temp);
      if (m < 0.48) return BIOME.SAVANNA;
      if (m < 0.66) return lf.karst > 0.35 ? BIOME.KARST : BIOME.DRY_FOREST;
      if (lf.karst > 0.28) return BIOME.KARST;
      if (h > 380) return BIOME.CLOUD_FOREST;
      // Bamboo is a stand inside the jungle, not an alternative to it: it
      // wants broken hill country, and the flat wet basin floor is rainforest.
      if (lf.hill > 0.50 && m < 0.80) return BIOME.BAMBOO;
      return BIOME.RAINFOREST;
    }

    /* --- warm temperate ---------------------------------------------------- */
    if (temp > 12) {
      if (m < 0.28) return this._arid(s, lf, temp);
      if (m < 0.42) return BIOME.SHRUBLAND;
      if (m < 0.56) return lf.mesa > 0.3 ? BIOME.BADLANDS : BIOME.GRASSLAND;
      if (m < 0.70) return lf.hill > 0.45 ? BIOME.MEADOW : BIOME.PRAIRIE;
      if (m > 0.82 && lf.karst > 0.3) return BIOME.KARST;
      return BIOME.FOREST;
    }

    /* --- cool temperate ---------------------------------------------------- */
    if (temp > 4) {
      if (m < 0.24) return this._arid(s, lf, temp);
      if (m < 0.40) return lf.hill > 0.5 ? BIOME.MOOR : BIOME.STEPPE;
      if (m < 0.56) return BIOME.GRASSLAND;
      if (m < 0.72) return lf.hill > 0.45 ? BIOME.MEADOW : BIOME.PRAIRIE;
      return BIOME.FOREST;
    }

    /* --- boreal ------------------------------------------------------------ */
    if (temp > -7) {
      if (m < 0.28) return BIOME.TUNDRA;
      if (m < 0.56) return lf.hill > 0.4 ? BIOME.MOOR : BIOME.TUNDRA;
      return BIOME.TAIGA;
    }

    /* --- polar ------------------------------------------------------------- */
    if (m < 0.34) return BIOME.POLAR_DESERT;
    return m > 0.80 ? BIOME.GLACIER : BIOME.SNOW;
  }

  /**
   * Which flavour of dry country. The landform province decides: a sand sea
   * needs wind and no relief, a salt pan needs a basin with no outlet, a
   * badland needs a plateau to cut into.
   */
  _arid(s, lf, temp) {
    if (s.lake > 0.05 || s.riverStrength > 0.10) return BIOME.OASIS;
    if (s.dune > 0.14) return BIOME.DUNES;
    if (lf.basin > 0.52 && s.height < 90) return BIOME.SALT_FLAT;
    if (lf.mesa > 0.24) return BIOME.BADLANDS;
    // A cold desert is a steppe: bitter, stony and grazed, not a sand sea.
    if (temp < 10) return BIOME.STEPPE;
    if (lf.hill > 0.58 || lf.relief > 0.26) return BIOME.ROCKY_DESERT;
    return BIOME.DESERT;
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

  /**
   * Sea-level air temperature of the region around a point. Feeds the shared
   * snow uniform, so it is asked for a couple of times a second and skips
   * everything the full sample would do.
   */
  seaTemp(x, z) {
    return this._shape(x, z, TMPS, 9).tSea;
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

  /** Every outlying site within `range` of a point. */
  sitesNear(x, z, range = 1400) {
    const out = [];
    const r = Math.ceil(range / SITE_CELL) + 1;
    const i0 = Math.floor(x / SITE_CELL);
    const j0 = Math.floor(z / SITE_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const s = this.siteCell(i0 + i, j0 + j);
        if (s && dist2(s.x, s.z, x, z) < range * range) out.push(s);
      }
    }
    return out;
  }

  /** Every road and railway segment crossing a box around a point. */
  waysNear(x, z, range = 700) {
    const roads = [];
    const rails = [];
    const seen = new Set();
    const step = CTX_TILE;
    const n = Math.ceil(range / step);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const ctx = this.context(x + i * step, z + j * step);
        for (const r of ctx.roads) {
          const k = `r${r.ax | 0},${r.az | 0},${r.bx | 0},${r.bz | 0}`;
          if (seen.has(k)) continue;
          seen.add(k);
          roads.push(r);
        }
        for (const r of ctx.rails) {
          const k = `t${r.ax | 0},${r.az | 0},${r.bx | 0},${r.bz | 0}`;
          if (seen.has(k)) continue;
          seen.add(k);
          rails.push(r);
        }
      }
    }
    return { roads, rails };
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
      if (SPAWN_BIOMES.has(s.biome)) score += 1.6;
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

/**
 * Turn a raw fbm value into an even rank in [0,1].
 *
 * A three-octave fbm is close to gaussian with a standard deviation of about
 * 0.29, so most of its output crowds the middle. Pushing it through the
 * logistic approximation of the normal CDF spreads it out flat, which is what
 * lets the splines below be authored as honest quantiles: "the coldest twelfth
 * of the world" means the coldest twelfth.
 */
function rank(f) {
  // Calibrated for the two-octave fbm the climate fields use, which measures
  // sd 0.332. (A three-octave one is 0.292 - if you change the octave count,
  // re-measure, or the quantiles the splines below promise stop being true.)
  return 1 / (1 + Math.exp(-5.13 * f));
}

// Sea-level temperature by quantile. 8% of the world is polar, 18% boreal,
// 30% cool temperate, 22% warm temperate, 22% tropical. Altitude then takes
// 6.8 °C off every kilometre on top of this.
const TEMP_SPLINE = [
  [0.00, -34], [0.08, -8], [0.26, 4], [0.56, 12], [0.78, 20],
  [0.90, 27], [0.96, 33], [1.00, 44],
];
// Moisture by quantile, 0 bone dry .. 1 saturated. Very nearly flat: the
// aridity correction in `classify` is what turns this into climate.
const MOIST_SPLINE = [
  [0.00, 0.01], [0.10, 0.10], [0.30, 0.28], [0.50, 0.46], [0.70, 0.63],
  [0.88, 0.80], [1.00, 0.99],
];

const LF_KEYS = ['relief', 'hill', 'mesa', 'karst', 'volc', 'frac', 'basin', 'dune'];
const ZERO_LF = { relief: 0, hill: 0, mesa: 0, karst: 0, volc: 0, frac: 0, basin: 0, dune: 0 };

// Ground you could put a light aircraft down on: open, dry-ish and treeless.
// Ice counts - an ice runway is a real thing and a beautiful place to find one.
const AIRSTRIP_GROUND = new Set([
  BIOME.GRASSLAND, BIOME.PRAIRIE, BIOME.MEADOW, BIOME.STEPPE, BIOME.SAVANNA,
  BIOME.CROPLAND, BIOME.SHRUBLAND, BIOME.TUNDRA, BIOME.DESERT, BIOME.ROCKY_DESERT,
  BIOME.SALT_FLAT, BIOME.BADLANDS, BIOME.GLACIER, BIOME.SNOW, BIOME.POLAR_DESERT,
  BIOME.BLACK_SAND, BIOME.MOOR, BIOME.DRY_FOREST,
]);

// Country somebody with a town behind them would clear and grade for a strip.
const CLEARABLE_GROUND = new Set([
  BIOME.FOREST, BIOME.TAIGA, BIOME.DRY_FOREST, BIOME.MEADOW, BIOME.PRAIRIE, BIOME.SHRUBLAND,
]);

const SPAWN_BIOMES = new Set([
  BIOME.FOREST, BIOME.MEADOW, BIOME.GRASSLAND, BIOME.PRAIRIE, BIOME.SHRUBLAND, BIOME.DRY_FOREST,
]);

const TMP2 = [0, 0];
const TMP3 = [0, 0, 0];
const TMPR = { strength: 0, width: 0, level: 0 };
const TMPW = {};
const TMPS = {};
const TMPS2 = {};
const TMPS3 = {};
const QB = {};

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

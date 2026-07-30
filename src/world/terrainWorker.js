// Terrain meshing worker.
//
// Given a chunk rectangle it returns interleaved geometry buffers for the
// ground, the inland water surface (rivers and lakes) and the list of things
// that grow or sit on that ground. All heavy sampling happens here so the
// main thread never stalls while the world streams in.

import { WorldGen, BIOME, BIOME_INFO, SEA_LEVEL } from './worldgen.js';
import { hash3i, hash3f, clamp, lerp, saturate, smoothstep } from '../core/noise.js';

let wg = null;
const DEBUG_SKIRT = false;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    wg = new WorldGen(msg.seed);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'build') {
    try {
      const result = build(msg);
      self.postMessage({ type: 'chunk', id: msg.id, ...result.payload }, result.transfer);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err && err.stack || err) });
    }
  }
};

/* ------------------------------------------------------------------- build */

function build(req) {
  const { x0, z0, size, res, lod, wantWater, wantScatter } = req;
  const step = size / res;
  const gw = res + 3; // one border ring on each side for seamless normals
  const nVerts = (res + 1) * (res + 1);

  // --- sample grid -------------------------------------------------------
  const gh = new Float32Array(gw * gw);
  const gbiome = new Uint8Array(gw * gw);
  const gwater = new Float32Array(gw * gw);
  const gtemp = new Float32Array(gw * gw);
  const gmoist = new Float32Array(gw * gw);
  const griver = new Float32Array(gw * gw);
  const groad = new Float32Array(gw * gw);
  const gtown = new Float32Array(gw * gw);
  const s = {};
  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j < gw; j++) {
    const wz = z0 + (j - 1) * step;
    for (let i = 0; i < gw; i++) {
      const wx = x0 + (i - 1) * step;
      wg.sample(wx, wz, s, lod);
      const k = j * gw + i;
      gh[k] = s.height;
      gbiome[k] = s.biome;
      gwater[k] = s.waterLevel === -Infinity ? -99999 : s.waterLevel;
      gtemp[k] = s.temperature;
      gmoist[k] = s.moisture;
      griver[k] = s.riverStrength;
      groad[k] = s.road;
      gtown[k] = s.townInfluence;
    }
  }

  // --- ground mesh --------------------------------------------------------
  const skirtVerts = (res + 1) * 4;
  const totalVerts = nVerts + skirtVerts;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const aux = new Float32Array(totalVerts * 4); // wetness, slope, sand, snow

  const col = [0, 0, 0];
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const gi = (j + 1) * gw + (i + 1);
      const h = gh[gi];
      const vi = j * (res + 1) + i;
      const wx = x0 + i * step;
      const wz = z0 + j * step;
      positions[vi * 3] = i * step;
      positions[vi * 3 + 1] = h;
      positions[vi * 3 + 2] = j * step;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;

      // central differences on the sample grid keep normals continuous
      // across chunk boundaries and across LOD changes.
      const hl = gh[gi - 1];
      const hr = gh[gi + 1];
      const hd = gh[gi - gw];
      const hu = gh[gi + gw];
      let nx = hl - hr;
      let ny = 2 * step;
      let nz = hd - hu;
      const il = 1 / (Math.hypot(nx, ny, nz) || 1);
      normals[vi * 3] = nx * il;
      normals[vi * 3 + 1] = ny * il;
      normals[vi * 3 + 2] = nz * il;

      const slope = 1 - ny * il;
      groundColor(wx, wz, h, gbiome[gi], gtemp[gi], gmoist[gi], slope, gwater[gi], griver[gi], groad[gi], gtown[gi], col, MATW);
      colors[vi * 3] = col[0];
      colors[vi * 3 + 1] = col[1];
      colors[vi * 3 + 2] = col[2];

      const wl = gwater[gi];
      const wet = wl > -9999 ? saturate((wl - h + 1.2) / 2.4) : saturate(1 - Math.abs(h - SEA_LEVEL) / 1.8) * 0.5;
      aux[vi * 4] = wet;
      aux[vi * 4 + 1] = slope;
      aux[vi * 4 + 2] = MATW[0];
      aux[vi * 4 + 3] = MATW[1];
    }
  }

  // Skirt: a rim of vertices dropped below the edge, hiding LOD seams.
  const skirtDrop = Math.max(2.0, size * 0.05);
  let sv = nVerts;
  const edgeIndex = [];
  for (let i = 0; i <= res; i++) edgeIndex.push(i); // south (j=0)
  for (let j = 0; j <= res; j++) edgeIndex.push(j * (res + 1) + res); // east
  for (let i = res; i >= 0; i--) edgeIndex.push(res * (res + 1) + i); // north
  for (let j = res; j >= 0; j--) edgeIndex.push(j * (res + 1)); // west
  const skirtSrc = new Int32Array(edgeIndex.length);
  for (let k = 0; k < edgeIndex.length; k++) {
    const src = edgeIndex[k];
    skirtSrc[k] = src;
    positions[sv * 3] = positions[src * 3];
    positions[sv * 3 + 1] = positions[src * 3 + 1] - skirtDrop;
    positions[sv * 3 + 2] = positions[src * 3 + 2];
    normals[sv * 3] = normals[src * 3];
    normals[sv * 3 + 1] = normals[src * 3 + 1];
    normals[sv * 3 + 2] = normals[src * 3 + 2];
    colors[sv * 3] = DEBUG_SKIRT ? 1 : colors[src * 3] * 0.8;
    colors[sv * 3 + 1] = DEBUG_SKIRT ? 0 : colors[src * 3 + 1] * 0.8;
    colors[sv * 3 + 2] = DEBUG_SKIRT ? 0 : colors[src * 3 + 2] * 0.8;
    aux[sv * 4] = aux[src * 4];
    aux[sv * 4 + 1] = aux[src * 4 + 1];
    aux[sv * 4 + 2] = aux[src * 4 + 2];
    aux[sv * 4 + 3] = aux[src * 4 + 3];
    sv++;
  }

  const quadCount = res * res;
  const skirtQuads = edgeIndex.length - 1;
  const IndexArray = totalVerts > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(quadCount * 6 + skirtQuads * 6);
  let t = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * (res + 1) + i;
      const b = a + 1;
      const c = a + (res + 1);
      const d = c + 1;
      // Split each quad along its shorter diagonal for smoother silhouettes.
      if (Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]) < Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1])) {
        indices[t++] = a; indices[t++] = c; indices[t++] = d;
        indices[t++] = a; indices[t++] = d; indices[t++] = b;
      } else {
        indices[t++] = a; indices[t++] = c; indices[t++] = b;
        indices[t++] = b; indices[t++] = c; indices[t++] = d;
      }
    }
  }
  for (let k = 0; k < skirtQuads; k++) {
    const a = skirtSrc[k];
    const b = skirtSrc[k + 1];
    const c = nVerts + k;
    const d = nVerts + k + 1;
    indices[t++] = a; indices[t++] = c; indices[t++] = d;
    indices[t++] = a; indices[t++] = d; indices[t++] = b;
  }

  const payload = {
    x0, z0, size, res, lod,
    positions, normals, colors, aux, indices,
    minY, maxY,
    heights: gh, hgw: gw,
  };
  const transfer = [positions.buffer, normals.buffer, colors.buffer, aux.buffer, indices.buffer, gh.buffer];

  // --- inland water surface ----------------------------------------------
  if (wantWater) {
    const water = buildWater(x0, z0, size, res, step, gw, gh, gwater, griver);
    if (water) {
      payload.water = water;
      transfer.push(water.positions.buffer, water.flow.buffer, water.depth.buffer, water.indices.buffer);
    }
  }

  // --- things that live on the ground -------------------------------------
  if (wantScatter) {
    const sc = scatter(x0, z0, size, gw, step, gh, gbiome, gwater, gtemp, gmoist, groad, gtown, griver);
    payload.scatter = sc;
    for (const key of ['plants', 'rocks', 'grass']) {
      if (sc[key]) transfer.push(sc[key].buffer);
    }
  }

  return { payload, transfer };
}

/* ------------------------------------------------------------ ground colour */

const TMPC = [0, 0, 0];
const MATW = [0, 0]; // sand, snow weights for the texture splat

function groundColor(x, z, h, biome, temp, moist, slope, waterLevel, river, road, town, out, matw) {
  if (matw) {
    // Sand covers deserts and beaches outright; shorelines add it below.
    matw[0] = (biome === BIOME.DESERT || biome === BIOME.BEACH) ? 1 - smoothstep(0.30, 0.60, slope) : 0;
    matw[1] = 0;
  }
  const info = BIOME_INFO[biome];
  // Two-tone base with a large-scale patchiness so ground is never flat.
  const v = hashNoise(x * 0.021, z * 0.021) * 0.5 + hashNoise(x * 0.0043, z * 0.0043) * 0.5;
  let r = lerp(info.col[0], info.col2[0], v);
  let g = lerp(info.col[1], info.col2[1], v);
  let b = lerp(info.col[2], info.col2[2], v);

  // Fine mottling.
  const m = 0.90 + hashNoise(x * 0.55, z * 0.55) * 0.20;
  r *= m; g *= m; b *= m;

  // Steep ground shows rock.
  const rock = smoothstep(0.42, 0.80, slope);
  if (rock > 0) {
    const rv = 0.115 + hashNoise(x * 0.09, z * 0.09) * 0.075;
    r = lerp(r, rv * 1.06, rock);
    g = lerp(g, rv * 1.0, rock);
    b = lerp(b, rv * 0.94, rock);
  }

  // Snow settles on cold, flat, high ground.
  const snowLine = smoothstep(2.0, -4.0, temp);
  const snow = snowLine * (1 - smoothstep(0.35, 0.75, slope));
  if (matw) matw[1] = snow;
  if (snow > 0.01) {
    r = lerp(r, 0.70, snow);
    g = lerp(g, 0.74, snow);
    b = lerp(b, 0.82, snow);
  }

  // Sand at the water's edge, silt under it.
  if (waterLevel > -9999) {
    const d = waterLevel - h;
    if (d > -1.6) {
      const shore = saturate(1 - Math.abs(d) / 2.2);
      if (matw) matw[0] = Math.max(matw[0], shore);
      r = lerp(r, 0.300, shore * 0.6);
      g = lerp(g, 0.262, shore * 0.6);
      b = lerp(b, 0.185, shore * 0.6);
      // Everything underwater darkens with depth.
      const sub = saturate(d / 14);
      r = lerp(r, r * 0.40, sub);
      g = lerp(g, g * 0.52, sub);
      b = lerp(b, b * 0.64, sub);
    }
  }

  // River beds are gravel.
  if (river > 0.15) {
    const k = smoothstep(0.15, 0.6, river) * 0.55;
    const gv = 0.145 + hashNoise(x * 0.3, z * 0.3) * 0.085;
    r = lerp(r, gv, k); g = lerp(g, gv * 0.97, k); b = lerp(b, gv * 0.88, k);
  }

  // Roads and town ground: paving, then asphalt.
  if (town > 0.02) {
    const k = smoothstep(0.02, 0.55, town) * 0.6;
    const pv = 0.098 + hashNoise(x * 0.14, z * 0.14) * 0.042;
    r = lerp(r, pv * 1.04, k); g = lerp(g, pv, k); b = lerp(b, pv * 0.95, k);
  }
  if (road > 0.02) {
    const k = smoothstep(0.05, 0.5, road);
    const av = 0.048 + hashNoise(x * 0.5, z * 0.5) * 0.016;
    r = lerp(r, av, k); g = lerp(g, av, k); b = lerp(b, av * 1.08, k);
  }

  out[0] = clamp(r, 0, 1);
  out[1] = clamp(g, 0, 1);
  out[2] = clamp(b, 0, 1);
  return out;
}

// Cheap deterministic smooth noise for colour variation only.
function hashNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash3f(xi, yi, 7),
    b = hash3f(xi + 1, yi, 7),
    c = hash3f(xi, yi + 1, 7),
    d = hash3f(xi + 1, yi + 1, 7);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/* -------------------------------------------------------------- water mesh */

function buildWater(x0, z0, size, res, step, gw, gh, gwater, griver) {
  // Water is emitted per cell wherever the surface sits above the ground.
  const wet = new Uint8Array((res + 1) * (res + 1));
  let any = false;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const gi = (j + 1) * gw + (i + 1);
      if (gwater[gi] > -9000 && gh[gi] < gwater[gi] + 0.35) {
        wet[j * (res + 1) + i] = 1;
        any = true;
      }
    }
  }
  if (!any) return null;

  const map = new Int32Array((res + 1) * (res + 1)).fill(-1);
  const pos = [];
  const flow = [];
  const dep = [];
  let n = 0;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const vi = j * (res + 1) + i;
      // include a one-cell rim so the surface tucks under the bank
      let near = wet[vi] === 1;
      if (!near) {
        for (let dj = -1; dj <= 1 && !near; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj, ii = i + di;
            if (jj < 0 || ii < 0 || jj > res || ii > res) continue;
            if (wet[jj * (res + 1) + ii]) { near = true; break; }
          }
        }
      }
      if (!near) continue;
      const gi = (j + 1) * gw + (i + 1);
      let level = gwater[gi];
      if (level < SEA_LEVEL - 9000) {
        // rim vertex with no water of its own: borrow the neighbours' level
        let best = -99999;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const k = (j + dj + 1) * gw + (i + di + 1);
            if (k >= 0 && k < gwater.length && gwater[k] > best) best = gwater[k];
          }
        }
        level = best;
        if (level < SEA_LEVEL - 9000) continue;
      }
      map[vi] = n++;
      pos.push(i * step, level, j * step);
      const wx = x0 + i * step;
      const wz = z0 + j * step;
      const riv = griver[gi];
      if (riv > 0.02) {
        const fd = wg.flowDir(wx, wz, TMPF);
        const speed = clamp(0.25 + riv * 1.4, 0, 2);
        flow.push(fd[0] * speed, fd[1] * speed);
      } else {
        flow.push(0, 0);
      }
      dep.push(Math.max(0, level - gh[gi]));
    }
  }
  if (n < 3) return null;

  const idx = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = map[j * (res + 1) + i];
      const b = map[j * (res + 1) + i + 1];
      const c = map[(j + 1) * (res + 1) + i];
      const d = map[(j + 1) * (res + 1) + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // skip cells that are entirely dry land
      const gi = (j + 1) * gw + (i + 1);
      if (gh[gi] > gwater[gi] + 1.0 && gwater[gi] > -9000) continue;
      idx.push(a, c, d, a, d, b);
    }
  }
  if (!idx.length) return null;
  return {
    positions: new Float32Array(pos),
    flow: new Float32Array(flow),
    depth: new Float32Array(dep),
    indices: new Uint32Array(idx),
    count: n,
  };
}

const TMPF = [0, 0];

/* ----------------------------------------------------------------- scatter */

// Plant record layout (floats): x, y, z, species, scale, rotation, ageSeed,
// health, id-hash.
export const PLANT_STRIDE = 9;
export const ROCK_STRIDE = 8; // x,y,z,scale,rotX,rotY,rotZ,kind
export const GRASS_STRIDE = 6; // x,y,z,scale,rot,type

const SPECIES = {
  OAK: 0, PINE: 1, BIRCH: 2, PALM: 3, ACACIA: 4, CACTUS: 5, WILLOW: 6, SNAG: 7, JUNGLE: 8, SPRUCE: 9,
  BUSH: 10, FERN: 11, SAPLING: 12,
};

function speciesFor(biome, r) {
  switch (biome) {
    case BIOME.FOREST: return r < 0.42 ? SPECIES.OAK : r < 0.68 ? SPECIES.BIRCH : r < 0.88 ? SPECIES.PINE : SPECIES.SNAG;
    case BIOME.RAINFOREST: return r < 0.62 ? SPECIES.JUNGLE : r < 0.85 ? SPECIES.OAK : SPECIES.FERN;
    case BIOME.TAIGA: return r < 0.55 ? SPECIES.SPRUCE : r < 0.9 ? SPECIES.PINE : SPECIES.SNAG;
    case BIOME.TUNDRA: return r < 0.5 ? SPECIES.BUSH : SPECIES.SNAG;
    case BIOME.SNOW: return r < 0.7 ? SPECIES.SPRUCE : SPECIES.SNAG;
    case BIOME.DESERT: return r < 0.75 ? SPECIES.CACTUS : SPECIES.BUSH;
    case BIOME.SAVANNA: return r < 0.7 ? SPECIES.ACACIA : SPECIES.BUSH;
    case BIOME.SWAMP: return r < 0.55 ? SPECIES.WILLOW : r < 0.8 ? SPECIES.FERN : SPECIES.SNAG;
    case BIOME.BEACH: return SPECIES.PALM;
    case BIOME.REEF: return SPECIES.FERN;
    case BIOME.MEADOW: return r < 0.45 ? SPECIES.OAK : r < 0.7 ? SPECIES.BIRCH : SPECIES.BUSH;
    case BIOME.ALPINE: return r < 0.6 ? SPECIES.SPRUCE : SPECIES.BUSH;
    case BIOME.GRASSLAND: return r < 0.5 ? SPECIES.OAK : r < 0.75 ? SPECIES.BUSH : SPECIES.BIRCH;
    default: return SPECIES.BUSH;
  }
}

function scatter(x0, z0, size, gw, step, gh, gbiome, gwater, gtemp, gmoist, groad, gtown, griver) {
  const plants = [];
  const rocks = [];
  const grass = [];
  const res = gw - 3;

  const gridAt = (lx, lz) => {
    const i = clamp(Math.round(lx / step), 0, res) + 1;
    const j = clamp(Math.round(lz / step), 0, res) + 1;
    return j * gw + i;
  };

  // Plants and rocks: a jittered lattice keeps placement deterministic and
  // even, while the hash makes it look organic.
  const cell = 4.0;
  const nc = Math.ceil(size / cell);
  const ci0 = Math.floor(x0 / cell);
  const cj0 = Math.floor(z0 / cell);
  for (let j = 0; j < nc; j++) {
    for (let i = 0; i < nc; i++) {
      const ci = ci0 + i;
      const cj = cj0 + j;
      const h1 = hash3i(ci, cj, 0x51ed);
      const px = (ci + ((h1 & 1023) / 1023) * 0.94 + 0.03) * cell;
      const pz = (cj + (((h1 >>> 10) & 1023) / 1023) * 0.94 + 0.03) * cell;
      const lx = px - x0;
      const lz = pz - z0;
      if (lx < 0 || lz < 0 || lx >= size || lz >= size) continue;
      const gi = gridAt(lx, lz);
      const h = gh[gi];
      const wl = gwater[gi];
      const biome = gbiome[gi];
      const info = BIOME_INFO[biome];
      const r1 = ((h1 >>> 20) & 4095) / 4095;

      const underwater = wl > h + 0.15;
      const slopeOk = true;
      const built = gtown[gi] > 0.25 || groad[gi] > 0.12;

      // trees
      const density = info.trees * (0.55 + gmoist[gi] * 0.9);
      if (!underwater && !built && slopeOk && r1 < density * cell * cell * 0.0082) {
        const r2 = hash3f(ci, cj, 0x77aa);
        const sp = speciesFor(biome, r2);
        const r3 = hash3f(ci, cj, 0x1188);
        const r4 = hash3f(ci, cj, 0x9911);
        plants.push(
          px, h, pz,
          sp,
          0.7 + r3 * 0.7,
          r4 * 6.2831853,
          hash3f(ci, cj, 0x4321), // age seed
          1.0, // health
          hash3i(ci, cj, 0xaced) >>> 0
        );
      } else if (!built && r1 > 1 - info.rocks * cell * cell * 0.0032) {
        const r2 = hash3f(ci, cj, 0x2299);
        const r3 = hash3f(ci, cj, 0x3377);
        rocks.push(
          px, h, pz,
          0.35 + r2 * r2 * 3.0,
          hash3f(ci, cj, 0x1) * 0.7,
          r3 * 6.2831853,
          hash3f(ci, cj, 0x2) * 0.7,
          underwater ? 1 : 0
        );
      }
    }
  }

  // Grass tufts and flowers: much denser, only on the nearest chunks.
  if (size <= 160) {
    const gcell = 1.45;
    const gn = Math.ceil(size / gcell);
    const gi0 = Math.floor(x0 / gcell);
    const gj0 = Math.floor(z0 / gcell);
    for (let j = 0; j < gn; j++) {
      for (let i = 0; i < gn; i++) {
        const ci = gi0 + i;
        const cj = gj0 + j;
        const hh = hash3i(ci, cj, 0x77e1);
        const px = (ci + ((hh & 511) / 511) * 0.9 + 0.05) * gcell;
        const pz = (cj + (((hh >>> 9) & 511) / 511) * 0.9 + 0.05) * gcell;
        const lx = px - x0;
        const lz = pz - z0;
        if (lx < 0 || lz < 0 || lx >= size || lz >= size) continue;
        const g = gridAt(lx, lz);
        const h = gh[g];
        if (gwater[g] > h + 0.05) continue;
        if (gtown[g] > 0.4 || groad[g] > 0.2) continue;
        const info = BIOME_INFO[gbiome[g]];
        const dens = info.grass * (0.6 + gmoist[g] * 0.7);
        const r = ((hh >>> 18) & 2047) / 2047;
        // Cap the pass rate: a wet meadow's density (1.4 * 1.3) used to pass
        // every cell - nearly 8000 tufts per chunk - which exhausted the
        // whole instance pool on a handful of chunks and left the rest bald.
        if (r > Math.min(dens * 0.62, 0.5)) continue;
        const isFlower = hash3f(ci, cj, 0x5) < info.flowers * 0.07;
        grass.push(
          px, h, pz,
          0.55 + hash3f(ci, cj, 0x6) * 0.65,
          hash3f(ci, cj, 0x7) * 6.2831853,
          isFlower ? 1 + Math.floor(hash3f(ci, cj, 0x8) * 3) : 0
        );
      }
    }
  }

  return {
    plants: new Float32Array(plants),
    rocks: new Float32Array(rocks),
    grass: new Float32Array(grass),
  };
}

export { SPECIES };

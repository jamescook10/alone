// Terrain meshing worker.
//
// Given a chunk rectangle it returns interleaved geometry buffers for the
// ground, the inland water surface (rivers and lakes) and the list of things
// that grow or sit on that ground. All heavy sampling happens here so the
// main thread never stalls while the world streams in.

import { WorldGen, BIOME, BIOME_INFO, SEA_LEVEL, SURFACE, speciesFor, SPECIES, s2l } from './worldgen.js';
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
  if (msg.type === 'horizon') {
    try {
      const result = buildHorizon(msg);
      self.postMessage({ type: 'horizon', ...result.payload }, result.transfer);
    } catch (err) {
      self.postMessage({ type: 'error', id: 'horizon', message: String(err && err.stack || err) });
    }
  }
};

/* ----------------------------------------------------------------- horizon */

/**
 * The landscape beyond the streamed quadtree, as a single silhouette ring.
 *
 * A polar annulus of quickSample()d heights: no rivers, no settlements, no
 * scatter - at fifteen kilometres a mountain range is a shape in the haze and
 * that is all it needs to be. One draw call, a few thousand triangles, and it
 * shares the terrain material so the atmosphere can never split at the seam.
 */
function buildHorizon(req) {
  const { cx, cz, rIn, rOut, azi, rings } = req;
  const nVerts = azi * rings;
  const positions = new Float32Array(nVerts * 3);
  const normals = new Float32Array(nVerts * 3);
  const colors = new Float32Array(nVerts * 3);
  const aux = new Float32Array(nVerts * 4);
  const s = {};

  // Log-spaced rings: fine where the silhouette meets the real terrain,
  // coarse out where a whole fell is a couple of pixels.
  const radii = new Float64Array(rings);
  for (let k = 0; k < rings; k++) {
    radii[k] = rIn * Math.pow(rOut / rIn, k / (rings - 1));
  }

  const heights = new Float32Array(nVerts);
  const temps = new Float32Array(nVerts);
  const moists = new Float32Array(nVerts);
  const biomes = new Uint8Array(nVerts);
  for (let k = 0; k < rings; k++) {
    const r = radii[k];
    for (let i = 0; i < azi; i++) {
      const a = (i / azi) * Math.PI * 2;
      wg.quickSample(cx + Math.cos(a) * r, cz + Math.sin(a) * r, s);
      const v = k * azi + i;
      heights[v] = s.height;
      temps[v] = s.temperature;
      moists[v] = s.moisture;
      biomes[v] = s.biome;
    }
  }

  for (let k = 0; k < rings; k++) {
    const r = radii[k];
    const rd = radii[Math.min(k + 1, rings - 1)] - radii[Math.max(k - 1, 0)];
    for (let i = 0; i < azi; i++) {
      const v = k * azi + i;
      const a = (i / azi) * Math.PI * 2;
      const h = heights[v];
      // Anything under the sea ducks below the horizon plate, and the wall
      // this drops at the coastline reads as the coast from this far away.
      const sea = h < SEA_LEVEL + 0.5;
      // Earth curvature: r²/2R sinks far ranges below the horizon the way
      // they really do - and, at the inner edge, it guarantees the real
      // streamed terrain wins wherever the two briefly overlap.
      const drop = (r * r) / (2 * 6371000);
      positions[v * 3] = Math.cos(a) * r;
      positions[v * 3 + 1] = (sea ? -8 : h) - drop;
      positions[v * 3 + 2] = Math.sin(a) * r;

      // Slope from the polar neighbours, for the rock band and the snow line.
      const iN = k * azi + (i + 1) % azi;
      const iP = k * azi + (i - 1 + azi) % azi;
      const kN = Math.min(k + 1, rings - 1) * azi + i;
      const kP = Math.max(k - 1, 0) * azi + i;
      const da = (Math.PI * 2 / azi) * r * 2;
      const gx = (heights[iN] - heights[iP]) / da;
      const gz = (heights[kN] - heights[kP]) / Math.max(rd, 1);
      const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      const slope = 1 - ny;
      normals[v * 3] = 0;
      normals[v * 3 + 1] = 1;
      normals[v * 3 + 2] = 0;

      const info = BIOME_INFO[biomes[v]];
      let cr, cg, cb;
      if (sea) {
        // Hidden under the sea plate; dark silt in case a sliver ever shows.
        cr = 0.01; cg = 0.025; cb = 0.035;
      } else {
        cr = (info.col[0] + info.col2[0]) * 0.5;
        cg = (info.col[1] + info.col2[1]) * 0.5;
        cb = (info.col[2] + info.col2[2]) * 0.5;
        // The same painted canopy the streamed chunks wear, on the same
        // channel, so a forested range does not change colour at the seam.
        const canopy = canopyCover(
          cx + Math.cos(a) * r, cz + Math.sin(a) * r, info, moists[v]);
        aux[v * 4 + 2] = canopy;
        const rockCol = info.rock || ROCK_COL;
        const rock = smoothstep(0.46, 0.60, slope);
        cr = lerp(cr, rockCol[0], rock);
        cg = lerp(cg, rockCol[1], rock);
        cb = lerp(cb, rockCol[2], rock);
        // Same snow rule as the near ground, so the snow line carries on
        // across the seam instead of stopping at fifteen kilometres.
        const snow = smoothstep(4.0, -3.0, temps[v])
          * (1 - smoothstep(0.35, 0.75, slope)) * (1 - canopy * 0.6);
        cr = lerp(cr, SNOW_COL[0], snow);
        cg = lerp(cg, SNOW_COL[1], snow);
        cb = lerp(cb, SNOW_COL[2], snow);
        aux[v * 4 + 3] = snow;
      }
      colors[v * 3] = cr;
      colors[v * 3 + 1] = cg;
      colors[v * 3 + 2] = cb;
      aux[v * 4 + 1] = slope;
    }
  }

  const indices = new Uint32Array((rings - 1) * azi * 6);
  let t = 0;
  for (let k = 0; k < rings - 1; k++) {
    for (let i = 0; i < azi; i++) {
      const a = k * azi + i;
      const c = k * azi + (i + 1) % azi;
      const d = (k + 1) * azi + (i + 1) % azi;
      const b = (k + 1) * azi + i;
      indices[t++] = a; indices[t++] = c; indices[t++] = d;
      indices[t++] = a; indices[t++] = d; indices[t++] = b;
    }
  }

  return {
    payload: { cx, cz, positions, normals, colors, aux, indices },
    transfer: [positions.buffer, normals.buffer, colors.buffer, aux.buffer, indices.buffer],
  };
}

/* ------------------------------------------------------------------- build */

function build(req) {
  const { x0, z0, size, res, lod, wantWater, wantScatter } = req;
  const keep = req.keep !== undefined ? req.keep : 1;
  const wantGround = req.wantGround !== false;
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
  const gsurf = new Uint8Array(gw * gw);
  const gtown = new Float32Array(gw * gw);
  const grail = new Float32Array(gw * gw);
  const gfarm = new Float32Array(gw * gw);
  const gsite = new Float32Array(gw * gw);
  const gdune = new Float32Array(gw * gw);
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
      gsurf[k] = s.roadSurface;
      gtown[k] = s.townInfluence;
      grail[k] = s.rail;
      gfarm[k] = s.farm;
      gsite[k] = s.siteInfluence;
      gdune[k] = s.dune;
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
      GC.x = wx; GC.z = wz; GC.h = h; GC.biome = gbiome[gi];
      GC.temp = gtemp[gi]; GC.moist = gmoist[gi]; GC.slope = slope;
      GC.water = gwater[gi]; GC.river = griver[gi];
      GC.road = groad[gi]; GC.surface = gsurf[gi]; GC.town = gtown[gi];
      GC.rail = grail[gi]; GC.farm = gfarm[gi]; GC.dune = gdune[gi];
      groundColor(GC, col, MATW);
      colors[vi * 3] = col[0];
      colors[vi * 3 + 1] = col[1];
      colors[vi * 3 + 2] = col[2];

      const wl = gwater[gi];
      const wet = wl > -9999 ? saturate((wl - h + 1.2) / 2.4) : saturate(1 - Math.abs(h - SEA_LEVEL) / 1.8) * 0.5;
      aux[vi * 4] = wet;
      aux[vi * 4 + 1] = slope;
      // z carries the painted canopy cover. The old sand/snow splat weights
      // that used to live in z and w died with the texture set; nothing has
      // read them since, and the canopy needs somewhere to ride.
      aux[vi * 4 + 2] = canopyCover(wx, wz, BIOME_INFO[gbiome[gi]], gmoist[gi]);
      aux[vi * 4 + 3] = MATW[0];
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
    const sc = scatter(x0, z0, size, gw, step, gh, gbiome, gwater, gtemp, gmoist, groad, gtown, griver, grail, gsite, gfarm, keep, wantGround);
    payload.scatter = sc;
    for (const key of ['plants', 'rocks', 'grass']) {
      if (sc[key]) transfer.push(sc[key].buffer);
    }
  }

  return { payload, transfer };
}

/* ------------------------------------------------------------ ground colour */

// Snow weight, handed back out for the aux channel the shader reads. The sand
// weight that used to sit beside it went with the texture splat.
const MATW = [0];
// One reused argument bag: this runs once per terrain vertex and a fourteen
// argument call signature was already unreadable before the railways arrived.
const GC = {
  x: 0, z: 0, h: 0, biome: 0, temp: 0, moist: 0, slope: 0, water: 0,
  river: 0, road: 0, surface: 0, town: 0, rail: 0, farm: 0, dune: 0,
};

/**
 * How much canopy covers this point, 0..1 - the painted stand-in for trees too
 * far away to instance. Baked per vertex on every chunk and on the horizon
 * ring, and blended in by camera distance in the fragment shader.
 *
 * This is the SMOOTH field only. The mottle that breaks a wood into stands and
 * clearings deliberately does not live here: its wavelengths are 222 m and
 * 111 m, and the vertex spacing that samples it runs from 4 m on a near chunk
 * to 43 m at lod 3 and 368 m on the horizon ring, so baking it averages it
 * away to a flat tone exactly where it is needed. Measured, the baked version
 * delivered a mean of -21/255 green with a spatial deviation of only 5, which
 * does not read as forest - it just flattens the distance, cutting frame
 * contrast from 15.7 to 12.2. The structure is generated per *pixel* in the
 * fragment shader instead, where vertex spacing cannot touch it.
 */
function canopyCover(x, z, info, moist) {
  const d = density(info, moist);
  if (d <= 0.05) return 0;
  return Math.min(0.72, d * 0.55);
}

/** The stand-and-clearing mottle, mirrored in the terrain fragment shader. */
function canopyMottle(x, z) {
  return hashNoise(x * 0.0045, z * 0.0045) * 0.7 + hashNoise(x * 0.009, z * 0.009) * 0.3;
}

// Flat-look overlays, authored in sRGB pastels and converted once. Biomes may
// override the rock and the sand - red rock in badlands, black sand under a
// volcano - via BIOME_INFO.
const ROCK_COL = [s2l(0.60), s2l(0.58), s2l(0.65)]; // soft lilac-grey
const SNOW_COL = [s2l(0.93), s2l(0.95), s2l(0.97)];
const SAND_COL = [s2l(0.89), s2l(0.79), s2l(0.57)];
const GRAVEL_COL = [s2l(0.64), s2l(0.60), s2l(0.58)];
const PAVE_COL = [s2l(0.60), s2l(0.57), s2l(0.55)];
// Road surfaces. Which one you get is decided by the oracle from what the
// settlements at each end could justify and what the country will carry, so a
// dirt track through the jungle never turns into tarmac.
const SURFACE_COL = [
  null,
  [s2l(0.52), s2l(0.42), s2l(0.30)], // dirt: pale rutted earth
  [s2l(0.58), s2l(0.56), s2l(0.52)], // gravel: grey chippings
  [s2l(0.34), s2l(0.34), s2l(0.37)], // tarmac
];
const BALLAST_COL = [s2l(0.46), s2l(0.44), s2l(0.42)];
const FURROW_COL = [s2l(0.44), s2l(0.35), s2l(0.24)];

function groundColor(c, out, matw) {
  const { x, z, h, biome, temp, slope } = c;
  const info = BIOME_INFO[biome];

  if (matw) matw[0] = 0;

  // Two-tone base quantised to three flat steps: large clean patches of
  // colour instead of continuous mottle - the flat-illustration look.
  const vRaw = hashNoise(x * 0.021, z * 0.021) * 0.5 + hashNoise(x * 0.0043, z * 0.0043) * 0.5;
  const v = Math.min(2, Math.floor(vRaw * 3)) * 0.5;
  let r = lerp(info.col[0], info.col2[0], v);
  let g = lerp(info.col[1], info.col2[1], v);
  let b = lerp(info.col[2], info.col2[2], v);

  // Dune crests catch the light and their flanks fall into shadow, which is
  // most of what makes a sand sea read as a sand sea from a distance.
  if (c.dune > 0.02) {
    const k = c.dune * 0.35 * (0.5 + hashNoise(x * 0.004, z * 0.0007));
    r += k * 0.10; g += k * 0.085; b += k * 0.05;
  }

  // The canopy colour itself is applied in the shader, where it can fade with
  // camera distance and carry its own structure. Here the mottle is still
  // wanted, because damping the snow lerp per vertex is what keeps a snowy
  // taiga stippled dark the way real conifer country looks from the air.
  const cover = canopyCover(x, z, info, c.moist);
  const canopy = cover * smoothstep(0.15, 0.6, canopyMottle(x, z) + cover * 0.364);

  // Steep ground shows rock, over a narrow band so the edge stays clean.
  const rockCol = info.rock || ROCK_COL;
  const rock = smoothstep(0.46, 0.60, slope);
  if (rock > 0) {
    const rv = 0.90 + hashNoise(x * 0.09, z * 0.09) * 0.2;
    r = lerp(r, rockCol[0] * rv, rock);
    g = lerp(g, rockCol[1] * rv, rock);
    b = lerp(b, rockCol[2] * rv, rock);
  }

  // Snow settles on cold, flat, high ground. This is the same rule the shared
  // atmosphere runs for trees, rocks and buildings, so a snowy hillside now
  // carries snowy trees and snowy roofs instead of green ones.
  const snowLine = smoothstep(4.0, -3.0, temp);
  const snow = snowLine * (1 - smoothstep(0.35, 0.75, slope)) * (1 - canopy * 0.6);
  if (matw) matw[0] = snow;
  if (snow > 0.01) {
    r = lerp(r, SNOW_COL[0], snow);
    g = lerp(g, SNOW_COL[1], snow);
    b = lerp(b, SNOW_COL[2], snow);
  }

  // Sand at the water's edge, silt under it.
  if (c.water > -9999) {
    const d = c.water - h;
    if (d > -1.6) {
      const sandCol = info.sand || SAND_COL;
      const shore = smoothstep(0.25, 0.75, saturate(1 - Math.abs(d) / 2.2));
      r = lerp(r, sandCol[0], shore * 0.8);
      g = lerp(g, sandCol[1], shore * 0.8);
      b = lerp(b, sandCol[2], shore * 0.8);
      // Everything underwater darkens with depth.
      const sub = saturate(d / 14);
      r = lerp(r, r * 0.40, sub);
      g = lerp(g, g * 0.52, sub);
      b = lerp(b, b * 0.64, sub);
    }
  }

  // River beds are gravel.
  if (c.river > 0.15) {
    const k = smoothstep(0.15, 0.6, c.river) * 0.55;
    const gv = 0.9 + hashNoise(x * 0.3, z * 0.3) * 0.2;
    r = lerp(r, GRAVEL_COL[0] * gv, k); g = lerp(g, GRAVEL_COL[1] * gv, k); b = lerp(b, GRAVEL_COL[2] * gv, k);
  }

  // Ploughed ground outside a settlement: parallel furrows, angled off the
  // compass so fields do not all line up with the chunk grid.
  if (c.farm > 0.05) {
    const fx = x * 0.9063 + z * 0.4226;
    const stripe = 0.5 + 0.5 * Math.sin(fx * 0.42 + hashNoise(x * 0.004, z * 0.004) * 6.0);
    const k = smoothstep(0.05, 0.45, c.farm) * (0.25 + stripe * 0.35);
    r = lerp(r, FURROW_COL[0], k); g = lerp(g, FURROW_COL[1], k); b = lerp(b, FURROW_COL[2], k);
  }

  // Town ground is paved; a road on top of it is whatever people could lay.
  if (c.town > 0.02) {
    const k = smoothstep(0.02, 0.55, c.town) * 0.6;
    r = lerp(r, PAVE_COL[0], k); g = lerp(g, PAVE_COL[1], k); b = lerp(b, PAVE_COL[2], k);
  }
  if (c.rail > 0.02) {
    const k = smoothstep(0.05, 0.5, c.rail) * 0.85;
    const gv = 0.88 + hashNoise(x * 0.5, z * 0.5) * 0.24;
    r = lerp(r, BALLAST_COL[0] * gv, k); g = lerp(g, BALLAST_COL[1] * gv, k); b = lerp(b, BALLAST_COL[2] * gv, k);
  }
  if (c.road > 0.02) {
    const sc = SURFACE_COL[c.surface] || SURFACE_COL[1];
    const k = smoothstep(0.05, 0.5, c.road) * (c.surface === SURFACE.TARMAC ? 1 : 0.82);
    // An unsealed road is never one flat colour - it is ruts and dust.
    const gv = c.surface === SURFACE.TARMAC ? 1 : 0.85 + hashNoise(x * 0.22, z * 0.22) * 0.32;
    r = lerp(r, sc[0] * gv, k); g = lerp(g, sc[1] * gv, k); b = lerp(b, sc[2] * gv, k);
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
// health, id-hash, rank.
export const PLANT_STRIDE = 10;
export const ROCK_STRIDE = 8; // x,y,z,scale,rotX,rotY,rotZ,biome
export const GRASS_STRIDE = 7; // x,y,z,scale,rot,type,biome

// The densest tree and rock biomes, used to reject a lattice cell before it
// costs a single grid read. Bamboo at 1.5 and scree at 1.4 set these; nothing
// can pass the admission test above the tree bound or below the rock one, and
// a 512 m chunk is 16 384 cells, so this is what pays for scattering that far.
const MAX_TREES = Math.max(...BIOME_INFO.map((b) => b.trees || 0));
const MAX_ROCKS = Math.max(...BIOME_INFO.map((b) => b.rocks || 0));

/** Trees per lattice cell, before the rank cut. Shared with canopyCover. */
const density = (info, moist) => info.trees * (0.55 + moist * 0.9);

// Species selection lives in biomes.js as a per-biome mix table, so the oracle,
// the scatter and the geometry builders can never disagree about what grows
// where. This module just rolls the dice.

/**
 * @param keep fraction of trees to admit, by rank. Coarse chunks take a
 *   *subset* of what the fine ones take - never a different set. See below.
 * @param wantGround rocks and grass, which only the near tiers ever show.
 */
function scatter(x0, z0, size, gw, step, gh, gbiome, gwater, gtemp, gmoist, groad, gtown, griver, grail, gsite, gfarm, keep = 1, wantGround = true) {
  const plants = [];
  const rocks = [];
  const grass = [];
  const res = gw - 3;

  const gridAt = (lx, lz) => {
    const i = clamp(Math.round(lx / step), 0, res) + 1;
    const j = clamp(Math.round(lz / step), 0, res) + 1;
    return j * gw + i;
  };

  // The density inputs are read on a fixed 16 m lattice rather than on this
  // chunk's own grid. lod 0 samples every 4 m and lod 1 every 8 m, both of
  // which contain every 16 m node exactly, and lod 2's grid *is* 16 m - so the
  // admission test below is bit-identical at all three tiers. Without this the
  // tiers disagree within a few metres of any biome or moisture boundary, and
  // a thin band of trees blinks on and off every time a chunk splits.
  const qs = Math.max(1, Math.round(16 / step));
  const coarseAt = (lx, lz) => {
    const i = clamp(Math.round(lx / step / qs) * qs, 0, res) + 1;
    const j = clamp(Math.round(lz / step / qs) * qs, 0, res) + 1;
    return j * gw + i;
  };

  // Height read off the drawn surface rather than the nearest grid node.
  // Rounding to the node seats a tree up to 11 m from where the mesh actually
  // is, which at lod 2 sinks trees to their crowns in rough country.
  const heightAt = (lx, lz) => {
    const fx = clamp(lx / step, 0, res);
    const fz = clamp(lz / step, 0, res);
    const i = Math.min(Math.floor(fx), res - 1);
    const j = Math.min(Math.floor(fz), res - 1);
    const tx = fx - i;
    const tz = fz - j;
    const k = (j + 1) * gw + (i + 1);
    const a = gh[k] + (gh[k + 1] - gh[k]) * tx;
    const b = gh[k + gw] + (gh[k + gw + 1] - gh[k + gw]) * tx;
    return a + (b - a) * tz;
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
      // Reject on the hash alone before touching the grid: about seven cells
      // in eight fail here even in forest, and they used to pay for six array
      // reads and a BIOME_INFO lookup first.
      const r1 = ((h1 >>> 20) & 4095) / 4095;
      if (r1 >= MAX_TREES * 1.45 * cell * cell * 0.0082 * keep
        && (!wantGround || r1 <= 1 - MAX_ROCKS * cell * cell * 0.0032)) continue;

      const ci2 = coarseAt(lx, lz);
      const gi = gridAt(lx, lz);
      const h = heightAt(lx, lz);
      const wl = gwater[ci2];
      const biome = gbiome[ci2];
      const info = BIOME_INFO[biome];

      const depth = wl > -9000 ? wl - h : -1;
      const underwater = depth > 0.15;
      // Kelp and reef weed are the only things that grow with their feet in
      // the sea, and only where light still reaches the bottom.
      const marine = underwater && depth < 22 && (biome === BIOME.KELP || biome === BIOME.REEF);
      const built = gtown[ci2] > 0.25 || groad[ci2] > 0.12 || grail[ci2] > 0.10 || gsite[ci2] > 0.35;

      // trees
      //
      // `keep` thins by RANK, not by changing the lattice. The cell size stays
      // 4 m at every tier: the admission threshold contains cell*cell, so a
      // bigger cell would preserve density rather than thin it, and the hash is
      // keyed on the cell index, so a different cell size is a different point
      // set entirely - every tree in the chunk would teleport on a LOD change.
      // Thinning on rank instead makes a coarse chunk's trees a strict SUBSET
      // of the fine chunk's, at identical position, species, scale and
      // rotation, so splitting can only add trees and merging only remove ones
      // the finer tier had extra.
      const thr = density(info, gmoist[ci2]) * cell * cell * 0.0082;
      if ((!underwater || marine) && !built && r1 < thr * keep) {
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
          hash3i(ci, cj, 0xaced) >>> 0,
          // Rank in (0,1]: where this tree sits in the admission order. It is
          // a property of the tree, not of the tier that drew it, which is
          // what lets the near and far tiers agree on which trees exist.
          Math.min(1, r1 / thr)
        );
      } else if (wantGround && !built && !underwater && r1 > 1 - info.rocks * cell * cell * 0.0032) {
        const r2 = hash3f(ci, cj, 0x2299);
        const r3 = hash3f(ci, cj, 0x3377);
        rocks.push(
          px, h, pz,
          0.35 + r2 * r2 * 3.0,
          hash3f(ci, cj, 0x1) * 0.7,
          r3 * 6.2831853,
          hash3f(ci, cj, 0x2) * 0.7,
          biome
        );
      }
    }
  }

  // Grass tufts and flowers: much denser, only on the nearest chunks.
  if (wantGround && size <= 160) {
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
        if (gtown[g] > 0.4 || groad[g] > 0.2 || grail[g] > 0.15 || gsite[g] > 0.5) continue;
        const biome = gbiome[g];
        const info = BIOME_INFO[biome];
        // Worked land carries a crop, not a wild sward, and it is denser.
        const dens = info.grass * (0.6 + gmoist[g] * 0.7) * (1 + gfarm[g] * 0.5);
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
          isFlower ? 1 + Math.floor(hash3f(ci, cj, 0x8) * 3) : 0,
          biome
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


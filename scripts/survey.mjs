// What is actually out there?
//
// Samples a big grid of the world and prints how much of it is each biome, how
// much of it is flat, and how many landmarks and settlements it holds. The
// oracle is pure JavaScript with no three.js in it, so this runs in node in a
// couple of seconds - which makes it the cheapest possible way to answer "are
// mountains still everywhere?" before spending two minutes on a screenshot.
//
//   node scripts/survey.mjs [seed] [samples] [spacingMetres]

import { WorldGen, SETTLEMENT_INFO, SITE_INFO, SURFACE } from '../src/world/worldgen.js';
import { BIOME_INFO } from '../src/world/biomes.js';

const SEED = (+process.argv[2] || 1337) >>> 0;
const N = +process.argv[3] || 220;      // grid is N x N
const STEP = +process.argv[4] || 260;   // metres between samples

const wg = new WorldGen(SEED);
const s = {};

const biome = new Map();
const relief = [0, 0, 0, 0, 0]; // flat / gentle / rolling / hilly / mountainous
let land = 0;
let sumSlope = 0;
let maxH = -1e9;
let minH = 1e9;
const surfaces = [0, 0, 0, 0];

const half = (N * STEP) / 2;
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const x = -half + i * STEP;
    const z = -half + j * STEP;
    wg.sample(x, z, s);
    biome.set(s.biome, (biome.get(s.biome) || 0) + 1);
    if (s.height > 0) {
      land++;
      maxH = Math.max(maxH, s.height);
      minH = Math.min(minH, s.height);
      const sl = wg.baseSlope(x, z, 40);
      sumSlope += sl;
      relief[sl < 0.03 ? 0 : sl < 0.08 ? 1 : sl < 0.18 ? 2 : sl < 0.36 ? 3 : 4]++;
    }
    if (s.road > 0.2) surfaces[s.roadSurface]++;
  }
}

const total = N * N;
const area = ((N * STEP) / 1000) ** 2;
console.log(`seed ${SEED} · ${((N * STEP) / 1000).toFixed(0)} km square · ${total} samples\n`);

const rows = [...biome.entries()].sort((a, b) => b[1] - a[1]);
console.log('biomes');
for (const [b, n] of rows) {
  const pct = (n / total) * 100;
  if (pct < 0.05) continue;
  console.log(`  ${BIOME_INFO[b].name.padEnd(14)} ${pct.toFixed(2).padStart(6)}%  ${'#'.repeat(Math.round(pct))}`);
}
console.log(`  (${rows.length} distinct biomes present)`);

console.log('\nrelief of the land');
const names = ['flat      ', 'gentle    ', 'rolling   ', 'hilly     ', 'mountainous'];
for (let i = 0; i < 5; i++) {
  const pct = (relief[i] / Math.max(1, land)) * 100;
  console.log(`  ${names[i]} ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct / 2))}`);
}
console.log(`  land ${((land / total) * 100).toFixed(0)}% · altitude ${minH.toFixed(0)}..${maxH.toFixed(0)} m · mean slope ${(sumSlope / Math.max(1, land)).toFixed(3)}`);

/* ------------------------------------------------------------- coherence */

// The measurements that decide whether the player feels they are *somewhere*.
// A world can hold forty biomes and still be worthless to explore if you cross
// six of them on the way to the river. What matters is how far you have to go
// before the country genuinely changes.
{
  const tempPer10 = [];
  const domFrac = [];
  const nearKinds = [];
  const toDifferent = [];

  for (let k = 0; k < 160; k++) {
    const a = k * 0.9137;
    const r = 4000 + k * 300;
    const x0 = Math.cos(a) * r;
    const z0 = Math.sin(a) * r;
    const dir = a + 1.1;
    wg.sample(x0, z0, s);
    const t0 = s.temperature;

    // How much does the air change over a ten-kilometre walk?
    wg.sample(x0 + Math.cos(dir) * 10000, z0 + Math.sin(dir) * 10000, s);
    tempPer10.push(Math.abs(s.temperature - t0));

    // ...and how far before it is a different world altogether?
    let d = 0;
    for (; d < 400000; d += 500) {
      wg.sample(x0 + Math.cos(dir) * d, z0 + Math.sin(dir) * d, s);
      if (Math.abs(s.temperature - t0) > 15) break;
    }
    toDifferent.push(d);

    // Over that same walk, how much of it is one kind of country?
    const counts = new Map();
    let onLand = 0;
    for (let w = 0; w < 10000; w += 25) {
      wg.sample(x0 + Math.cos(dir) * w, z0 + Math.sin(dir) * w, s);
      if (s.height < 1) continue;
      onLand++;
      counts.set(s.biome, (counts.get(s.biome) || 0) + 1);
    }
    if (onLand > 100) {
      domFrac.push(Math.max(...counts.values()) / onLand);
      // Only count a biome that holds a real share of the ground: one sample
      // caught in the fringe of a boundary is not a place you can go to.
      nearKinds.push([...counts.values()].filter((v) => v / onLand >= 0.03).length);
    }
  }

  const at = (arr, q) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * q)];
  const km = (v) => (v / 1000).toFixed(0) + ' km';
  console.log('\ncoherence — does it feel like one place?');
  console.log(`  air temperature change over a 10 km walk   median ${at(tempPer10, 0.5).toFixed(1)} °C · 90th pct ${at(tempPer10, 0.9).toFixed(1)} °C`);
  console.log(`  share of that walk in one biome            median ${(at(domFrac, 0.5) * 100).toFixed(0)}%`);
  console.log(`  kinds of country within 10 km             median ${at(nearKinds, 0.5)}`);
  console.log(`  distance before a 15 °C change            median ${km(at(toDifferent, 0.5))} · 10th pct ${km(at(toDifferent, 0.1))}`);
  console.log(`  ...which on foot is about ${(at(toDifferent, 0.5) / 5 / 3600).toFixed(1)} hours, or ${(at(toDifferent, 0.5) / 46 / 60).toFixed(0)} minutes in the aeroplane`);
}

/* -------------------------------------------------------- what people built */

const towns = wg.townsNear(0, 0, half * 1.4);
const kinds = [0, 0, 0, 0, 0];
let rail = 0;
for (const t of towns) {
  kinds[t.kind]++;
  rail += t.railLinks.length;
}
console.log('\nsettlements');
for (let k = 1; k < 5; k++) {
  console.log(`  ${SETTLEMENT_INFO[k].name.padEnd(9)} ${String(kinds[k]).padStart(4)}   (${(kinds[k] / area * 100).toFixed(1)} per 100 km²)`);
}
console.log(`  railway links ${rail}`);
const surfNames = ['none', 'dirt', 'gravel', 'tarmac'];
console.log('  road surface seen: ' + surfNames.map((n, i) => `${n} ${surfaces[i]}`).join(' · '));

const sites = wg.sitesNear(0, 0, Math.min(half, 9000));
const byKind = new Map();
for (const st of sites) byKind.set(st.kind, (byKind.get(st.kind) || 0) + 1);
console.log(`\nlandmarks within 9 km (${sites.length} total)`);
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${SITE_INFO[k].name.padEnd(20)} ${n}`);
}

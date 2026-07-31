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

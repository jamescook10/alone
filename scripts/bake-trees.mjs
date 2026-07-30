// Bake the game's tree species with ez-tree and write them to public/assets.
//
//   node scripts/bake-trees.mjs
//
// Runs the bake rig in headless Chromium (ez-tree builds three.js geometry),
// exports each species as two GLBs - full detail and a far-LOD variant - and
// vendors the MIT-licensed bark/leaf textures out of the ez-tree package.
// The results are committed, so this only reruns when species change.

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const OUT = new URL('../public/assets/trees/', import.meta.url).pathname;
const TEX = OUT + 'tex/';
const EZ = new URL('../node_modules/@dgreenheck/ez-tree/src/lib/assets/', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// One entry per species that gets baked geometry. palm, cactus and fern keep
// their hand-built forms - they are the strongest of the old builders and
// ez-tree has no habit for them.
// Children multiply per level and leaves attach per terminal branch, so the
// stock presets run 16-37k triangles per tree. These baselines hold a near
// tree to ~1.5-2.5k and a far one under ~250.
// Children multiply per level and leaves attach per terminal branch, so the
// stock presets run 16-37k triangles per tree. The near ring can hold ~1800
// full-detail trees at once, which prices a near tree at roughly 600-900
// triangles and a far one at about 60. Fewer-but-bigger leaf cards keep the
// canopy mass up at that budget - and read better stylised anyway.
const BASE = {
  branch: { levels: 2, children: { 0: 4, 1: 3 }, sections: { 0: 5, 1: 3, 2: 2 }, segments: { 0: 6, 1: 4, 2: 3 } },
};
const LOW = { // far-LOD: silhouette only
  branch: { levels: 1, children: { 0: 3 }, sections: { 0: 2, 1: 2 }, segments: { 0: 4, 1: 3 } },
};
const SPECIES = [
  { name: 'oak', preset: 'Oak Medium', tex: { bark: 'oak', leaf: 'oak' },
    overrides: { seed: 101, ...BASE, leaves: { count: 5, size: 6.2 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 13.0, billboard: 'single' } } },
  { name: 'pine', preset: 'Pine Medium', tex: { bark: 'pine', leaf: 'pine' },
    overrides: { seed: 202, branch: { ...BASE.branch, children: { 0: 6, 1: 2 } }, leaves: { count: 4, size: 4.2 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 9.0, billboard: 'single' } } },
  { name: 'birch', preset: 'Aspen Medium', tex: { bark: 'birch', leaf: 'aspen' },
    overrides: { seed: 303, bark: { type: 'birch' }, ...BASE, leaves: { count: 5, size: 5.0 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 10.0, billboard: 'single' } } },
  { name: 'acacia', preset: 'Oak Small', tex: { bark: 'oak', leaf: 'ash' },
    overrides: {
      seed: 404,
      branch: { ...BASE.branch, angle: { 1: 78, 2: 66 }, force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.04 } },
      leaves: { type: 'ash', count: 5, size: 5.4 },
    },
    farOverrides: { ...LOW, leaves: { count: 3, size: 10.0, billboard: 'single' } } },
  { name: 'willow', preset: 'Ash Large', tex: { bark: 'willow', leaf: 'ash' },
    overrides: {
      seed: 505,
      bark: { type: 'willow' },
      branch: { ...BASE.branch, force: { direction: { x: 0, y: -1, z: 0 }, strength: 0.035 } },
      leaves: { count: 6, size: 5.0 },
    },
    farOverrides: { ...LOW, leaves: { count: 3, size: 10.0, billboard: 'single' } } },
  { name: 'snag', preset: 'Oak Medium', tex: { bark: 'willow', leaf: null },
    overrides: {
      seed: 606, bark: { type: 'willow' },
      branch: {
        ...BASE.branch, levels: 3, children: { 0: 3, 1: 2, 2: 2 },
        sections: { 0: 5, 1: 3, 2: 2, 3: 1 }, gnarliness: { 1: 0.4, 2: 0.5, 3: 0.4 },
      },
      leaves: { count: 0 },
    },
    farOverrides: { ...LOW, leaves: { count: 0 } } },
  { name: 'jungle', preset: 'Ash Large', tex: { bark: 'oak', leaf: 'ash' },
    overrides: { seed: 707, branch: { ...BASE.branch, radius: { 0: 2.2 }, length: { 0: 60 } }, leaves: { count: 6, size: 7.0 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 13.0, billboard: 'single' } } },
  { name: 'spruce', preset: 'Pine Large', tex: { bark: 'pine', leaf: 'pine' },
    overrides: { seed: 808, branch: { ...BASE.branch, children: { 0: 7, 1: 2 } }, leaves: { count: 4, size: 4.6 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 10.0, billboard: 'single' } } },
  { name: 'bush', preset: 'Bush 1', tex: { bark: 'oak', leaf: 'oak' },
    overrides: { seed: 909, ...BASE, leaves: { count: 6, size: 2.2 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 4.0, billboard: 'single' } } },
  { name: 'sapling', preset: 'Oak Small', tex: { bark: 'oak', leaf: 'oak' },
    overrides: { seed: 1010, branch: { ...BASE.branch, children: { 0: 3, 1: 2 } }, leaves: { count: 4, size: 2.4 } },
    farOverrides: { ...LOW, leaves: { count: 3, size: 4.0, billboard: 'single' } } },
];

// --- boot a vite server for the bake rig -----------------------------------
const vite = spawn('npx', ['vite', 'scripts/bake', '--port', '5199', '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'inherit', 'inherit'],
});
// Poll until the dev server answers.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch('http://127.0.0.1:5199/', { signal: AbortSignal.timeout(1500) });
    if (res.ok) break;
  } catch { /* not up yet */ }
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('bake pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('bake console:', m.text()); });

try {
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.bakeReady, null, { timeout: 30000 });

  mkdirSync(OUT, { recursive: true });
  mkdirSync(TEX, { recursive: true });
  let total = 0;
  const only = process.env.SPECIES_FILTER ? process.env.SPECIES_FILTER.split(',') : null;
  for (const sp of SPECIES.filter((s) => !only || only.includes(s.name))) {
    const cfg = { name: sp.name, preset: sp.preset, overrides: sp.overrides, farOverrides: sp.farOverrides };
    const r = await page.evaluate((c) => window.bakeOne(c), cfg);
    writeFileSync(OUT + sp.name + '.glb', Buffer.from(r.glb, 'base64'));
    writeFileSync(OUT + sp.name + '_far.glb', Buffer.from(r.farGlb, 'base64'));
    total += r.tris;
    console.log(`${sp.name.padEnd(8)} ${String(r.tris).padStart(6)} tris  (far ${r.farTris})`);
  }
  console.log('total near tris across species:', total);

  // Vendor the textures each species actually references.
  const barks = new Set(SPECIES.map((s) => s.tex.bark));
  const leaves = new Set(SPECIES.map((s) => s.tex.leaf).filter(Boolean));
  for (const b of barks) {
    for (const kind of ['color', 'normal', 'roughness']) {
      copyFileSync(`${EZ}bark/${b}_${kind}_1k.jpg`, `${TEX}${b}_${kind}.jpg`);
    }
  }
  for (const l of leaves) copyFileSync(`${EZ}leaves/${l}_color.png`, `${TEX}${l}_color.png`);

  writeFileSync(OUT + 'MANIFEST.json', JSON.stringify({
    species: Object.fromEntries(SPECIES.map((s) => [s.name, s.tex])),
  }, null, 2));
  writeFileSync(OUT + 'LICENSE.md',
    '# Tree geometry and textures\n\n' +
    'Baked with [ez-tree](https://github.com/dgreenheck/ez-tree) by Daniel\n' +
    'Greenheck (MIT). Bark and leaf textures are redistributed from the\n' +
    'ez-tree package under the same MIT license.\n');
  console.log('bake: wrote ' + OUT);
} finally {
  await browser.close();
  vite.kill();
}

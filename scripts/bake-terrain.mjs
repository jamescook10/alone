// Bake the terrain texture sets to public/assets/terrain.
//
//   node scripts/bake-terrain.mjs
//
// Four tileable sets - grass, rock, sand, snow - each a colour jpeg
// (luminance centred on 0.5, multiplied into the biome vertex colour at run
// time) and an "nr" jpeg carrying tangent normal in RG and roughness in B.

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const OUT = new URL('../public/assets/terrain/', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SETS = ['grass', 'rock', 'sand', 'snow'];

const vite = spawn('npx', ['vite', 'scripts/bake', '--port', '5199', '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
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

try {
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.terrainReady, null, { timeout: 30000 });
  mkdirSync(OUT, { recursive: true });
  for (const name of SETS) {
    const r = await page.evaluate((n) => window.bakeTerrainSet(n), name);
    writeFileSync(`${OUT}${name}_color.jpg`, Buffer.from(r.color, 'base64'));
    writeFileSync(`${OUT}${name}_nr.jpg`, Buffer.from(r.nr, 'base64'));
    console.log(name, 'ok');
  }
  writeFileSync(OUT + 'MANIFEST.json', JSON.stringify({ sets: SETS }, null, 2));
  console.log('bake: wrote ' + OUT);
} finally {
  await browser.close();
  vite.kill();
}

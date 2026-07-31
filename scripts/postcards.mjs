// A contact sheet of the world.
//
// A change can compile, throw no errors and pass every test while looking
// terrible - several already have. This finds one example of each place worth
// looking at, stands the player in it at a chosen hour, and screenshots it.
//
//   npm run build && npm run preview
//   node scripts/postcards.mjs out/ [hour] [seed]
//
// SwiftShader is software rendering: budget half a minute a frame.

import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots';
const HOUR = process.argv[3] !== undefined ? +process.argv[3] : 9.5;
const SEED = process.argv[4] || '1337';
const URL = (process.env.SMOKE_URL || 'http://127.0.0.1:4173/') + '?seed=' + SEED;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// What is worth a postcard. Biome names come from BIOME_INFO; landmark names
// from SITE_INFO. Anything not found in the search radius is just skipped.
const WANT_BIOME = [
  'Dunes', 'Rainforest', 'Savanna', 'Glacier', 'Snowfield', 'Badlands',
  'Salt flat', 'Lava field', 'Karst', 'Moorland', 'Marsh', 'Prairie',
  'Taiga', 'Forest', 'Mangrove', 'Alpine', 'Shore', 'Steppe', 'Farmland', 'City',
];
const WANT_SITE = ['airstrip', 'lighthouse', 'overgrown temple', 'farmstead', 'windmill', 'wreck'];

mkdirSync(OUT, { recursive: true });
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

console.log(`postcards: ${URL} @ ${HOUR}h -> ${OUT}/`);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => !!(window.__game && window.__game.running))) break;
}

const spots = await page.evaluate(([wantB, wantS]) => {
  const wg = window.__game.world.wg;
  const INFO = window.__game.biomeInfo;
  const out = [];
  const seenB = new Set();
  const seenS = new Set();
  const s = {};
  for (let i = 0; i < 60000 && (seenB.size < wantB.length || seenS.size < wantS.length); i++) {
    const a = i * 2.399963;
    const r = 120 * Math.sqrt(i);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    wg.sample(x, z, s);
    const name = INFO[s.biome].name;
    if (s.height > 0.5 && wantB.includes(name) && !seenB.has(name)) {
      seenB.add(name);
      out.push({ name, x, z });
    }
    if (i % 7 === 0) {
      for (const st of wg.sitesNear(x, z, 600)) {
        if (wantS.includes(st.name) && !seenS.has(st.name)) {
          seenS.add(st.name);
          out.push({ name: st.name, x: st.x + 26, z: st.z + 26 });
        }
      }
    }
  }
  return out;
}, [WANT_BIOME, WANT_SITE]);

console.log(`postcards: found ${spots.length} of ${WANT_BIOME.length + WANT_SITE.length}`);

let n = 0;
for (const spot of spots) {
  await page.evaluate(([x, z, hour]) => {
    const g = window.__game;
    const w = g.world;
    w.player.vehicle = null;
    w.player.position.set(x, w.terrain.heightAt(x, z) + 1.6, z);
    w.player.velocity.set(0, 0, 0);
    w.sky.time = hour / 24;
    w.terrain.update(w.player.position, true);
    for (let i = 0; i < 260; i++) w.update(0.033);
    // Stand a little way off the ground looking slightly down the sun, which
    // is the angle that shows the most landscape.
    const sd = w.sky.sunDir;
    w.player.yaw = Math.atan2(-sd.x, -sd.z) + 0.6;
    w.player.pitch = -0.06;
    w.player.position.y = w.terrain.heightAt(x, z) + 6;
    if (g.ui) { g.ui.showHud(false); g.ui.fadeAmount = 0; }
  }, [spot.x, spot.z, HOUR]);
  // Let the software rasteriser compile any new shader variants and actually
  // draw a few frames of the streamed-in world.
  await page.waitForTimeout(22000);
  const file = `${OUT}/${String(++n).padStart(2, '0')}-${spot.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  console.log('  ' + file);
}

await browser.close();
console.log('postcards: done');

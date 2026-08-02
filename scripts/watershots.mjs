// Water and rain, staged. Postcards only ever catches the weather it happens
// to get, and almost nothing about water shows up at the spawn point - so
// this stands the player at a lake shore, beside a river, in a soaked storm
// (puddles, fat streaks, lens droplets) and in drizzle, and screenshots each.
//
//   npm run build && npm run preview
//   node scripts/watershots.mjs out/ [seed]
//
// SwiftShader is software rendering: budget half a minute a frame.
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots';
const SEED = process.argv[3] || '1337';
const URL = (process.env.SMOKE_URL || 'http://127.0.0.1:4173/') + '?seed=' + SEED;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => !!(window.__game && window.__game.running))) break;
}

async function shot(name, setup) {
  const info = await page.evaluate(setup);
  console.log(name, JSON.stringify(info));
  // Let the renderer catch up (shader compiles are slow under SwiftShader).
  await page.waitForTimeout(25000);
  await page.evaluate(() => {
    const g = window.__game;
    // Hide the HUD visually but leave hudVisible true, so the lens droplet
    // overlay (part of what these shots verify) is not suppressed.
    if (g.ui) { g.ui.hud.classList.remove('on'); g.ui.fadeAmount = 0; }
  });
  await page.waitForTimeout(3000);
  writeFileSync(`${OUT}/${name}.png`, await page.screenshot());
  const errs = await page.evaluate(() => window.__game.errors);
  if (errs && errs.length) console.error('errors:', errs);
}

// 1. A lake: scan lake cells outward from spawn, stand on the shore.
await shot('water-lake', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  const ci = Math.floor(p.position.x / 2300), cj = Math.floor(p.position.z / 2300);
  let L = null;
  outer: for (let r = 0; r < 26; r++) {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const c = wg.lakeCell(ci + i, cj + j);
      if (c) { L = c; break outer; }
    }
  }
  if (!L) return { fail: 'no lake' };
  // Stand on the rim, look at the centre.
  const a = 0.7;
  const x = L.x + Math.cos(a) * L.r * 1.15, z = L.z + Math.sin(a) * L.r * 1.15;
  p.position.set(x, wg.height(x, z) + 1.6, z);
  p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-(L.x - x), -(L.z - z));
  p.pitch = -0.12;
  w.weather.force('clear');
  w.sky.time = 10.5 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 200; i++) w.update(0.033);
  return { lake: [L.x | 0, L.z | 0], r: L.r | 0, level: +L.level.toFixed(1) };
});

// 2. A river: sample outward for a strong river on gentle ground.
await shot('water-river', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  const s = {};
  let best = null;
  for (let i = 0; i < 20000; i++) {
    const a = i * 2.399963, r = 60 * Math.sqrt(i);
    const x = p.position.x + Math.cos(a) * r, z = p.position.z + Math.sin(a) * r;
    wg.sample(x, z, s);
    if (s.riverStrength > 0.6 && s.waterLevel > -Infinity && s.baseHeight > 4) { best = { x, z }; break; }
  }
  if (!best) return { fail: 'no river' };
  const x = best.x, z = best.z;
  const fd = wg.flowDir(x, z, [0, 0]);
  // Stand beside the channel, look along the flow.
  const px = x + fd[1] * 14, pz = z - fd[0] * 14;
  p.position.set(px, wg.height(px, pz) + 1.7, pz);
  p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-fd[0], -fd[1]);
  p.pitch = -0.18;
  w.weather.force('clear');
  w.sky.time = 15 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 200; i++) w.update(0.033);
  return { river: [x | 0, z | 0] };
});

// 3. Storm: puddles on a flat road/field + lens droplets.
await shot('rain-storm', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  // Find flat open ground.
  const s = {};
  let spot = null;
  for (let i = 0; i < 8000; i++) {
    const a = i * 2.399963, r = 30 * Math.sqrt(i);
    const x = p.position.x + Math.cos(a) * r, z = p.position.z + Math.sin(a) * r;
    wg.sample(x, z, s);
    if (s.height > 4 && s.waterLevel === -Infinity && wg.baseSlope(x, z, 10) < 0.03) { spot = { x, z }; break; }
  }
  if (spot) {
    p.position.set(spot.x, wg.height(spot.x, spot.z) + 1.7, spot.z);
    p.velocity.set(0, 0, 0);
  }
  p.pitch = -0.28;
  w.weather.force('storm');
  w.sky.time = 13 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 500; i++) w.update(0.033);
  w.weather.wetness = 0.85;
  return { wetness: +w.weather.wetness.toFixed(2), rain: +w.weather.rain.toFixed(2) };
});

// 4. Drizzle: fine mist, thin hiss (visual half only here).
await shot('rain-drizzle', () => {
  const g = window.__game; const w = g.world;
  w.weather.override = { rain: 0.12, frontRain: 0.12, wetness: 0.2, cloudCover: 0.8, overcast: 0.5 };
  w.sky.time = 9 / 24;
  for (let i = 0; i < 120; i++) w.update(0.033);
  return { rain: 0.12 };
});

await browser.close();
console.log('done');

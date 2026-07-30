// Screenshot the real game in headless Chromium, for eyeballing a change
// before it ships. Fixed seed, chosen hour, chosen weather, camera aimed at
// the sun so the whole lighting stack is in frame.
//
//   npm run build && npm run preview
//   node scripts/shot.mjs out.png [hourOfDay] [weather] [seed]
//
// SwiftShader is slow: expect a couple of minutes per run. Frame rate here
// means nothing - this is for looking, not measuring.

import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'shot.png';
const HOUR = process.argv[3] !== undefined ? +process.argv[3] : 10;
const WEATHER = process.argv[4] || 'clear';
const SEED = process.argv[5] || 'postcard';
const URL = (process.env.SMOKE_URL || 'http://127.0.0.1:4173/') + '?seed=' + SEED;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

console.log(`shot: ${URL} @ ${HOUR}h, ${WEATHER} -> ${OUT}`);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');

for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => !!(window.__game && window.__game.running))) break;
}

await page.evaluate(([hour, weather]) => {
  const g = window.__game;
  const w = g.world;
  w.weather.force(weather);
  w.sky.time = hour / 24;
  // Let clouds, wetness and lighting settle at the new time.
  for (let i = 0; i < 240; i++) w.update(0.033);
  // Face the sun, slightly up: shadows, shafts, water glitter and canopy
  // translucency are all at their most honest looking this way.
  const s = w.sky.sunDir;
  w.player.yaw = Math.atan2(-s.x, -s.z);
  w.player.pitch = Math.max(-0.05, Math.asin(Math.max(-1, Math.min(1, s.y))) * 0.5);
  if (g.ui) g.ui.showHud(false);
}, [HOUR, WEATHER]);

// Give the software rasteriser time to compile any new shader variants and
// actually put frames on screen.
await page.waitForTimeout(25000);
const png = await page.screenshot({ type: 'png' });
writeFileSync(OUT, png);
console.log('shot: wrote ' + OUT);
await browser.close();

// A contact sheet of the sky.
//
// The sky is the one part of this game you cannot test by walking around in
// it: an aurora happens on a few nights a year, a rainbow needs sun on rain,
// and a full moon at the right elevation is a fortnight away. So this stands
// the player in a chosen place at a chosen hour, forces the conditions, points
// the camera at the interesting half of the sky and takes the picture.
//
//   npm run build && npm run preview
//   node scripts/skyshots.mjs out/ [seed]
//
// SwiftShader is software rendering: budget half a minute a frame.

import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'shots';
const SEED = process.argv[3] || 'sky';
const ONLY = process.argv[4];
const URL = (process.env.SMOKE_URL || 'http://127.0.0.1:4173/') + '?seed=' + SEED;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// `sun` is the sun's elevation as a sine, searched for over the day, because
// the day length now moves with the latitude and the season and "half past
// seven" is not sunset everywhere. `look` is where to point: 'sun', 'moon',
// 'anti' (away from the sun), 'north' (where an aurora hangs) or 'up'.
// `set` is written into world.weather.override to force a rare event.
const SHOTS = [
  { name: 'night-milkyway', sun: -0.6, pm: 1, weather: 'clear', look: 'milkyway', pitch: 0.2, set: { aurora: 0 } },
  { name: 'night-horizon', sun: -0.45, pm: 1, weather: 'clear', look: 'north', pitch: 0.18, set: { aurora: 0 } },
  { name: 'night-moon', sun: -0.5, pm: 1, weather: 'clear', look: 'moon', pitch: 0.3, day: 2, set: { aurora: 0 } },
  { name: 'night-crescent', sun: -0.12, pm: 1, weather: 'clear', look: 'moon', pitch: 0.2, day: 4, set: { aurora: 0 } },
  { name: 'night-aurora', sun: -0.6, pm: 1, weather: 'clear', look: 'north', pitch: 0.32, set: { aurora: 0.85 } },
  { name: 'night-aurora-faint', sun: -0.6, pm: 1, weather: 'clear', look: 'north', pitch: 0.22, set: { aurora: 0.30 } },
  { name: 'night-meteors', sun: -0.55, pm: 1, weather: 'clear', look: 'up', pitch: 0.55, meteors: 4 },
  { name: 'dawn', sun: 0.02, pm: 0, weather: 'clear', look: 'sun', pitch: 0.10 },
  { name: 'dawn-belt', sun: -0.03, pm: 0, weather: 'clear', look: 'anti', pitch: 0.16 },
  { name: 'sunset', sun: 0.015, pm: 1, weather: 'clear', look: 'sun', pitch: 0.10 },
  { name: 'dusk', sun: -0.09, pm: 1, weather: 'clear', look: 'sun', pitch: 0.14 },
  { name: 'sunset-cirrus', sun: 0.03, pm: 1, weather: 'clear', look: 'sun', pitch: 0.24, set: { cirrus: 0.85 } },
  { name: 'noon', sun: 0.62, pm: 0, weather: 'cloudy', look: 'sun', pitch: 0.20 },
  { name: 'afternoon', sun: 0.42, pm: 1, weather: 'cloudy', look: 'anti', pitch: 0.06 },
  // A rainbow wants a showery sky, not a solid one: sun through a gap, rain
  // falling in front of you. The desert this happens to stand in would never
  // produce either, so both are forced.
  { name: 'rainbow', sun: 0.22, pm: 1, weather: 'cloudy', look: 'anti', pitch: 0.30,
    set: { rainbow: 0.95, rain: 0.5, frontRain: 0.5, cloudCover: 0.55, overcast: 0.15 } },
  { name: 'storm', sun: 0.35, pm: 1, weather: 'storm', look: 'anti', pitch: 0.16, bolt: true,
    set: { cloudCover: 0.96, overcast: 0.9, cloudDark: 0.85, stormy: 0.95, frontRain: 0.85, rain: 0.8 } },
  { name: 'storm-towers', sun: 0.45, pm: 0, weather: 'storm', look: 'anti', pitch: 0.20,
    set: { cloudCover: 0.72, overcast: 0.3, cloudDark: 0.6, stormy: 0.85, frontRain: 0.3, rain: 0.2 } },
  { name: 'overcast', sun: 0.5, pm: 0, weather: 'rain', look: 'anti', pitch: 0.12 },
];

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
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

console.log(`skyshots: ${URL} -> ${OUT}/`);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => !!(window.__game && window.__game.running))) break;
}

// Stand somewhere with a horizon worth having sky over: open, treeless, above
// the country around it and nowhere near a town. Under a canopy you cannot
// see any of this, and a street lamp ruins a night sky here for the same
// reason it does at home.
const spot = await page.evaluate(() => {
  const wg = window.__game.world.wg;
  const INFO = window.__game.biomeInfo;
  const OPEN = ['Moorland', 'Steppe', 'Prairie', 'Alpine', 'Snowfield', 'Tundra',
    'Dunes', 'Salt flat', 'Badlands', 'Scrub', 'Heath', 'Grassland'];
  const s = {};
  let best = null;
  for (let i = 1; i < 9000; i++) {
    const a = i * 2.399963;
    const r = 320 * Math.sqrt(i);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    wg.sample(x, z, s);
    if (s.height < 3 || s.townInfluence > 0.001 || s.road > 0.001) continue;
    if (!OPEN.includes(INFO[s.biome].name)) continue;
    if (wg.sitesNear(x, z, 2500).length) continue;
    if (!best || s.height > best.score) best = { x, z, score: s.height, biome: INFO[s.biome].name };
    if (best.score > 240) break;
  }
  return best || { x: 0, z: 0, biome: 'spawn' };
});
console.log(`skyshots: standing on ${spot.biome} at ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}`);
await page.evaluate((p) => {
  const g = window.__game;
  const w = g.world;
  w.player.vehicle = null;
  w.player.position.set(p.x, w.terrain.heightAt(p.x, p.z) + 2.0, p.z);
  w.player.velocity.set(0, 0, 0);
  w.terrain.update(w.player.position, true);
  // First person: the back of your own head is not what these shots are of.
  if (w.player.rig) Object.assign(w.player.rig, { mode: 'first', blend: 1, t: 1, lock: false });
  if (g.ui) { g.ui.showHud(false); g.ui.fadeAmount = 0; }
}, spot);
await page.waitForTimeout(8000);

for (const shot of SHOTS) {
  if (ONLY && !shot.name.includes(ONLY)) continue;
  await page.evaluate((s) => {
    const g = window.__game;
    const w = g.world;
    w.weather.override = null;
    w.weather.force(s.weather);
    if (s.day !== undefined) w.sky.day = s.day;
    // Find the time of day at which the sun sits at the wanted elevation, on
    // the half of the day asked for. One update() per probe, because the sun's
    // direction is only worked out inside it.
    let bestT = 0.5, bestE = 9;
    for (let i = 0; i < 240; i++) {
      const tt = i / 240;
      if (s.pm !== undefined && (tt > 0.5) !== !!s.pm) continue;
      w.sky.time = tt;
      w.update(0.0001);
      const e = Math.abs(w.sky.sunDir.y - s.sun);
      if (e < bestE) { bestE = e; bestT = tt; }
    }
    w.sky.time = bestT;
    for (let i = 0; i < 200; i++) w.update(0.033);
    if (s.set) { w.weather.override = s.set; for (let i = 0; i < 20; i++) w.update(0.033); }
    if (s.meteors) for (let i = 0; i < s.meteors; i++) w.sky.stars.spawnMeteor(3);
    if (s.bolt) {
      // A stroke lasts a fifth of a second, so it has to be fired on the last
      // frame before the shutter or it will have gone.
      const p = w.player.position;
      // yaw Y faces (-sin Y, -cos Y), so the stroke goes that way, not the
      // other, or it lands behind the camera.
      const a = Math.atan2(w.sky.sunDir.x, w.sky.sunDir.z) + 0.35;
      w.weather._strike(p.x - Math.sin(a) * 900, p.z - Math.cos(a) * 900, p.y + 620);
      w.weather.boltT = w.weather.boltLife = 1e6;
      w.weather.boltUniforms.uBright.value = 2.0;
      w.weather.bolt.visible = true;
      w.weather.lightning = 0.85;
    }
    // yaw = atan2(-x, -z) faces the direction (x, z); north is -Z, so yaw 0.
    let mw = null;
    if (s.look === 'milkyway') {
      // Search the visible sky for the brightest part of the galactic band -
      // where it is depends on the latitude, the season and the hour.
      const e = w.sky.stars.skyRot.elements;
      const inv = (d) => [e[0] * d[0] + e[1] * d[1] + e[2] * d[2],
        e[3] * d[0] + e[4] * d[1] + e[5] * d[2], e[6] * d[0] + e[7] * d[1] + e[8] * d[2]];
      const GP = [-0.8678, -0.1970, 0.4560], GC = [-0.0549, -0.8734, -0.4839], GY = [0.4936, -0.4450, 0.7471];
      const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      let bl = -1;
      for (let az = 0; az < 96; az++) for (let el = 2; el < 20; el++) {
        const a = az / 96 * Math.PI * 2, e1 = el / 24 * Math.PI / 2;
        const d = [Math.cos(e1) * Math.cos(a), Math.sin(e1), Math.cos(e1) * Math.sin(a)];
        const sd = inv(d);
        const sb = dot3(sd, GP), glon = Math.atan2(dot3(sd, GY), dot3(sd, GC));
        const bulge = Math.exp(-glon * glon * 0.85);
        const lum = Math.exp(-(sb * sb) / Math.pow(0.085 + 0.17 * bulge, 2)) * (0.3 + 1.45 * bulge);
        if (lum > bl) { bl = lum; mw = d; }
      }
    }
    const dir = mw ? { x: mw[0], y: mw[1], z: mw[2] } : { sun: w.sky.sunDir, moon: w.sky.moonDir }[s.look];
    let yaw = 0, pitch = s.pitch;
    if (s.look === 'anti') yaw = Math.atan2(w.sky.sunDir.x, w.sky.sunDir.z);
    else if (dir) {
      yaw = Math.atan2(-dir.x, -dir.z);
      pitch = Math.max(s.pitch, Math.asin(Math.max(-1, Math.min(1, dir.y))) - 0.12);
    }
    w.player.yaw = yaw;
    w.player.pitch = pitch;
  }, shot);
  await page.waitForTimeout(22000);
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(`${OUT}/${shot.name}.png`, png);
  console.log('  ' + shot.name);
}

const errs = await page.evaluate(() => (window.__game && window.__game.errors) || []);
if (errs.length) console.error('page errors:', errs);
await browser.close();
console.log('skyshots: done');

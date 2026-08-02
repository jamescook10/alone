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
// A shader that fails to compile is not a page error - three.js logs it and
// carries on drawing nothing. That is exactly how the water material stayed
// broken through several rounds of screenshots while the riverbed underneath
// looked plausible, so these are surfaced loudly.
page.on('console', (m) => {
  const t = m.text();
  if (/shader|program|GLSL|WebGL/i.test(t) && m.type() !== 'log') console.error('CONSOLE:', t.slice(0, 400));
});

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => !!(window.__game && window.__game.running))) break;
}

async function shot(name, setup) {
  const info = await page.evaluate(setup);
  // Let the renderer catch up (shader compiles are slow under SwiftShader).
  await page.waitForTimeout(25000);
  // What is actually in front of the camera, so a puzzling frame can be
  // diagnosed without guessing at it from the pixels. Sampled AFTER the wait:
  // chunks mesh on workers, so asking straight after the teleport reports an
  // empty world and sends you hunting for a bug that is just streaming.
  const diag = await page.evaluate(() => {
    const w = window.__game.world;
    const p = w.player;
    let meshes = 0;
    w.terrain.waterGroup.traverse((o) => { if (o.isMesh && o.visible) meshes++; });
    const wl = w.terrain.waterAt(p.position.x, p.position.z);
    return {
      waterMeshes: meshes,
      waterUnderCam: wl === -Infinity ? null : +wl.toFixed(1),
      ground: +w.terrain.heightAt(p.position.x, p.position.z).toFixed(1),
      eyeY: +(p.position.y + p.eye).toFixed(1),
      under: p.underwater,
    };
  });
  console.log(name, JSON.stringify(info), JSON.stringify(diag));
  await page.evaluate(() => {
    const g = window.__game;
    // Hide the HUD visually but leave hudVisible true, so the lens droplet
    // overlay (part of what these shots verify) is not suppressed.
    if (g.ui) {
      // display:none rather than showHud(false): the boot sequence turns the
      // HUD back on a few seconds in, which is exactly the window the first
      // frame is taken in, and it came out with the intro toasts still up.
      g.ui.hud.style.display = 'none';
      g.ui.fadeAmount = 0;
      // The lens overlay is its own canvas on the body, so hiding the HUD
      // leaves the droplets - which are half of what the rain frames show.
      g.ui.hudVisible = true;
    }
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
  // Stand at the water's edge, look across it. The bowl only fills to about
  // 0.75 of the cell radius, so 1.15 put the camera a hundred metres inland.
  const a = 0.7;
  const x = L.x + Math.cos(a) * L.r * 0.82, z = L.z + Math.sin(a) * L.r * 0.82;
  p.position.set(x, wg.height(x, z) + 1.6, z);
  p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-(L.x - x), -(L.z - z));
  p.pitch = -0.06;
  w.weather.force('clear');
  w.sky.time = 10.5 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 200; i++) w.update(0.033);
  return { lake: [L.x | 0, L.z | 0], r: L.r | 0, level: +L.level.toFixed(1) };
});

// 2. A river: find a trunk channel with real flow and stand on its bank.
await shot('water-river', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  const ci = Math.floor(p.position.x / 3000), cj = Math.floor(p.position.z / 3000);
  let best = null, bestQ = 0;
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
    const path = wg.riverCell(ci + i, cj + j, 0);
    if (!path) continue;
    // The widest point that is still properly inland. Taking the widest point
    // outright puts you at the river mouth, where the shot is of the sea.
    for (let k = (path.n * 0.4) | 0; k < path.n; k++) {
      if (path.flow[k] > bestQ && path.level[k] > 25 && path.level[k] < 400) {
        bestQ = path.flow[k];
        best = { x: path.x[k], z: path.z[k], w: path.w[k] };
      }
    }
  }
  if (!best) return { fail: 'no river' };
  const fd = wg.flowDir(best.x, best.z, [0, 0]);
  const off = best.w + 9;
  const px = best.x + fd[1] * off, pz = best.z - fd[0] * off;
  p.position.set(px, wg.height(px, pz) + 1.7, pz);
  p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-fd[0], -fd[1]);
  p.pitch = -0.16;
  w.weather.force('clear');
  w.sky.time = 15 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 200; i++) w.update(0.033);
  return { river: [best.x | 0, best.z | 0], halfWidth: +best.w.toFixed(1), flow: +bestQ.toFixed(1) };
});

// 3. The steepest cascade around, looking back up the chute from below.
await shot('water-fall', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  // Walk the traced paths rather than fallsNear(): the camera has to be put
  // on the channel a few points DOWNSTREAM of the drop, and stepping along a
  // straight tangent from the fall walks straight out of a six-metre channel.
  let best = null;
  for (let t = 0; t < 2; t++) {
    const C = [3000, 700][t];
    const ci = Math.floor(p.position.x / C), cj = Math.floor(p.position.z / C);
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
      const path = wg.riverCell(ci + i, cj + j, t);
      if (!path) continue;
      for (let k = 2; k < path.n - 4; k++) {
        if (path.level[k] <= 1) continue;
        const score = path.fall[k] * Math.sqrt(path.flow[k]);
        if (!best || score > best.score) best = { path, k, score };
      }
    }
  }
  if (!best) return { fail: 'no falls' };
  const { path, k } = best;
  // Three points below the drop, off to one side of the channel.
  const kk = Math.min(path.n - 1, k + 3);
  const ax = path.x[kk], az = path.z[kk];
  const tx = path.x[kk] - path.x[kk - 1], tz = path.z[kk] - path.z[kk - 1];
  const tl = Math.hypot(tx, tz) || 1;
  const off = path.w[kk] + 7;
  const px = ax + (tz / tl) * off, pz = az - (tx / tl) * off;
  p.position.set(px, Math.max(wg.height(px, pz), path.level[kk]) + 1.7, pz);
  p.velocity.set(0, 0, 0);
  // Look back up at the drop.
  p.yaw = Math.atan2(-(path.x[k] - px), -(path.z[k] - pz));
  p.pitch = 0.10;
  w.weather.force('clear');
  w.sky.time = 12 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 400; i++) w.update(0.033);
  return {
    at: [ax | 0, az | 0], grade: +path.fall[k].toFixed(2),
    drop: +(path.level[k - 1] - path.level[k]).toFixed(1), flow: +path.flow[k].toFixed(1),
  };
});

// 4. Shallow water from above: clarity and caustics on the bed.
await shot('water-shallow', () => {
  const g = window.__game; const w = g.world; const wg = w.wg; const p = w.player;
  const s = {};
  let best = null;
  for (let i = 0; i < 30000; i++) {
    const a = i * 2.399963, r = 22 * Math.sqrt(i);
    const x = p.position.x + Math.cos(a) * r, z = p.position.z + Math.sin(a) * r;
    wg.sample(x, z, s);
    const d = s.waterLevel === -Infinity ? -1 : s.waterLevel - s.height;
    if (d > 0.25 && d < 1.4 && s.waterLevel > 1) { best = { x, z, wl: s.waterLevel, d }; break; }
  }
  if (!best) return { fail: 'no shallows' };
  // Back off to the bank and look across the water at a shallow angle: from
  // straight above you only ever see the bed, which tells you nothing about
  // how the surface reads.
  let bx = best.x, bz = best.z;
  for (let r = 4; r < 60; r += 2) {
    const gx = best.x + r, gz = best.z;
    if (wg.height(gx, gz) > best.wl + 0.4) { bx = gx; bz = gz; break; }
  }
  p.position.set(bx, wg.height(bx, bz) + 0.2, bz);
  p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-(best.x - bx), -(best.z - bz));
  p.pitch = -0.30;
  w.weather.force('clear');
  w.sky.time = 12.5 / 24;
  w.terrain.update(p.position, true);
  for (let i = 0; i < 300; i++) w.update(0.033);
  return { at: [best.x | 0, best.z | 0], depth: +best.d.toFixed(2) };
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

// What the world looks like from the air, and what it costs there.
//
// The smoke test stands still and the tour teleports, but both measure at head
// height. Almost everything that has gone wrong with streaming went wrong at
// altitude instead: the tier distance ignored height, so flying held the whole
// near ring at full detail; the far silhouette pools ran dry and whole
// hillsides of trees only appeared once you were nearly on top of them; and a
// double free drove instance counts negative, which nothing at ground level
// ever surfaced.
//
// This pins the player at a few altitudes, lets the retier settle, and checks
// that the near ring actually hands over to silhouettes, that no pool count
// goes negative, and that the painted canopy reaches the vertices.
//
//   npm run build && npm run preview
//   npm run flight
//
// Exits non-zero if anything is wrong, so it can gate a deploy.

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4173/';
const SEED = process.argv[2] || '1337';
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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const failures = [];
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/POOL-CORRUPTION/.test(t)) errors.push(t.slice(0, 400));
  else if (m.type() === 'error' && !/WebGL|GPU stall|deprecat/i.test(t)) {
    errors.push('console: ' + t.slice(0, 200));
  }
});

console.log(`flight: ${URL}?seed=${SEED}`);
await page.goto(URL + '?seed=' + SEED, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#begin');
let ready = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  ready = await page.evaluate(() => !!(window.__game && window.__game.running));
  if (ready) break;
}
if (!ready) {
  console.error('flight: the world never started');
  await browser.close();
  process.exit(1);
}

// Watch every instance pool for a slot freed twice. Pool.free is a
// swap-remove, so a double free silently corrupts every instance above the
// slot and drives the count below zero - it is invisible until a whole
// forest quietly stops drawing.
await page.evaluate(() => {
  const f = window.__game.world.flora;
  const names = new Map();
  f.barkPools.forEach((p, i) => p && names.set(p, 'bark' + i));
  f.leafPools.forEach((p, i) => p && names.set(p, 'leaf' + i));
  for (const [k, p] of Object.entries(f.farPools)) names.set(p, 'far:' + k);
  names.set(f.rockPool, 'rock');
  names.set(f.grassPool, 'grass');
  names.set(f.fruitPool, 'fruit');
  window.__corrupt = 0;
  for (const pool of names.keys()) {
    const orig = pool.free.bind(pool);
    pool.free = (i) => {
      if (i < 0 || i >= pool.mesh.count) {
        if (window.__corrupt++ < 5) {
          console.log(`POOL-CORRUPTION ${names.get(pool)} freed slot ${i} of ${pool.mesh.count}`);
        }
      }
      orig(i);
    };
  }
});

const rows = [];
for (const alt of [2, 280, 600]) {
  const r = await page.evaluate((alt) => {
    const g = window.__game;
    const w = g.world;
    const p = w.player.position;
    const hold = w.terrain.heightAt(p.x, p.z) + alt;
    p.y = hold;
    w.terrain.update(p, true);
    // Pin the altitude - gravity would drop the player back to the ground
    // long before the retier had worked through the ring.
    for (let i = 0; i < 400; i++) {
      w.update(0.033);
      p.y = hold;
      w.player.velocity.set(0, 0, 0);
    }
    let near = 0;
    let far = 0;
    for (const e of w.flora.chunks.values()) (e.far ? far++ : near++);
    let nearInst = 0;
    for (const pool of w.flora.barkPools) if (pool) nearInst += pool.mesh.count;
    let negative = 0;
    const pools = {};
    for (const [form, pool] of Object.entries(w.flora.farPools)) {
      if (pool.mesh.count < 0) negative++;
      if (pool.mesh.count) pools[form] = `${pool.mesh.count}/${pool.capacity}`;
    }
    // The painted canopy rides aux.z; if it never reaches the vertices,
    // distant forest is bare ground again.
    let canopy = 0;
    for (const node of w.terrain.nodes.values()) {
      if (!node.mesh) continue;
      const a = node.mesh.geometry.getAttribute('aux').array;
      for (let i = 2; i < a.length; i += 4) if (a[i] > canopy) canopy = a[i];
    }
    g.engine.render();
    const info = g.engine.renderer.info;
    return {
      near, far, nearInst, pools, negative,
      canopy: +canopy.toFixed(3),
      corrupt: window.__corrupt,
      calls: info.render.calls,
      tris: +(info.render.triangles / 1e6).toFixed(2),
    };
  }, alt);
  rows.push({ alt, ...r });
  console.log(`  ${String(alt).padStart(4)} m · near ${String(r.near).padStart(3)} chunks (${String(r.nearInst).padStart(5)} full-detail trees) · far ${String(r.far).padStart(3)} · ${r.calls} calls · ${r.tris}M tris`);
  console.log(`         far pools ${JSON.stringify(r.pools)}`);
}

const ground = rows[0];
const air = rows[rows.length - 1];
for (const r of rows) {
  if (r.negative) failures.push(`${r.alt} m: ${r.negative} far pool(s) with a negative instance count`);
  if (r.corrupt) failures.push(`${r.alt} m: ${r.corrupt} pool slot(s) freed twice`);
  if (r.canopy < 0.05) failures.push(`${r.alt} m: no painted canopy reached the terrain (max ${r.canopy})`);
}
if (ground.nearInst < 200) failures.push(`no full-detail trees on the ground (${ground.nearInst})`);
// The whole point of the altitude tier: from 600 m nothing should still be
// carrying full-detail geometry, and the bill should fall with it.
if (air.nearInst > 0) failures.push(`still ${air.nearInst} full-detail trees at ${air.alt} m`);
if (air.calls >= ground.calls) failures.push(`draw calls did not fall with altitude (${ground.calls} -> ${air.calls})`);
if (air.tris >= ground.tris) failures.push(`triangles did not fall with altitude (${ground.tris}M -> ${air.tris}M)`);

for (const e of [...new Set(errors)].slice(0, 10)) failures.push(e);
await browser.close();

if (failures.length) {
  console.error('\nflight: FAILED');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\nflight: passed');

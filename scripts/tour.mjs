// Walk the whole world, not just the bit you woke up in.
//
// The smoke test boots the game where the player spawns and never leaves. Most
// of what this world contains - a lighthouse, a temple, a sand sea, a glacier,
// an airstrip with an aeroplane on it - is somewhere else entirely, and the
// code that builds it never runs. This teleports to one example of every
// landmark kind and every biome it can find, streams the world in around each
// one, and fails on any page error.
//
//   npm run build && npm run preview
//   node scripts/tour.mjs [seed]
//
// Exits non-zero if anything threw, so it can gate a deploy.

const URL = (process.env.SMOKE_URL || 'http://127.0.0.1:4173/');
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
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/WebGL|GPU stall|deprecat/i.test(m.text())) {
    errors.push('console: ' + m.text().slice(0, 300));
  }
});

console.log(`tour: ${URL}?seed=${SEED}`);
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
  console.error('tour: the world never started');
  await browser.close();
  process.exit(1);
}

/* --------------------------------------------- find one of everything ---- */

const plan = await page.evaluate(() => {
  const wg = window.__game.world.wg;
  const sites = new Map();
  const biomes = new Map();
  const s = {};
  // A coarse spiral out from the origin. Cheap: the oracle is pure maths.
  // Climate belts are continental, so this has to reach a long way out: at the
  // old 21 km the spiral simply never left the region it started in.
  for (let i = 0; i < 60000 && (sites.size < 24 || biomes.size < 30); i++) {
    const a = i * 2.399963;
    const r = 620 * Math.sqrt(i);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    for (const st of wg.sitesNear(x, z, 700)) {
      if (!sites.has(st.kind)) sites.set(st.kind, { x: st.x, z: st.z, what: st.name, site: true });
    }
    wg.sample(x, z, s);
    if (s.height > 0.5 && !biomes.has(s.biome)) biomes.set(s.biome, { x, z, what: 'biome ' + s.biome });
  }
  return { sites: [...sites.values()], biomes: [...biomes.values()] };
});

const stops = [...plan.sites, ...plan.biomes];
console.log(`tour: ${plan.sites.length} landmark kinds, ${plan.biomes.length} biomes, ${stops.length} stops`);

/* ------------------------------------------------------------- visit ----- */

let visited = 0;
const failures = [];
for (const stop of stops) {
  const r = await page.evaluate(([x, z]) => {
    const g = window.__game;
    const w = g.world;
    const before = g.errors.count;
    try {
      w.player.position.set(x, w.terrain.heightAt(x, z) + 1.5, z);
      w.player.velocity.set(0, 0, 0);
      w.player.vehicle = null;
      // Force the quadtree to re-root here, then let everything that streams
      // off the player's position - flora, wildlife, districts, outposts,
      // railways - actually run.
      w.terrain.update(w.player.position, true);
      for (let i = 0; i < 90; i++) w.update(0.033);
      let pieces = 0;
      for (const o of w.civ.outposts.values()) pieces += o.pieces.length;
      return { ok: true, newErrors: g.errors.count - before, last: g.errors.last,
        outposts: w.civ.outposts.size, pieces, vehicles: w.civ.vehicles.length };
    } catch (e) {
      return { ok: false, err: e.message + ' @ ' + (e.stack || '').split('\n')[1] };
    }
  }, [stop.x, stop.z]);
  visited++;
  const where = `${stop.what} @ ${stop.x | 0},${stop.z | 0}`;
  if (!r.ok) failures.push(`${where}: threw ${r.err}`);
  else if (r.newErrors > 0) failures.push(`${where}: ${r.newErrors} frame errors — ${r.last}`);
  // A landmark that streams in but builds nothing is a silent failure, and
  // the whole point of walking out here is to catch exactly that.
  else if (stop.site && r.pieces === 0) failures.push(`${where}: built no pieces`);
  if (stop.site) console.log(`  ${stop.what.padEnd(22)} ${String(r.pieces).padStart(5)} pieces · ${r.vehicles} vehicles`);
}

console.log(`tour: visited ${visited} places`);

/* -------------------------------------------------- can it actually fly? -- */

const strip = plan.sites.find((v) => v.what === 'airstrip');
if (!strip) {
  console.log('tour: no airstrip within range of the spiral, skipping the flight check');
} else {
  const flight = await page.evaluate(([x, z]) => {
    const g = window.__game;
    const w = g.world;
    w.player.position.set(x, w.terrain.heightAt(x, z) + 1.5, z);
    w.terrain.update(w.player.position, true);
    for (let i = 0; i < 60; i++) w.update(0.033);
    const plane = w.civ.vehicles.find((v) => v.kind === 'plane');
    if (!plane) return { found: false };
    w.player.vehicle = plane;
    plane.start();
    const y0 = plane.position.y;
    const ground0 = w.terrain.heightAt(plane.position.x, plane.position.z);
    // Fly it the way a person would: hold it straight to rotation speed, ease
    // the nose up, then settle into a shallow climb. Holding full back stick
    // just makes it stall, climb, stall - which is correct, and useless as a
    // test of whether it flies.
    let maxAgl = 0;
    let maxSpeed = 0;
    let travelled = 0;
    let lx = plane.position.x, lz = plane.position.z;
    for (let i = 0; i < 1200; i++) {
      const t = i * 0.033;
      plane.power = 1;
      plane.elevator = t < 8 ? 0 : t < 10.5 ? 0.6 : 0.07;
      w.update(0.033);
      travelled += Math.hypot(plane.position.x - lx, plane.position.z - lz);
      lx = plane.position.x;
      lz = plane.position.z;
      maxSpeed = Math.max(maxSpeed, plane.speed);
      maxAgl = Math.max(maxAgl, plane.position.y - w.terrain.heightAt(plane.position.x, plane.position.z));
    }
    return {
      found: true, fuelled: plane.tank.litres > 1, engineOn: plane.engineOn,
      maxSpeed: +maxSpeed.toFixed(1), maxAgl: +maxAgl.toFixed(1),
      travelled: +travelled.toFixed(0),
      alive: plane.alive, stillDriven: w.player.vehicle === plane,
    };
  }, [strip.x, strip.z]);

  if (!flight.found) failures.push('airstrip had no aeroplane on it');
  else {
    console.log(`tour: flight — ${flight.maxSpeed} m/s, climbed to ${flight.maxAgl} m, flew ${flight.travelled} m`);
    if (!flight.engineOn) failures.push('the aeroplane would not start');
    if (flight.maxSpeed < 32) failures.push(`the aeroplane never got up to speed (${flight.maxSpeed} m/s)`);
    if (flight.maxAgl < 60) failures.push(`the aeroplane never left the ground (${flight.maxAgl} m)`);
    // Loose on purpose: the strip this finds is somewhere different on every
    // seed, so the climb profile varies with the ground it takes off over.
    // What is being asserted is powered flight over a real distance, not a
    // repeatable number.
    if (flight.travelled < 950) failures.push(`the aeroplane went nowhere (${flight.travelled} m)`);
    if (!flight.alive) failures.push('the aeroplane destroyed itself');
    if (!flight.stillDriven) failures.push('the aeroplane vanished out from under the player');
  }
}
for (const e of [...new Set(errors)].slice(0, 10)) failures.push(e);
await browser.close();

if (failures.length) {
  console.error('\ntour: FAILED');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\ntour: passed');

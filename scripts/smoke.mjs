// Pre-flight check before pushing to a live game.
//
// Boots the real thing in headless Chromium, steps through the title screen,
// drives the simulation forward and fails on any page error. It does not judge
// how it looks - take a screenshot for that - but it does catch the whole class
// of "compiles fine, throws on the first frame" mistakes.
//
//   npm i -D playwright-core
//   npm run dev            # or: npm run build && npm run preview
//   npm run smoke          # optionally: npm run smoke -- http://127.0.0.1:4173
//
// Exits non-zero if anything is wrong, so it can gate a deploy.

const URL = process.argv[2] || process.env.SMOKE_URL || 'http://127.0.0.1:5173/';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch (e) {
  console.error('smoke: playwright-core is not installed.  npm i -D playwright-core');
  process.exit(2);
}

const fail = [];
const note = (m) => console.log('  ' + m);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
}).catch((e) => {
  console.error('smoke: could not launch chromium at ' + CHROME + '\n' + e.message);
  process.exit(2);
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/WebGL|GPU stall|deprecat/i.test(m.text())) {
    errors.push('console: ' + m.text().slice(0, 300));
  }
});

console.log('smoke: ' + URL);
try {
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
} catch (e) {
  console.error('smoke: could not reach ' + URL + ' - is the dev server running?');
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(2500);

if (!(await page.$('#begin'))) fail.push('title screen never appeared');
await page.click('#begin');

// Pointer lock must be granted by the click itself, not by anything later.
const lockedImmediately = await page.evaluate(() => !!document.pointerLockElement);
if (!lockedImmediately) fail.push('pointer lock was not granted by the start click');
note('pointer lock on start click: ' + lockedImmediately);

// Software rendering needs a long time to compile shaders and stream terrain.
note('waiting for the world (software rendering is slow) ...');
let ready = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  ready = await page.evaluate(() => !!(window.__game && window.__game.running));
  if (ready) break;
}
if (!ready) fail.push('the world never started running');

if (ready) {
  // Drive the simulation directly: at software-rendering frame rates, waiting
  // for it to happen on its own would take an hour.
  const sim = await page.evaluate(() => {
    const g = window.__game;
    const w = g.world;
    let err = null;
    try {
      for (let i = 0; i < 900; i++) w.update(0.033);
    } catch (e) {
      err = e.message + ' @ ' + (e.stack || '').split('\n')[1];
    }
    const r = g.engine.renderer.info;
    return {
      err,
      frameErrors: g.errors.count,
      lastError: g.errors.last,
      hours: +w.sky.hours.toFixed(2),
      animals: w.wildlife.animals.length,
      chunks: w.terrain.chunksLoaded,
      trees: w.flora.barkPools.reduce((a, p) => a + (p ? p.mesh.count : 0), 0),
      calls: r.render.calls,
      tris: r.render.triangles,
      pixels: g.engine.shadedPixels,
    };
  });

  if (sim.err) fail.push('world.update threw: ' + sim.err);
  if (sim.frameErrors > 0) fail.push(sim.frameErrors + ' frame errors: ' + sim.lastError);
  if (sim.chunks < 8) fail.push('terrain barely loaded (' + sim.chunks + ' chunks)');
  if (sim.animals < 10) fail.push('wildlife did not populate (' + sim.animals + ' animals)');
  if (sim.calls > 700) fail.push('draw calls over budget: ' + sim.calls);
  if (sim.tris > 8e6) fail.push('triangles over budget: ' + (sim.tris / 1e6).toFixed(1) + 'M');

  note(`terrain ${sim.chunks} chunks · ${sim.trees} trees · ${sim.animals} animals`);
  note(`clock reached ${sim.hours.toFixed(2)}h after 30s of simulation`);
  note(`${sim.calls} draw calls · ${(sim.tris / 1e6).toFixed(2)}M triangles · ${(sim.pixels / 1e6).toFixed(1)}M pixels`);
}

for (const e of [...new Set(errors)].slice(0, 10)) fail.push(e);
await browser.close();

if (fail.length) {
  console.error('\nsmoke: FAILED');
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\nsmoke: passed');

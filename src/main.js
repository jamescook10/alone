// Boot.

import { Engine } from './core/engine.js';
import { World } from './world/world.js';
import { Input } from './player/input.js';
import { UI } from './ui/hud.js';
import { Audio } from './audio/audio.js';
import { WorldGen } from './world/worldgen.js';
import { clamp } from './core/noise.js';

const canvas = document.getElementById('view');
const uiRoot = document.getElementById('ui');

/* --------------------------------------------------------------- the seed */

function seedFromString(s) {
  s = (s || '').trim();
  if (!s) return (Math.random() * 0xffffffff) >>> 0;
  if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0) || 1;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const params = new URLSearchParams(location.search);
let seedText = params.get('seed') || '';
let seed = seedFromString(seedText);

/* ------------------------------------------------------------ title screen */

const title = document.createElement('div');
title.id = 'title';
title.innerHTML = `
  <h1>ALONE</h1>
  <div class="tag">an endless quiet world</div>
  <div class="seedline">
    <span>world</span>
    <input id="seedin" value="${escapeHtml(seedText)}" placeholder="anything at all" spellcheck="false" />
    <span id="seedval"></span>
  </div>
  <button class="btn" id="begin">step outside</button>
  <div class="hint">
    <b>W A S D</b> walk &nbsp;·&nbsp; <b>Shift</b> run &nbsp;·&nbsp; <b>Space</b> jump &nbsp;·&nbsp; <b>Mouse</b> look<br />
    <b>E</b> use what is in front of you &nbsp;·&nbsp; <b>Q</b> second action &nbsp;·&nbsp; <b>1–9</b> what you hold<br />
    <b>F</b> drift &nbsp;·&nbsp; <b>J</b> journal &nbsp;·&nbsp; <b>P</b> photo &nbsp;·&nbsp; <b>Esc</b> pause<br />
    <span style="opacity:.72">Everything is generated as you go. Nothing here wants anything from you.<br />
    Best with headphones — the sound is fully three-dimensional.</span>
  </div>
  <div id="loading">preparing the world</div>
`;
uiRoot.appendChild(title);

const seedIn = title.querySelector('#seedin');
const seedVal = title.querySelector('#seedval');
const updateSeedVal = () => {
  seed = seedFromString(seedIn.value);
  seedVal.textContent = '#' + seed.toString(36);
};
seedIn.addEventListener('input', updateSeedVal);
updateSeedVal();

/* ------------------------------------------------------------------- start */

let engine = null;
let world = null;
let input = null;
let ui = null;
let audio = null;
let started = false;
let frame = 0;
let fps = 0;
let last = performance.now();

title.querySelector('#begin').addEventListener('click', () => start());
seedIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});

function start() {
  if (started) return;
  started = true;
  seed = seedFromString(seedIn.value);
  const loading = title.querySelector('#loading');
  loading.textContent = 'finding somewhere to begin';

  // Give the browser a frame to paint the message before we do the work.
  requestAnimationFrame(() => setTimeout(() => boot(loading), 16));
}

function boot(loading) {
  engine = new Engine(canvas);
  input = new Input(canvas);

  const wg = new WorldGen(seed);
  const spawn = wg.findSpawn();

  world = new World(engine, seed, { spawn, dayLength: 1500, startTime: 0.315 });
  world.input = input;
  world.wgPreview = wg;

  ui = new UI(world, engine, {});
  world.ui = ui;
  ui._buildHotbar();

  audio = new Audio(world);
  world.audio = audio;
  audio.resume();

  // Losing the pointer pauses - which is what you want if you tab away - but
  // only once we have actually held it. A browser that refuses the very first
  // lock request must not leave the world frozen.
  let hadLock = false;
  input.onLockChange = (locked) => {
    if (locked) {
      hadLock = true;
      return;
    }
    if (hadLock && running && !world.paused && !ui.photo) ui.togglePause();
  };

  world.note('You are the only one here.', 'event');
  world.note(`This world is #${seed.toString(36)}. It has always been here.`, 'note');

  loading.textContent = 'growing the world';

  // Wait until enough ground exists that you do not fall through it.
  const waitForGround = () => {
    world.terrain.update(world.player.position);
    if (world.terrain.chunksLoaded > 8) {
      const h = world.terrain.heightAt(world.player.position.x, world.player.position.z);
      world.player.position.y = h + 0.5;
      title.classList.add('gone');
      setTimeout(() => title.remove(), 1800);
      ui.showHud(true);
      ui.fade(1, 2.6);
      input.requestLock();
      running = true;
    } else {
      setTimeout(waitForGround, 90);
    }
  };
  setTimeout(waitForGround, 60);
  requestAnimationFrame(loop);
}

/* -------------------------------------------------------------- main loop */

let running = false;
let smoothed = 60;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25; // a tab that was hidden should not teleport you
  dt = Math.min(dt, 0.05);
  frame++;
  smoothed = smoothed * 0.94 + (1 / Math.max(0.001, dt)) * 0.06;
  fps = smoothed;

  if (!world) return;

  /* global keys */
  if (input) {
    if (input.hit('Escape')) ui.togglePause();
    if (input.hit('KeyJ')) ui.toggleJournal();
    if (input.hit('KeyP')) ui.togglePhoto();
    if (input.hit('KeyM') && audio) {
      audio.enabled = !audio.enabled;
      audio.setVolume(audio.enabled ? 0.85 : 0);
      ui.toast(audio.enabled ? 'sound on' : 'sound off');
    }
    if (input.hit('KeyO')) {
      // Cycle the weather, for when you want a particular sky.
      const order = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'];
      cycleWeather = (cycleWeather + 1) % order.length;
      world.weather.force(order[cycleWeather]);
      ui.toast(order[cycleWeather]);
    }
    if (input.hit('BracketLeft')) world.sky.time = (world.sky.time + 0.955) % 1;
    if (input.hit('BracketRight')) world.sky.time = (world.sky.time + 0.045) % 1;
  }

  // A single bad frame should never be able to freeze the world.
  try {
    if (running) world.update(dt);
    else world.terrain.update(world.player.position);
  } catch (err) {
    errorCount++;
    if (errorCount < 4) console.error('frame error', err);
    lastError = err;
  }

  ui.update(dt);
  engine.render(dt);
  if (input) input.endFrame();

  // Adapt quality if the machine is struggling, so nobody has to think about it.
  if (frame % 180 === 0 && running) autoQuality();
}

let cycleWeather = 0;
let qualityStep = 0;
let errorCount = 0;
let lastError = null;

function autoQuality() {
  if (qualityStep >= 3) return;
  if (smoothed > 26) return;
  qualityStep++;
  if (qualityStep === 1) engine.setQuality({ pixelRatio: Math.max(0.7, engine.quality.pixelRatio * 0.75) });
  else if (qualityStep === 2) engine.setQuality({ bloom: false });
  else engine.setQuality({ shadows: false });
  ui.toast('eased the graphics a little');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.__game = {
  get engine() { return engine; },
  get world() { return world; },
  get cam() { return engine && engine.camera; },
  get frame() { return frame; },
  get fps() { return fps; },
  get ui() { return ui; },
  get running() { return running; },
  get errors() { return { count: errorCount, last: lastError && (lastError.message + '\n' + lastError.stack) }; },
  start,
};

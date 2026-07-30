// The interface stays out of the way. A dot, a line of text when something is
// within reach, and a quiet corner that tells you where and when you are.

import { BIOME_INFO, SETTLEMENT_INFO } from '../world/worldgen.js';
import { ITEMS } from '../player/inventory.js';
import { clamp, lerp } from '../core/noise.js';

const HELP = [
  ['W A S D', 'walk'],
  ['Shift', 'run · fly much faster'],
  ['Ctrl / C', 'crouch · descend in flight'],
  ['Space', 'jump · swim up · brake'],
  ['Mouse', 'look'],
  ['E / Left click', 'use what is in front of you'],
  ['Q / Right click', 'second action · eat · drink'],
  ['1 – 9 / , .', 'choose what you are holding'],
  ['Wheel', 'zoom the camera in and out'],
  ['Tab', 'menu — inventory and settings'],
  ['F', 'fly (and land again) · leave a vehicle'],
  ['B', 'raise or drop a bulldozer blade'],
  ['H', 'horn'],
  ['J', 'journal'],
  ['P', 'photo mode'],
  ['M', 'mute'],
  ['O', 'cycle the weather'],
  ['[ ]', 'wind time back and forward'],
  ['Esc', 'release the mouse — click to take it back'],
];

export class UI {
  constructor(world, engine, opts = {}) {
    this.world = world;
    this.engine = engine;
    this.root = document.getElementById('ui');
    this.onBegin = opts.onBegin || (() => {});
    this.fadeAmount = 0;
    this.fadeTarget = 0;
    this.fadeSpeed = 1;
    this.toasts = [];
    this.photo = false;
    this._t = 0;
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <div id="hud">
        <div id="crosshair"></div>
        <div id="prompt"></div>
        <div id="compass"><div class="ticks"></div></div>
        <div id="place"></div>
        <div id="status"></div>
        <div id="vitals">
          <div class="bar breath"><i style="width:100%"></i></div>
          <div class="bar warmth"><i style="width:100%"></i></div>
          <div class="bar energy"><i style="width:100%"></i></div>
        </div>
        <div id="held"><span class="cur"></span><span class="menuhint"><b>Tab</b> menu</span></div>
        <div id="toast"></div>
        <div id="discovery"><div class="big"></div><div class="sub"></div></div>
      </div>
      <div id="capture" class="hidden"><span>click to look around</span></div>
      <div id="journal" class="panel hidden"><div class="inner">
        <h2>Journal</h2>
        <div class="list"></div>
        <button class="btn close">close</button>
      </div></div>
      <div id="pause" class="panel hidden"><div class="inner">
        <h2>Alone</h2>
        <h3>Carrying</h3>
        <div class="inv"></div>
        <h3>Controls</h3>
        <div class="keys">${HELP.map(([k, v]) => `<div class="row"><b>${k}</b><span>${v}</span></div>`).join('')}</div>
        <h3>This world</h3>
        <div class="row"><span>seed</span><b class="seed"></b></div>
        <div class="row"><span>walked</span><b class="walked"></b></div>
        <div class="row"><span>highest point</span><b class="high"></b></div>
        <div class="row"><span>deepest point</span><b class="deep"></b></div>
        <div class="row"><span>days passed</span><b class="days"></b></div>
        <h3>Comfort</h3>
        <div class="row"><span class="toggle" data-t="shadows">shadows</span><b class="v-shadows"></b></div>
        <div class="row"><span class="toggle" data-t="fardraw">draw distance</span><b class="v-fardraw"></b></div>
        <div class="row"><span class="toggle" data-t="look">look speed</span><b class="v-look"></b></div>
        <div class="row"><span class="toggle" data-t="sound">sound</span><b class="v-sound"></b></div>
        <div class="row"><span class="toggle" data-t="res">resolution</span><b class="v-res"></b></div>
        <div class="row"><span class="toggle" data-t="fullscreen">fullscreen</span><b class="v-fullscreen"></b></div>
        <div class="row"><span>drawing</span><b class="v-perf"></b></div>
        <button class="btn close">continue</button>
      </div></div>
      <div id="photomode" class="hidden"></div>
    `;
    this.hud = this.root.querySelector('#hud');
    this.crosshair = this.root.querySelector('#crosshair');
    this.promptEl = this.root.querySelector('#prompt');
    this.placeEl = this.root.querySelector('#place');
    this.statusEl = this.root.querySelector('#status');
    this.compassEl = this.root.querySelector('#compass .ticks');
    this.heldEl = this.root.querySelector('#held .cur');
    this.invList = this.root.querySelector('#pause .inv');
    this.toastEl = this.root.querySelector('#toast');
    this.discoveryEl = this.root.querySelector('#discovery');
    this.journalEl = this.root.querySelector('#journal');
    this.journalList = this.root.querySelector('#journal .list');
    this.pauseEl = this.root.querySelector('#pause');
    this.photoEl = this.root.querySelector('#photomode');
    this.captureEl = this.root.querySelector('#capture');
    this.fps = 0;
    this.vitals = {
      breath: this.root.querySelector('.bar.breath i'),
      warmth: this.root.querySelector('.bar.warmth i'),
      energy: this.root.querySelector('.bar.energy i'),
    };

    for (const b of this.root.querySelectorAll('.btn.close')) {
      b.addEventListener('click', () => {
        this.journalEl.classList.add('hidden');
        this.pauseEl.classList.add('hidden');
        this.world.paused = false;
        if (this.world.input) this.world.input.requestLock();
      });
    }
    for (const t of this.root.querySelectorAll('.toggle')) {
      t.addEventListener('click', () => this._toggle(t.dataset.t));
    }
    this._buildCompass();
    this._refreshSettings();
  }

  _buildCompass() {
    const marks = [];
    for (let d = 0; d < 360; d += 15) {
      const label = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[d];
      marks.push(`<span class="t ${label ? 'card' : ''}" data-d="${d}">${label || '·'}</span>`);
    }
    this.compassEl.innerHTML = marks.join('');
    this.compassMarks = [...this.compassEl.querySelectorAll('.t')];
  }

  /** The inventory lives in the Tab menu; rebuilt each time it opens. */
  _buildInventory() {
    const inv = this.world.inventory;
    if (!inv) return;
    this.invList.innerHTML = inv.slots
      .map((s, i) => {
        const item = ITEMS[s.key] || { icon: '?', name: s.key };
        return `<div class="irow ${i === inv.selected ? 'sel' : ''} ${s.n > 0 ? '' : 'empty'}" data-i="${i}">
          <b class="key">${i < 9 ? i + 1 : ''}</b><span class="icon">${item.icon}</span>
          <span class="name">${inv.label(s)}</span><span class="cnt">${s.n > 1 ? '× ' + s.n : ''}</span>
        </div>`;
      })
      .join('');
    for (const el of this.invList.querySelectorAll('.irow')) {
      el.addEventListener('click', () => {
        inv.select(+el.dataset.i);
        this._buildInventory();
      });
    }
  }

  _toggle(which) {
    const e = this.engine;
    const q = e.quality;
    switch (which) {
      case 'shadows': e.setQuality({ shadows: !q.shadows }); break;
      case 'fardraw': e.setQuality({ farK: q.farK < 1 ? 1 : 0.3 }); break;
      case 'look': {
        const inp = this.world.input;
        if (!inp) break;
        const steps = [0.5, 0.75, 1, 1.5, 2, 3];
        const i = steps.findIndex((v) => v > inp.lookSpeed + 0.01);
        inp.setLookSpeed(i < 0 ? steps[0] : steps[i]);
        break;
      }
      case 'sound':
        if (this.world.audio) {
          this.world.audio.enabled = !this.world.audio.enabled;
          this.world.audio.setVolume(this.world.audio.enabled ? 0.85 : 0);
        }
        break;
      case 'res': {
        // Step up to native device resolution and no further - supersampling
        // buys nothing on flat shading.
        const steps = [0.7, 0.85, 1.0, Math.min(window.devicePixelRatio || 1, 2)];
        const uniq = [...new Set(steps.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
        const i = uniq.findIndex((v) => v > q.pixelRatio + 0.01);
        e.setQuality({ pixelRatio: i < 0 ? uniq[0] : uniq[i] });
        break;
      }
      case 'fullscreen': {
        if (document.fullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen();
        } else if (document.documentElement.requestFullscreen) {
          const r = document.documentElement.requestFullscreen();
          if (r && r.catch) r.catch(() => {});
        }
        break;
      }
    }
    this._refreshSettings();
  }

  _refreshSettings() {
    const e = this.engine;
    const set = (cls, v) => {
      const el = this.root.querySelector('.v-' + cls);
      if (el) el.textContent = v;
    };
    set('shadows', e.quality.shadows ? 'on' : 'off');
    set('fardraw', e.quality.farK < 1 ? 'near' : 'far');
    set('look', this.world.input ? this.world.input.lookSpeed.toFixed(2).replace(/\.?0+$/, '') + '×' : '—');
    set('sound', this.world.audio && this.world.audio.enabled ? 'on' : 'off');
    set('res', e.quality.pixelRatio.toFixed(2) + '×');
    set('fullscreen', document.fullscreenElement ? 'on' : 'off');
    set('perf', `${(e.shadedPixels / 1e6).toFixed(1)}M px · ${this.fps.toFixed(0)} fps`);
  }

  /* ------------------------------------------------------------- messages */

  onJournal(entry) {
    if (entry.kind !== 'note' || Math.random() < 0.85) this.toast(entry.text);
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `<span>day ${entry.day + 1}, ${fmtTime(entry.time)}</span>${entry.text}`;
    this.journalList.prepend(row);
    while (this.journalList.children.length > 220) this.journalList.lastChild.remove();
    if (this.world.audio && entry.kind === 'discovery') this.world.audio.music.cue('discovery');
  }

  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.innerHTML = text;
    this.toastEl.appendChild(el);
    const item = { el, t: 4.2 + Math.min(3, text.length * 0.03) };
    this.toasts.push(item);
    while (this.toasts.length > 4) {
      const old = this.toasts.shift();
      old.el.remove();
    }
  }

  discovery(name, sub) {
    this.discoveryEl.querySelector('.big').textContent = name;
    this.discoveryEl.querySelector('.sub').textContent = sub;
    this.discoveryEl.classList.remove('show');
    void this.discoveryEl.offsetWidth;
    this.discoveryEl.classList.add('show');
  }

  fade(amount, seconds = 1) {
    this.fadeAmount = amount;
    this.fadeTarget = 0;
    this.fadeSpeed = 1 / Math.max(0.05, seconds);
  }

  showHud(on) {
    this.hud.classList.toggle('on', on);
  }

  /** The quiet line that tells you the mouse is loose. */
  setCaptureHint(on) {
    if (this._capture === on) return;
    this._capture = on;
    this.captureEl.classList.toggle('hidden', !on);
  }

  togglePause() {
    const showing = !this.pauseEl.classList.contains('hidden');
    this.pauseEl.classList.toggle('hidden', showing);
    this.world.paused = !showing;
    if (!showing) {
      const p = this.world.player;
      this.root.querySelector('.seed').textContent = this.world.seed;
      this.root.querySelector('.walked').textContent = fmtDist(p.distanceWalked);
      this.root.querySelector('.high').textContent = `${p.highestPoint.toFixed(0)} m`;
      this.root.querySelector('.deep').textContent = `${p.deepestPoint.toFixed(0)} m`;
      this.root.querySelector('.days').textContent = (this.world.sky.day + 1).toString();
      this._buildInventory();
      this._refreshSettings();
      if (this.world.input) this.world.input.exitLock();
    } else if (this.world.input) {
      this.world.input.requestLock();
    }
    return !showing;
  }

  toggleJournal() {
    const showing = !this.journalEl.classList.contains('hidden');
    this.journalEl.classList.toggle('hidden', showing);
    this.world.paused = !showing;
    if (!showing && this.world.input) this.world.input.exitLock();
    else if (this.world.input) this.world.input.requestLock();
  }

  togglePhoto() {
    this.photo = !this.photo;
    this.photoEl.classList.toggle('hidden', !this.photo);
    this.hud.style.opacity = this.photo ? '0' : '';
    const g = this.engine.grade.uniforms;
    g.uVignette.value = this.photo ? 0.52 : 0.40;
    return this.photo;
  }

  /* --------------------------------------------------------------- update */

  update(dt) {
    this._t += dt;
    const w = this.world;
    const p = w.player;

    // Prompt.
    const inter = w.interaction;
    const prompt = inter ? inter.prompt : '';
    const secondary = inter ? inter.secondary : '';
    if (prompt !== this._lastPrompt || secondary !== this._lastSecondary) {
      this._lastPrompt = prompt;
      this._lastSecondary = secondary;
      this.promptEl.innerHTML = prompt + (secondary ? `<div style="opacity:.6;font-size:11.5px;margin-top:5px">${secondary}</div>` : '');
      this.promptEl.classList.toggle('on', !!(prompt || secondary));
      this.crosshair.classList.toggle('active', !!prompt);
    }

    // Place and conditions, refreshed a few times a second.
    if (this._t > 0.22) {
      this._t = 0;
      const s = w.terrain.sampleAt(p.position.x, p.position.z);
      const town = s.town;
      const biome = BIOME_INFO[s.biome].name;
      this.placeEl.innerHTML = town
        ? `${town.name}<small>${SETTLEMENT_INFO[town.kind].name} · ${biome}</small>`
        : `${biome}<small>${p.underwater ? 'below the surface' : w.sky.timeName}</small>`;

      const alt = p.position.y;
      this.statusEl.innerHTML = [
        `<span class="k">time</span>${fmtTime(w.sky.hours)} · day ${w.sky.day + 1}`,
        `<span class="k">sky</span>${w.weather.name}`,
        `<span class="k">air</span>${p.temperature.toFixed(0)}°C`,
        `<span class="k">altitude</span>${alt > 0 ? alt.toFixed(0) : alt.toFixed(0)} m`,
        `<span class="k">bearing</span>${fmtBearing(p.heading)}`,
        `<span class="k">frames</span>${this.fps.toFixed(0)} fps`,
      ].join('<br>');

      this.vitals.breath.style.width = `${p.breath * 100}%`;
      this.vitals.warmth.style.width = `${p.warmth * 100}%`;
      this.vitals.energy.style.width = `${p.energy * 100}%`;
      this.root.querySelector('.bar.breath').style.opacity = p.breath < 0.999 ? '1' : '0.18';
      this.root.querySelector('.bar.warmth').style.opacity = p.warmth < 0.9 ? '1' : '0.18';
      this.root.querySelector('.bar.energy').style.opacity = p.energy < 0.9 ? '1' : '0.18';

    }

    // What you are holding — one quiet line where the hotbar used to be.
    const inv = w.inventory;
    if (inv) {
      const slot = inv.current;
      const item = ITEMS[slot.key] || { icon: '?', name: slot.key };
      const txt = slot.n > 0
        ? `${item.icon} ${inv.label(slot)}${slot.n > 1 ? ` × ${slot.n}` : ''}`
        : `${item.icon} ${item.name} — none left`;
      if (txt !== this._heldTxt) {
        this._heldTxt = txt;
        this.heldEl.textContent = txt;
        this.heldEl.style.opacity = slot.n > 0 ? '' : '0.45';
      }
    }

    // Compass ribbon.
    const heading = p.heading;
    const width = this.compassEl.parentElement.clientWidth;
    for (const m of this.compassMarks) {
      const d = +m.dataset.d;
      let rel = d - heading;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      if (Math.abs(rel) > 62) {
        m.style.display = 'none';
        continue;
      }
      m.style.display = '';
      m.style.left = `${width * 0.5 + (rel / 62) * width * 0.5}px`;
      m.style.opacity = `${1 - Math.abs(rel) / 70}`;
    }

    // Toasts.
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t -= dt;
      if (t.t < 0.85 && !t.fading) {
        t.fading = true;
        t.el.classList.add('fade');
      }
      if (t.t <= 0) {
        t.el.remove();
        this.toasts.splice(i, 1);
      }
    }

    // Screen fade.
    if (this.fadeAmount > 0.001) {
      this.fadeAmount = Math.max(0, this.fadeAmount - dt * this.fadeSpeed);
    }
    this.engine.grade.uniforms.uFade.value = this.fadeAmount;
  }
}

function fmtTime(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h % 1) * 60);
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}

function fmtBearing(d) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return `${names[Math.round(d / 22.5) % 16]} ${d.toFixed(0)}°`;
}

function fmtDist(m) {
  return m > 1200 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}

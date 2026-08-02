// The soundscape.
//
// Everything is synthesised and almost everything is placed in space with HRTF
// panning, which is why the game asks for headphones: a stream is genuinely to
// your left, a bird is genuinely above and behind you, and a distant fire moves
// across your head as you turn. Continuous layers (wind, water, rain, insects,
// fire, engines) run forever and are only ever re-mixed; short sounds are
// scheduled voices that clean themselves up.

import * as THREE from 'three';
import { noiseBuffer, pinkBuffer, impulseResponse, env, hz } from './synth.js';
import { Music } from './music.js';
import { BIOME } from '../world/worldgen.js';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';

const MAX_VOICES = 26;

// Anything with a closed canopy overhead sounds the same: close, damped, and
// with the high end eaten by leaves.
const FOREST_BIOMES = new Set([
  BIOME.FOREST, BIOME.RAINFOREST, BIOME.TAIGA, BIOME.DRY_FOREST,
  BIOME.CLOUD_FOREST, BIOME.BAMBOO, BIOME.MANGROVE, BIOME.SWAMP,
]);

export class Audio {
  constructor(world) {
    this.world = world;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.enabled = true;
    this.voices = 0;
    this.masterVolume = 0.85;

    /* --- master chain -------------------------------------------------- */
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.limiter);

    // A global filter that closes when you go underwater or indoors.
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.4;
    this.muffle.connect(this.master);

    this.dry = ctx.createGain();
    this.dry.connect(this.muffle);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 1;
    this.musicBus.connect(this.master); // music is not muffled underwater

    /* --- reverb -------------------------------------------------------- */
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = impulseResponse(ctx, { seconds: 2.8, decay: 2.4, damp: 0.42 });
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.muffle);
    this._irs = {
      outdoor: this.convolver.buffer,
      valley: impulseResponse(ctx, { seconds: 4.2, decay: 2.0, damp: 0.55, preDelay: 0.05 }),
      indoor: impulseResponse(ctx, { seconds: 0.85, decay: 3.4, damp: 0.28, preDelay: 0.006 }),
      forest: impulseResponse(ctx, { seconds: 1.9, decay: 3.2, damp: 0.62 }),
      water: impulseResponse(ctx, { seconds: 2.2, decay: 2.4, damp: 0.82 }),
    };
    this._currentIR = 'outdoor';

    this.noise = noiseBuffer(ctx, 2, 12345);
    this.pink = pinkBuffer(ctx, 5);

    this._buildAmbience();
    this.music = new Music(this);
    this.engines = new Map();
    this.fireVoices = new Map();
    this._tmpV = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._waterPos = new THREE.Vector3();
    this._t = 0;
    this._lastBirdT = 0;
    this._foot = 0;
  }

  resume() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.music.start();
  }

  setVolume(v) {
    this.masterVolume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  /* ------------------------------------------------------------- plumbing */

  reverbSendFrom(node, amount = 0.3) {
    const g = this.ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(this.reverbSend);
    return g;
  }

  /** A positioned output node. Everything spatial goes through one of these. */
  panner(x, y, z, refDist = 4, maxDist = 260, rolloff = 1.35) {
    const p = this.ctx.createPanner();
    p.panningModel = this.voices < 16 ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDist;
    p.maxDistance = maxDist;
    p.rolloffFactor = rolloff;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.setPosition(x, y, z);
    }
    return p;
  }

  movePanner(p, x, y, z, t = 0.05) {
    const now = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, now, t);
      p.positionY.setTargetAtTime(y, now, t);
      p.positionZ.setTargetAtTime(z, now, t);
    } else {
      p.setPosition(x, y, z);
    }
  }

  /** A short noise burst through a filter: the workhorse for impacts. */
  burst(opts) {
    if (!this.enabled || this.voices > MAX_VOICES) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = opts.buffer || this.noise;
    src.loop = true;
    src.playbackRate.value = opts.rate || 1;
    const filt = ctx.createBiquadFilter();
    filt.type = opts.type || 'bandpass';
    filt.frequency.value = opts.freq || 800;
    filt.Q.value = opts.q !== undefined ? opts.q : 1.2;
    const g = ctx.createGain();
    const attack = opts.attack !== undefined ? opts.attack : 0.004;
    const release = opts.release !== undefined ? opts.release : 0.16;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.gain !== undefined ? opts.gain : 0.3, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    if (opts.sweep) {
      filt.frequency.setValueAtTime(opts.freq, t);
      filt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.sweep), t + attack + release);
    }
    src.connect(filt);
    filt.connect(g);
    let out = g;
    if (opts.pos) {
      const p = this.panner(opts.pos[0], opts.pos[1], opts.pos[2], opts.refDist || 3, opts.maxDist || 300);
      g.connect(p);
      out = p;
    }
    out.connect(this.dry);
    this.reverbSendFrom(out, opts.reverb !== undefined ? opts.reverb : 0.22);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + release + 0.05);
    this.voices++;
    src.onended = () => {
      this.voices--;
      try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) {}
    };
    return { src, filt, gain: g, out };
  }

  /** A pitched tone, for animal calls and mechanical sounds. */
  tone(opts) {
    if (!this.enabled || this.voices > MAX_VOICES) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = opts.wave || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.glide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.glide), t + (opts.glideTime || opts.dur || 0.2));
    }
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = opts.vibrato;
      lg.gain.value = opts.vibratoDepth || opts.freq * 0.05;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + (opts.dur || 0.2) + 0.1);
    }
    const g = ctx.createGain();
    const dur = opts.dur || 0.2;
    const attack = opts.attack !== undefined ? opts.attack : 0.01;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.gain !== undefined ? opts.gain : 0.14, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    let out = g;
    if (opts.pos) {
      const p = this.panner(opts.pos[0], opts.pos[1], opts.pos[2], opts.refDist || 6, opts.maxDist || 400, 1.1);
      g.connect(p);
      out = p;
    }
    out.connect(this.dry);
    this.reverbSendFrom(out, opts.reverb !== undefined ? opts.reverb : 0.3);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      try { osc.disconnect(); g.disconnect(); } catch (e) {}
    };
    return { osc, gain: g, out };
  }

  /* ------------------------------------------------------------ ambience */

  _loop(buffer, gainValue, dest) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    src.connect(g);
    g.connect(dest);
    src.start(this.ctx.currentTime + Math.random() * 0.5);
    return { src, gain: g };
  }

  _buildAmbience() {
    const ctx = this.ctx;

    /* wind: three bands, spread around you --------------------------- */
    this.wind = { layers: [], gain: ctx.createGain() };
    this.wind.gain.gain.value = 0;
    this.wind.gain.connect(this.dry);
    this.reverbSendFrom(this.wind.gain, 0.18);
    const bands = [
      { freq: 320, q: 0.7, pan: -0.75, g: 0.55 },
      { freq: 780, q: 1.1, pan: 0.7, g: 0.35 },
      { freq: 130, q: 0.6, pan: 0.1, g: 0.8 },
    ];
    for (const b of bands) {
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = b.freq;
      filt.Q.value = b.q;
      const pan = ctx.createStereoPanner();
      pan.pan.value = b.pan;
      const g = ctx.createGain();
      g.gain.value = b.g;
      filt.connect(g);
      g.connect(pan);
      pan.connect(this.wind.gain);
      const l = this._loop(this.pink, 1, filt);
      l.src.playbackRate.value = 0.7 + Math.random() * 0.5;
      this.wind.layers.push({ filt, gain: g, base: b.freq, src: l.src });
    }

    /* a high whistle for exposed ridges and storms -------------------- */
    this.whistle = ctx.createGain();
    this.whistle.gain.value = 0;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 1900;
    wf.Q.value = 7;
    this._loop(this.pink, 0.5, wf);
    wf.connect(this.whistle);
    this.whistle.connect(this.dry);
    this.whistleFilter = wf;

    /* water: a moving source at the nearest water's edge --------------- */
    this.waterPanner = this.panner(0, 0, 0, 6, 220, 1.4);
    this.waterPanner.panningModel = 'HRTF';
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'bandpass';
    this.waterFilter.frequency.value = 700;
    this.waterFilter.Q.value = 0.55;
    this._loop(this.pink, 1.0, this.waterFilter);
    this.waterFilter.connect(this.waterGain);
    this.waterGain.connect(this.waterPanner);
    this.waterPanner.connect(this.dry);
    this.reverbSendFrom(this.waterPanner, 0.28);

    // A second water layer for surf: slow swells.
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0;
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 420;
    this._loop(this.pink, 1.0, sf);
    sf.connect(this.surfGain);
    this.surfGain.connect(this.dry);
    this.reverbSendFrom(this.surfGain, 0.34);
    this.surfFilter = sf;
    this._surfPhase = Math.random() * 6.28;

    /* rain ------------------------------------------------------------ */
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 2600;
    this.rainFilter.Q.value = 0.4;
    this._loop(this.noise, 1.0, this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.dry);
    this.reverbSendFrom(this.rainGain, 0.2);

    /* insects and night ------------------------------------------------ */
    this.insectGain = ctx.createGain();
    this.insectGain.gain.value = 0;
    this.insectGain.connect(this.dry);
    this.reverbSendFrom(this.insectGain, 0.3);

    /* underwater ------------------------------------------------------- */
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    const subf = ctx.createBiquadFilter();
    subf.type = 'lowpass';
    subf.frequency.value = 380;
    this._loop(this.pink, 1.0, subf);
    subf.connect(this.subGain);
    this.subGain.connect(this.master);

    /* room tone -------------------------------------------------------- */
    const rt = ctx.createBiquadFilter();
    rt.type = 'lowpass';
    rt.frequency.value = 90;
    this._loop(this.pink, 0.5, rt);
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0.05;
    rt.connect(this.roomGain);
    this.roomGain.connect(this.master);
  }

  /* ------------------------------------------------------------- one-shots */

  // The one sound you hear thousands of times, so it is mixed to sit under the
  // wind rather than on top of it. Three things made the old one tiring: it was
  // centred at 1.7-2.6 kHz, where hearing is most sensitive; it peaked 19-24 dB
  // above the ambience; and every step was identical, which the ear tracks as a
  // click track instead of habituating to.
  footstep(mat, force = 1) {
    const P = FOOT[mat] || FOOT.grass;
    // Feet alternate. Two slightly different steps read as a body walking; one
    // step repeated reads as a metronome, and a metronome is what you notice.
    this._foot ^= 1;
    const side = this._foot ? 1 : -1;
    const bias = this._foot ? 1.05 : 0.95;
    const level = P.gain * (0.30 + force * 0.75) * (0.80 + Math.random() * 0.40);
    // Placed at the ground, a little to one side, so a step happens at your
    // feet instead of in the middle of your head.
    const pos = this._footPos(side);
    this.burst({
      pos, refDist: 1.5, maxDist: 30,
      freq: P.freq * bias * (0.88 + Math.random() * 0.24),
      q: P.q, type: P.type || 'lowpass',
      gain: level,
      // Soft ground compresses under a foot, it does not click.
      attack: P.attack || 0.014,
      release: P.release * (0.85 + Math.random() * 0.30),
      rate: 0.85 + Math.random() * 0.30,
      reverb: 0.12,
    });
    // The bright part is what tells you what you are standing on, so it stays -
    // but quietly, and just after the body, which is the order a foot makes it.
    if (P.tex) {
      this.burst({
        pos, refDist: 1.5, maxDist: 30,
        freq: P.tex * (0.85 + Math.random() * 0.30), q: P.texQ || 0.9, type: 'bandpass',
        gain: level * P.texGain, attack: 0.006,
        release: P.texRel * (0.80 + Math.random() * 0.40),
        delay: 0.008 + Math.random() * 0.022, reverb: 0.12,
      });
    }
    if (mat === 'water') {
      this.burst({
        pos, refDist: 1.5, maxDist: 30, freq: 900, q: 0.6,
        gain: level * 0.55, release: 0.22, sweep: 300, delay: 0.01, reverb: 0.12,
      });
    }
  }

  /** Where a footfall happens: on the ground, a little to one side. */
  _footPos(side) {
    const p = this.world.player;
    if (!p) return null;
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    return [p.position.x + rx * 0.17 * side, p.position.y + 0.05, p.position.z + rz * 0.17 * side];
  }

  jump() {
    this.burst({ freq: 240, q: 1.4, gain: 0.10, release: 0.10 });
  }

  land(force, mat) {
    const P = FOOT[mat] || FOOT.grass;
    const pos = this._footPos(0);
    // Landing should still be a moment, just not one that arrives 12 dB above
    // the steps either side of it. The weight lives in the 80 Hz thump, which
    // is felt more than heard and does not fatigue.
    this.burst({ pos, refDist: 1.5, maxDist: 40, freq: P.freq * 0.8, type: 'lowpass', q: 0.7, gain: 0.17 * force + 0.05, attack: 0.006, release: 0.28 });
    this.burst({ pos, refDist: 1.5, maxDist: 40, freq: 85, type: 'lowpass', q: 0.5, gain: 0.20 * force, release: 0.24 });
  }

  swimStroke(under) {
    this.burst({
      freq: under ? 480 : 1100, q: 0.5, gain: under ? 0.10 : 0.15,
      release: 0.42, sweep: under ? 180 : 320, reverb: 0.4,
    });
  }

  impact(x, y, z, kind, force = 1) {
    const pos = [x, y, z];
    switch (kind) {
      case 'glass':
        for (let i = 0; i < 5; i++) {
          this.burst({ pos, freq: 3200 + Math.random() * 4200, q: 9, gain: 0.10 * force, release: 0.20, delay: i * 0.028 * Math.random(), reverb: 0.4 });
        }
        break;
      case 'metal':
        this.burst({ pos, freq: 340, q: 4.5, gain: 0.20 * force, release: 0.7, reverb: 0.45 });
        this.burst({ pos, freq: 1250, q: 8, gain: 0.10 * force, release: 0.5 });
        break;
      case 'wood':
        this.burst({ pos, freq: 190, q: 2.2, gain: 0.22 * force, release: 0.26 });
        this.burst({ pos, freq: 900, q: 1.5, gain: 0.09 * force, release: 0.09 });
        break;
      default:
        this.burst({ pos, freq: 150, q: 0.9, gain: 0.26 * force, release: 0.34, sweep: 70 });
        this.burst({ pos, freq: 2200, q: 0.6, gain: 0.07 * force, release: 0.16 });
    }
  }

  chop(x, y, z, fell) {
    const pos = [x, y, z];
    this.burst({ pos, freq: 420, q: 3, gain: 0.30, release: 0.16 });
    this.burst({ pos, freq: 1400, q: 1.2, gain: 0.14, release: 0.07 });
    if (fell) {
      // A creak, then a long crash.
      this.tone({ pos, freq: 180, glide: 90, dur: 1.4, gain: 0.09, wave: 'sawtooth', delay: 0.2 });
      for (let i = 0; i < 14; i++) {
        this.burst({
          pos, freq: 300 + Math.random() * 2400, q: 1.1,
          gain: 0.10 + Math.random() * 0.10, release: 0.3,
          delay: 1.3 + Math.random() * 1.1, reverb: 0.5,
        });
      }
    }
  }

  pick(x, y, z) {
    this.burst({ pos: [x, y, z], freq: 1700, q: 2.4, gain: 0.13, release: 0.07 });
    this.burst({ pos: [x, y, z], freq: 620, q: 3, gain: 0.08, release: 0.10, delay: 0.03 });
  }

  plant(x, y, z) {
    this.burst({ pos: [x, y, z], freq: 380, q: 0.9, gain: 0.16, release: 0.22, sweep: 160 });
  }

  pour(x, y, z, fill) {
    const pos = [x, y, z];
    for (let i = 0; i < 10; i++) {
      this.burst({
        pos, freq: (fill ? 900 : 1500) + Math.random() * 1600, q: 3,
        gain: 0.05, release: 0.09, delay: i * 0.055 + Math.random() * 0.03,
      });
    }
    this.burst({ pos, freq: 700, q: 0.6, gain: 0.10, release: 0.55, sweep: fill ? 1400 : 300 });
  }

  eat() {
    for (let i = 0; i < 3; i++) {
      this.burst({ freq: 800 + Math.random() * 900, q: 1.6, gain: 0.10, release: 0.10, delay: i * 0.13 });
    }
  }

  drink() {
    for (let i = 0; i < 3; i++) {
      this.burst({ freq: 260, q: 3.5, gain: 0.11, release: 0.14, delay: i * 0.28, sweep: 170 });
    }
  }

  door(x, y, z, open) {
    const pos = [x, y, z];
    this.tone({ pos, freq: open ? 320 : 260, glide: open ? 180 : 400, dur: 0.55, gain: 0.06, wave: 'sawtooth' });
    this.burst({ pos, freq: 220, q: 2, gain: 0.16, release: 0.2, delay: open ? 0.5 : 0.45 });
  }

  horn(pos) {
    const p = [pos.x, pos.y + 1, pos.z];
    this.tone({ pos: p, freq: 420, dur: 0.7, gain: 0.16, wave: 'square' });
    this.tone({ pos: p, freq: 315, dur: 0.7, gain: 0.14, wave: 'square' });
  }

  hiss(x, y, z) {
    this.burst({ pos: [x, y, z], freq: 4200, q: 0.5, gain: 0.20, attack: 0.02, release: 1.1, sweep: 1200 });
  }

  thunder(dist) {
    const near = clamp(1 - dist / 2600, 0, 1);
    const g = 0.30 + near * 0.55;
    // A crack for close strikes, and always a long rumble.
    if (near > 0.6) {
      this.burst({ freq: 2400, q: 0.4, gain: g * 0.7, attack: 0.001, release: 0.3, sweep: 200, reverb: 0.7 });
    }
    for (let i = 0; i < 7; i++) {
      this.burst({
        freq: 55 + Math.random() * 130, type: 'lowpass', q: 0.4,
        gain: g * (0.5 + Math.random() * 0.6) * (1 - i * 0.09),
        attack: 0.05 + Math.random() * 0.2,
        release: 1.6 + Math.random() * 2.4,
        delay: i * (0.18 + Math.random() * 0.4),
        rate: 0.4 + Math.random() * 0.3,
        reverb: 0.8,
      });
    }
    this.music.cue('note');
  }

  explosion(x, y, z, power = 1) {
    const pos = [x, y, z];
    this.burst({ pos, freq: 1800, q: 0.3, gain: 0.55 * power, attack: 0.001, release: 0.5, sweep: 90, reverb: 0.6, maxDist: 1400 });
    this.tone({ pos, freq: 120 * power, glide: 24, dur: 1.1, gain: 0.45 * power, wave: 'sine', attack: 0.002, maxDist: 1600 });
    for (let i = 0; i < 6; i++) {
      this.burst({
        pos, freq: 70 + Math.random() * 160, type: 'lowpass', q: 0.4,
        gain: 0.3 * power, attack: 0.02, release: 1.4 + Math.random() * 1.6,
        delay: 0.1 + i * 0.22, reverb: 0.85, maxDist: 2200,
      });
    }
    // Debris rattle.
    for (let i = 0; i < 12; i++) {
      this.burst({ pos, freq: 400 + Math.random() * 3000, q: 3, gain: 0.06, release: 0.12, delay: 0.25 + Math.random() * 1.4 });
    }
  }

  animalCall(kind, x, y, z, gain = 1) {
    const pos = [x, y, z];
    const g = gain * 0.9;
    switch (kind) {
      case 'songbird': {
        const n = 2 + Math.floor(Math.random() * 4);
        const base = 2400 + Math.random() * 2200;
        for (let i = 0; i < n; i++) {
          this.tone({
            pos, freq: base * (0.8 + Math.random() * 0.5), glide: base * (0.7 + Math.random() * 0.9),
            glideTime: 0.06, dur: 0.075 + Math.random() * 0.06, gain: 0.09 * g,
            delay: i * (0.07 + Math.random() * 0.07), wave: 'sine', reverb: 0.45,
          });
        }
        break;
      }
      case 'gull':
        for (let i = 0; i < 3; i++) {
          this.tone({
            pos, freq: 1250, glide: 700, glideTime: 0.22, dur: 0.26, gain: 0.11 * g,
            wave: 'sawtooth', vibrato: 22, vibratoDepth: 90, delay: i * 0.34, reverb: 0.5,
          });
        }
        break;
      case 'eagle':
        this.tone({ pos, freq: 1750, glide: 900, glideTime: 0.5, dur: 0.62, gain: 0.13 * g, wave: 'sawtooth', vibrato: 30, vibratoDepth: 220, reverb: 0.6 });
        break;
      case 'wolf':
        this.tone({ pos, freq: 320, glide: 430, glideTime: 0.9, dur: 2.2, gain: 0.15 * g, wave: 'sawtooth', vibrato: 5, vibratoDepth: 12, attack: 0.25, reverb: 0.85, maxDist: 900 });
        this.tone({ pos, freq: 160, glide: 214, glideTime: 0.9, dur: 2.2, gain: 0.09 * g, wave: 'triangle', attack: 0.3, reverb: 0.8, maxDist: 900 });
        break;
      case 'fox':
        for (let i = 0; i < 2; i++) {
          this.tone({ pos, freq: 900, glide: 420, glideTime: 0.18, dur: 0.22, gain: 0.13 * g, wave: 'sawtooth', delay: i * 0.5, reverb: 0.6 });
        }
        break;
      case 'deer':
        this.tone({ pos, freq: 300, glide: 210, glideTime: 0.4, dur: 0.5, gain: 0.10 * g, wave: 'sawtooth', vibrato: 14, vibratoDepth: 30, reverb: 0.5 });
        break;
      case 'boar':
        for (let i = 0; i < 4; i++) {
          this.burst({ pos, freq: 260, q: 3, gain: 0.11 * g, release: 0.1, delay: i * 0.13, sweep: 140 });
        }
        break;
      case 'goat':
        this.tone({ pos, freq: 520, glide: 400, glideTime: 0.5, dur: 0.6, gain: 0.10 * g, wave: 'sawtooth', vibrato: 26, vibratoDepth: 70 });
        break;
      case 'whale':
        this.tone({ pos, freq: 70, glide: 180, glideTime: 2.4, dur: 4.2, gain: 0.22 * g, wave: 'sine', attack: 0.8, reverb: 0.95, maxDist: 3000 });
        this.tone({ pos, freq: 141, glide: 88, glideTime: 3.0, dur: 4.4, gain: 0.10 * g, wave: 'triangle', attack: 1.2, reverb: 0.95, maxDist: 3000, delay: 0.4 });
        this.music.cue('note');
        break;

      /* --- the voices the new continents needed ------------------------- */
      case 'sheep':
        this.tone({ pos, freq: 440, glide: 330, glideTime: 0.55, dur: 0.7, gain: 0.10 * g, wave: 'sawtooth', vibrato: 19, vibratoDepth: 90 });
        break;
      case 'horse':
        // A whinny: a fast descending chirp on top of a snort.
        this.tone({ pos, freq: 780, glide: 260, glideTime: 0.7, dur: 0.85, gain: 0.12 * g, wave: 'sawtooth', vibrato: 34, vibratoDepth: 130, reverb: 0.5 });
        this.burst({ pos, freq: 220, q: 1.4, gain: 0.09 * g, release: 0.35, sweep: 90 });
        break;
      case 'yak':
      case 'buffalo':
        this.tone({ pos, freq: 130, glide: 96, glideTime: 1.0, dur: 1.3, gain: 0.15 * g, wave: 'sawtooth', vibrato: 7, vibratoDepth: 9, attack: 0.15, reverb: 0.6, maxDist: 700 });
        break;
      case 'camel':
        this.tone({ pos, freq: 190, glide: 120, glideTime: 0.8, dur: 1.0, gain: 0.12 * g, wave: 'square', vibrato: 12, vibratoDepth: 40 });
        break;
      case 'bear':
        this.tone({ pos, freq: 110, glide: 74, glideTime: 0.9, dur: 1.2, gain: 0.17 * g, wave: 'sawtooth', vibrato: 9, vibratoDepth: 16, attack: 0.1, reverb: 0.7, maxDist: 900 });
        this.burst({ pos, freq: 330, q: 0.9, gain: 0.10 * g, release: 0.7, sweep: 120 });
        break;
      case 'lion':
        // The roar carries a very long way, which is most of its effect.
        this.tone({ pos, freq: 88, glide: 58, glideTime: 1.5, dur: 2.1, gain: 0.22 * g, wave: 'sawtooth', vibrato: 6, vibratoDepth: 14, attack: 0.18, reverb: 0.85, maxDist: 2000 });
        this.tone({ pos, freq: 176, glide: 116, glideTime: 1.5, dur: 2.0, gain: 0.09 * g, wave: 'triangle', attack: 0.25, reverb: 0.8, maxDist: 2000 });
        break;
      case 'elephant':
        this.tone({ pos, freq: 240, glide: 420, glideTime: 0.5, dur: 1.4, gain: 0.20 * g, wave: 'sawtooth', vibrato: 8, vibratoDepth: 50, attack: 0.09, reverb: 0.7, maxDist: 2200 });
        this.tone({ pos, freq: 42, glide: 34, glideTime: 1.6, dur: 2.4, gain: 0.16 * g, wave: 'sine', attack: 0.4, maxDist: 2600 });
        break;
      case 'hippo':
        for (let i = 0; i < 3; i++) {
          this.tone({ pos, freq: 96, glide: 70, glideTime: 0.3, dur: 0.4, gain: 0.16 * g, wave: 'square', delay: i * 0.34, reverb: 0.7, maxDist: 1200 });
        }
        break;
      case 'moose':
        this.tone({ pos, freq: 180, glide: 128, glideTime: 1.1, dur: 1.5, gain: 0.14 * g, wave: 'sawtooth', vibrato: 5, vibratoDepth: 12, attack: 0.2, reverb: 0.75, maxDist: 1400 });
        break;
      case 'monkey': {
        const n = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) {
          this.tone({
            pos, freq: 900 + Math.random() * 700, glide: 400, glideTime: 0.09, dur: 0.11,
            gain: 0.10 * g, wave: 'square', delay: i * (0.09 + Math.random() * 0.08), reverb: 0.55,
          });
        }
        break;
      }
      case 'parrot':
        for (let i = 0; i < 2; i++) {
          this.tone({ pos, freq: 2100, glide: 1200, glideTime: 0.14, dur: 0.2, gain: 0.11 * g, wave: 'sawtooth', vibrato: 40, vibratoDepth: 300, delay: i * 0.24, reverb: 0.5 });
        }
        break;
      case 'crow':
        for (let i = 0; i < 3; i++) {
          this.burst({ pos, freq: 900, q: 2.2, gain: 0.11 * g, release: 0.16, delay: i * 0.28, sweep: 520 });
        }
        break;
      case 'vulture':
        this.burst({ pos, freq: 620, q: 1.4, gain: 0.09 * g, release: 0.5, sweep: 260, reverb: 0.6 });
        break;
      case 'heron':
        this.burst({ pos, freq: 480, q: 3.5, gain: 0.13 * g, release: 0.42, sweep: 200, reverb: 0.6, maxDist: 800 });
        break;
      case 'penguin':
        for (let i = 0; i < 4; i++) {
          this.burst({ pos, freq: 1400, q: 2.6, gain: 0.08 * g, release: 0.12, delay: i * 0.16, sweep: 700 });
        }
        break;
      case 'seal':
        this.tone({ pos, freq: 300, glide: 190, glideTime: 0.5, dur: 0.7, gain: 0.12 * g, wave: 'sawtooth', vibrato: 16, vibratoDepth: 60, reverb: 0.65 });
        break;
      case 'dolphin': {
        const n = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          this.tone({
            pos, freq: 3800 + Math.random() * 3000, glide: 1600, glideTime: 0.10, dur: 0.13,
            gain: 0.07 * g, wave: 'sine', delay: i * 0.10, reverb: 0.6, maxDist: 700,
          });
        }
        break;
      }
    }
  }

  /* ------------------------------------------------------------ continuous */

  fireStart(x, y, z) {
    // Fires share one crackle bed per fire, positioned.
    const ctx = this.ctx;
    const key = `${x.toFixed(1)}_${y.toFixed(1)}_${z.toFixed(1)}`;
    if (this.fireVoices.has(key)) return;
    if (this.fireVoices.size > 8) return;
    const pan = this.panner(x, y, z, 3, 90, 1.5);
    const g = ctx.createGain();
    g.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 480;
    filt.Q.value = 0.5;
    this._loop(this.pink, 1.0, filt);
    filt.connect(g);
    g.connect(pan);
    pan.connect(this.dry);
    this.reverbSendFrom(pan, 0.2);
    g.gain.setTargetAtTime(0.16, ctx.currentTime, 0.6);
    this.fireVoices.set(key, { pan, gain: g, filt, x, y, z, t: 0 });
  }

  fireStop(f) {
    // Fires are transient; the bed fades on the next update sweep.
  }

  engineStart(v) {
    if (this.engines.has(v)) return;
    const ctx = this.ctx;
    const pan = this.panner(v.position.x, v.position.y, v.position.z, 5, 320, 1.2);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(pan);
    pan.connect(this.dry);
    this.reverbSendFrom(pan, 0.2);

    const oscs = [];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : i === 1 ? 'square' : 'triangle';
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.4 : i === 1 ? 0.22 : 0.3;
      o.connect(g);
      g.connect(out);
      o.start();
      oscs.push(o);
    }
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    // Mechanical hiss on top.
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1500;
    hissFilter.Q.value = 0.8;
    const hg = ctx.createGain();
    hg.gain.value = 0.05;
    this._loop(this.pink, 1, hissFilter);
    hissFilter.connect(hg);
    hg.connect(out);

    out.gain.setTargetAtTime(0.24, ctx.currentTime, 0.3);
    this.engines.set(v, { pan, out, oscs, hg });
  }

  engineStop(v) {
    const e = this.engines.get(v);
    if (!e) return;
    const now = this.ctx.currentTime;
    e.out.gain.setTargetAtTime(0.0001, now, 0.25);
    for (const o of e.oscs) o.stop(now + 1.4);
    this.engines.delete(v);
    setTimeout(() => {
      try { e.out.disconnect(); e.pan.disconnect(); } catch (err) {}
    }, 1800);
  }

  /* --------------------------------------------------------------- update */

  update(dt) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._t += dt;
    const w = this.world;
    const p = w.player;
    const cam = w.engine.camera;

    /* --- listener ----------------------------------------------------- */
    const L = ctx.listener;
    cam.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.position.x, now, 0.02);
      L.positionY.setTargetAtTime(cam.position.y, now, 0.02);
      L.positionZ.setTargetAtTime(cam.position.z, now, 0.02);
      L.forwardX.setTargetAtTime(this._fwd.x, now, 0.02);
      L.forwardY.setTargetAtTime(this._fwd.y, now, 0.02);
      L.forwardZ.setTargetAtTime(this._fwd.z, now, 0.02);
      L.upX.setTargetAtTime(this._up.x, now, 0.02);
      L.upY.setTargetAtTime(this._up.y, now, 0.02);
      L.upZ.setTargetAtTime(this._up.z, now, 0.02);
    } else {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
      L.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
    }

    const s = w.terrain.sampleAt(p.position.x, p.position.z);
    const weather = w.weather;
    const under = p.underwater;
    const shelter = p.sheltered;

    /* --- muffling ------------------------------------------------------ */
    const cutoff = under ? 380 : lerp(20000, 2600, shelter);
    this.muffle.frequency.setTargetAtTime(cutoff, now, 0.25);
    this.subGain.gain.setTargetAtTime(under ? 0.16 : 0, now, 0.35);

    /* --- reverb space -------------------------------------------------- */
    let ir = 'outdoor';
    if (under) ir = 'water';
    else if (shelter > 0.6) ir = 'indoor';
    else if (FOREST_BIOMES.has(s.biome)) ir = 'forest';
    else if (p.position.y > 250 || s.mountain > 220) ir = 'valley';
    if (ir !== this._currentIR) {
      this._currentIR = ir;
      this.convolver.buffer = this._irs[ir];
    }
    this.reverbGain.gain.setTargetAtTime(under ? 0.55 : ir === 'valley' ? 0.62 : ir === 'indoor' ? 0.38 : 0.45, now, 0.6);

    /* --- wind ---------------------------------------------------------- */
    const exposure = clamp(0.30 + smoothstep(60, 1400, Math.max(0, p.position.y)) * 0.8 - shelter * 0.55, 0, 1.3);
    const windAmt = weather ? weather.wind : 0.4;
    const windLevel = clamp(windAmt * 0.30 * exposure, 0, 0.5) * (under ? 0.1 : 1);
    this.wind.gain.gain.setTargetAtTime(windLevel, now, 0.5);
    for (let i = 0; i < this.wind.layers.length; i++) {
      const l = this.wind.layers[i];
      const wob = Math.sin(this._t * (0.13 + i * 0.07)) * 0.5 + Math.sin(this._t * (0.41 + i * 0.11)) * 0.25;
      l.filt.frequency.setTargetAtTime(l.base * (1 + wob * 0.5 + windAmt * 0.35), now, 0.4);
    }
    this.whistle.gain.setTargetAtTime(
      clamp((windAmt - 0.65) * 0.10 * exposure, 0, 0.10) * (under ? 0 : 1), now, 0.8
    );

    /* --- water --------------------------------------------------------- */
    this._updateWater(dt, s, p, under);

    /* --- rain ---------------------------------------------------------- */
    if (weather) {
      const rainAmt = weather.precipitation;
      const isSnow = weather.snow > weather.rain;
      // Drizzle and a downpour are different sounds, not different volumes:
      // fine drops are a thin steady hiss up where the ear finds "tsss", big
      // drops shift the energy down into a broad roar. The gain curve is
      // deliberately non-linear so drizzle sits well under the wind and heavy
      // rain arrives with real weight.
      const heavy = smoothstep(0.15, 0.85, weather.rain);
      const level = under
        ? rainAmt * 0.02
        : Math.pow(rainAmt, 1.3) * (isSnow ? 0.035 : lerp(0.20, 0.36, heavy)) * lerp(1, 0.55, shelter);
      this.rainGain.gain.setTargetAtTime(level, now, 0.4);
      this.rainFilter.frequency.setTargetAtTime(
        isSnow ? 900 : lerp(lerp(3400, 1400, heavy), 900, shelter), now, 0.5
      );
      this.rainFilter.Q.setTargetAtTime(lerp(0.6, 0.28, heavy), now, 0.5);
      // Individual drips when you are under cover.
      if (shelter > 0.4 && rainAmt > 0.2 && Math.random() < dt * 7 * rainAmt) {
        this.burst({ freq: 1400 + Math.random() * 2600, q: 6, gain: 0.05, release: 0.10 });
      }
      // Big drops land as individual plops in a downpour - on the ground
      // around you, not in the middle of your head.
      if (!under && !isSnow && shelter < 0.5 && heavy > 0.4 && Math.random() < dt * 9 * heavy) {
        const a = Math.random() * 6.283;
        const d = 1 + Math.random() * 5;
        const p = this.world.player;
        this.burst({
          pos: p ? [p.position.x + Math.cos(a) * d, p.position.y, p.position.z + Math.sin(a) * d] : null,
          refDist: 1.5, maxDist: 20,
          freq: 260 + Math.random() * 520, q: 2.5,
          gain: 0.035 * heavy, attack: 0.002, release: 0.05 + Math.random() * 0.04,
        });
      }
    }

    /* --- insects, frogs, night --------------------------------------- */
    const night = 1 - w.sky.dayFactor;
    const warm = smoothstep(6, 20, s.temperature);
    const dryish = 1 - (weather ? weather.rain : 0);
    const insects = clamp(night * warm * dryish * 0.09 * (1 - under), 0, 0.09);
    this.insectGain.gain.setTargetAtTime(insects, now, 1.5);
    if (insects > 0.005 && Math.random() < dt * 14 * insects * 12) {
      // A cricket: a very short buzz, panned wherever.
      const a = Math.random() * 6.283;
      const d = 3 + Math.random() * 20;
      this.burst({
        pos: [p.position.x + Math.cos(a) * d, p.position.y + 0.2, p.position.z + Math.sin(a) * d],
        freq: 4200 + Math.random() * 1400, q: 14, gain: 0.05, attack: 0.005, release: 0.05,
        rate: 1, reverb: 0.2,
      });
    }
    // Frogs near water at night.
    if (night > 0.5 && s.moisture > 0.6 && s.waterLevel > -Infinity && Math.random() < dt * 1.2) {
      const a = Math.random() * 6.283;
      const d = 5 + Math.random() * 25;
      this.tone({
        pos: [p.position.x + Math.cos(a) * d, p.position.y, p.position.z + Math.sin(a) * d],
        freq: 210 + Math.random() * 90, glide: 150, glideTime: 0.12, dur: 0.16, gain: 0.07, wave: 'sawtooth',
      });
    }

    /* --- fires --------------------------------------------------------- */
    this._updateFires(dt);

    /* --- engines ------------------------------------------------------- */
    for (const [v, e] of this.engines) {
      if (!v.alive) {
        this.engineStop(v);
        continue;
      }
      const rpm = clamp(Math.abs(v.speed) / v.spec.top, 0, 1);
      const idle = v.engineOn ? 1 : 0;
      const f = lerp(34, 165, rpm) * (v.kind === 'bulldozer' ? 0.6 : 1);
      for (let i = 0; i < e.oscs.length; i++) {
        e.oscs[i].frequency.setTargetAtTime(f * (i === 2 ? 2 : 1) * (1 + i * 0.01), now, 0.08);
      }
      e.out.gain.setTargetAtTime(idle * (0.10 + rpm * 0.22 + Math.abs(v.throttle) * 0.10), now, 0.12);
      e.hg.gain.setTargetAtTime(0.02 + rpm * 0.08, now, 0.2);
      this.movePanner(e.pan, v.position.x, v.position.y + 0.5, v.position.z, 0.06);
    }

    /* --- heartbeat when you are running out of air -------------------- */
    if (p.breath < 0.32 && Math.random() < dt * (2.4 - p.breath * 4)) {
      this.tone({ freq: 52, dur: 0.28, gain: 0.20 * (1 - p.breath / 0.32), wave: 'sine', attack: 0.02 });
    }

    this.music.update(dt);
  }

  _updateWater(dt, s, p, under) {
    const now = this.ctx.currentTime;
    const w = this.world;
    // Find the nearest water within earshot by probing a spiral.
    let best = null;
    let bestD = 1e9;
    const px = p.position.x;
    const pz = p.position.z;
    for (let i = 0; i < 26; i++) {
      const a = i * 2.399963;
      const r = i === 0 ? 0 : 5.5 * Math.sqrt(i) * 2.2;
      const x = px + Math.cos(a) * r;
      const z = pz + Math.sin(a) * r;
      const smp = w.terrain.sampleAt(x, z, PROBE);
      if (smp.waterLevel === -Infinity) continue;
      if (smp.height > smp.waterLevel) continue;
      const d = r;
      if (d < bestD) {
        bestD = d;
        best = {
          x, z, y: smp.waterLevel,
          river: smp.riverStrength,
          ocean: smp.waterLevel <= 0.001 && smp.height < -1.2,
          depth: smp.waterLevel - smp.height,
        };
      }
      if (bestD < 3) break;
    }

    if (!best) {
      this.waterGain.gain.setTargetAtTime(0, now, 0.8);
      this.surfGain.gain.setTargetAtTime(0, now, 1.2);
      return;
    }

    this.movePanner(this.waterPanner, best.x, best.y, best.z, 0.25);
    const near = clamp(1 - bestD / 90, 0, 1);
    if (best.river > 0.05) {
      // A brook: brighter, busier, and it babbles.
      const level = near * clamp(0.06 + best.river * 0.30, 0, 0.34) * (under ? 0.35 : 1);
      this.waterGain.gain.setTargetAtTime(level, now, 0.4);
      this.waterFilter.frequency.setTargetAtTime(
        lerp(600, 1800, best.river) * (1 + Math.sin(this._t * 0.7) * 0.12), now, 0.5
      );
      this.waterFilter.Q.setTargetAtTime(0.7, now, 0.5);
      // Bubbling grains.
      if (Math.random() < dt * 22 * near * best.river) {
        this.burst({
          pos: [best.x, best.y, best.z], freq: 900 + Math.random() * 2200, q: 8,
          gain: 0.04 * near, attack: 0.003, release: 0.06, reverb: 0.25,
        });
      }
      this.surfGain.gain.setTargetAtTime(0, now, 1.2);
    } else if (best.ocean || best.depth > 6) {
      // Surf: slow swells that rise and fall.
      this._surfPhase += dt * 0.22;
      const swell = 0.5 + 0.5 * Math.sin(this._surfPhase) * Math.sin(this._surfPhase * 0.37 + 1.1);
      const level = near * (0.06 + swell * 0.20) * (under ? 0.3 : 1);
      this.surfGain.gain.setTargetAtTime(level, now, 0.35);
      this.surfFilter.frequency.setTargetAtTime(lerp(260, 900, swell), now, 0.4);
      this.waterGain.gain.setTargetAtTime(near * 0.05 * (1 - (this.world.weather ? this.world.weather.wind * 0.2 : 0)), now, 0.6);
      this.waterFilter.frequency.setTargetAtTime(700, now, 0.6);
    } else {
      // A still lake: barely anything, just a lap at the edge.
      this.waterGain.gain.setTargetAtTime(near * 0.055, now, 0.6);
      this.waterFilter.frequency.setTargetAtTime(520, now, 0.6);
      this.surfGain.gain.setTargetAtTime(0, now, 1.2);
    }
  }

  _updateFires(dt) {
    const now = this.ctx.currentTime;
    const w = this.world;
    // Match live fires to voices; fade out voices with no fire near them.
    const used = new Set();
    for (const f of w.fire.fires) {
      let bestKey = null;
      let bestD = 6;
      for (const [key, v] of this.fireVoices) {
        if (used.has(key)) continue;
        const d = Math.hypot(v.x - f.x, v.y - f.y, v.z - f.z);
        if (d < bestD) {
          bestD = d;
          bestKey = key;
        }
      }
      if (bestKey) {
        used.add(bestKey);
        const v = this.fireVoices.get(bestKey);
        v.x = f.x; v.y = f.y; v.z = f.z;
        this.movePanner(v.pan, f.x, f.y + 0.4, f.z, 0.2);
        v.gain.gain.setTargetAtTime(clamp(f.intensity * 0.16, 0, 0.26), now, 0.4);
        v.filt.frequency.setTargetAtTime(400 + f.intensity * 500, now, 0.4);
        // Crackle: sharp little pops.
        const d = Math.hypot(f.x - w.player.position.x, f.z - w.player.position.z);
        if (d < 40 && Math.random() < dt * 16 * f.intensity) {
          this.burst({
            pos: [f.x, f.y + 0.3, f.z], freq: 1200 + Math.random() * 3400, q: 7,
            gain: 0.05 + Math.random() * 0.06, attack: 0.001, release: 0.045, reverb: 0.2,
          });
        }
      } else if (this.fireVoices.size < 8) {
        this.fireStart(f.x, f.y, f.z);
      }
    }
    for (const [key, v] of this.fireVoices) {
      if (used.has(key)) continue;
      v.t += dt;
      v.gain.gain.setTargetAtTime(0.0001, now, 0.5);
      if (v.t > 2.5) {
        try { v.pan.disconnect(); v.gain.disconnect(); } catch (e) {}
        this.fireVoices.delete(key);
      }
    }
  }
}

const PROBE = {};

// A step is a soft, dark body - the weight going down - with a quiet band of
// texture on top of it that says what the ground is made of. `tex` is a
// fraction of the body's level, never its equal: brightness is what carries
// information here, and also what wears you out.
const FOOT = {
// The gains read higher than the old bandpass numbers and are far quieter in
// practice: a lowpass at 380 Hz passes a sixth of the energy that a Q 0.75
// bandpass at 1750 Hz did, and the panner takes its own bite. Measured, not
// guessed - grass walks at +9 dB over the ambience where it used to be +19.
  grass: { freq: 380, q: 0.7, gain: 0.160, release: 0.115, tex: 1450, texGain: 0.26, texRel: 0.075 },
  leaves: { freq: 440, q: 0.7, gain: 0.145, release: 0.145, tex: 1950, texGain: 0.34, texRel: 0.115, texQ: 0.7 },
  sand: { freq: 300, q: 0.7, gain: 0.160, release: 0.130, tex: 950, texGain: 0.26, texRel: 0.090 },
  snow: { freq: 480, q: 0.8, gain: 0.180, release: 0.085, tex: 1500, texGain: 0.30, texRel: 0.060, texQ: 1.6 },
  gravel: { freq: 500, q: 0.8, gain: 0.175, release: 0.100, tex: 1750, texGain: 0.36, texRel: 0.085, texQ: 1.2 },
  stone: { freq: 400, q: 1.6, gain: 0.185, release: 0.070, attack: 0.004, tex: 1600, texGain: 0.26, texRel: 0.045, texQ: 2.2 },
  wood: { freq: 230, q: 1.8, gain: 0.175, release: 0.095, attack: 0.005, tex: 880, texGain: 0.28, texRel: 0.060, texQ: 1.4 },
  mud: { freq: 260, q: 0.9, gain: 0.168, release: 0.170, tex: 620, texGain: 0.30, texRel: 0.130 },
  water: { freq: 520, q: 0.7, gain: 0.168, release: 0.190, tex: 1300, texGain: 0.28, texRel: 0.150 },
};

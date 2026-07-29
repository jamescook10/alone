// A generative score.
//
// No loops and no recordings: a slow chord pad, a low drone and a scattering of
// bell tones, all chosen from a scale that changes with where you are and what
// time it is. It swells at dawn, thins out in a storm, and goes quiet when you
// walk into a town, because a town should feel like held breath.

import { hz, SCALES, degree, env } from './synth.js';
import { BIOME } from '../world/worldgen.js';
import { clamp, lerp, smoothstep } from '../core/noise.js';

// Each biome gets a mode and a root, so crossing a mountain range genuinely
// changes the music.
const MOODS = {
  [BIOME.DEEP_OCEAN]: { scale: 'aeolian', root: 41, spread: 0.5, bell: 0.25, pad: 1.0 },
  [BIOME.OCEAN]: { scale: 'dorian', root: 45, spread: 0.7, bell: 0.4, pad: 0.95 },
  [BIOME.REEF]: { scale: 'lydian', root: 50, spread: 0.9, bell: 0.9, pad: 0.8 },
  [BIOME.BEACH]: { scale: 'major', root: 50, spread: 1.0, bell: 0.8, pad: 0.75 },
  [BIOME.GRASSLAND]: { scale: 'pentatonic', root: 48, spread: 1.0, bell: 0.85, pad: 0.8 },
  [BIOME.FOREST]: { scale: 'dorian', root: 46, spread: 0.85, bell: 0.7, pad: 0.9 },
  [BIOME.RAINFOREST]: { scale: 'lydian', root: 45, spread: 1.1, bell: 1.0, pad: 0.85 },
  [BIOME.TAIGA]: { scale: 'minorPent', root: 43, spread: 0.7, bell: 0.55, pad: 1.0 },
  [BIOME.TUNDRA]: { scale: 'aeolian', root: 43, spread: 0.6, bell: 0.45, pad: 1.0 },
  [BIOME.SNOW]: { scale: 'hirajoshi', root: 55, spread: 1.2, bell: 0.7, pad: 1.05 },
  [BIOME.DESERT]: { scale: 'hirajoshi', root: 47, spread: 1.3, bell: 0.5, pad: 0.7 },
  [BIOME.SAVANNA]: { scale: 'minorPent', root: 47, spread: 1.1, bell: 0.6, pad: 0.75 },
  [BIOME.SWAMP]: { scale: 'dorian', root: 42, spread: 0.6, bell: 0.5, pad: 1.0 },
  [BIOME.ALPINE]: { scale: 'lydian', root: 52, spread: 1.3, bell: 0.9, pad: 1.1 },
  [BIOME.SCREE]: { scale: 'aeolian', root: 45, spread: 0.9, bell: 0.5, pad: 1.0 },
  [BIOME.MEADOW]: { scale: 'major', root: 50, spread: 1.05, bell: 1.0, pad: 0.8 },
};

const CHORDS = [
  [0, 2, 4], [0, 2, 4, 6], [-3, 0, 2], [2, 4, 6], [0, 3, 5], [-1, 1, 3],
];

export class Music {
  constructor(audio) {
    this.a = audio;
    this.ctx = audio.ctx;
    this.world = audio.world;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(audio.musicBus);

    this.padGain = this.ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padFilter = this.ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.6;
    this.padGain.connect(this.padFilter);
    this.padFilter.connect(this.out);

    this.voices = [];
    this.chordT = 0;
    this.bellT = 3;
    this.chordIndex = 0;
    this.mood = MOODS[BIOME.GRASSLAND];
    this.intensity = 0;
    this.target = 0;
    this._started = false;
    this.swell = 0;
  }

  start() {
    if (this._started) return;
    this._started = true;
    // Three detuned saw-ish voices make the pad; a sine underneath makes the
    // drone. They run for the whole session and only ever change pitch.
    for (let i = 0; i < 4; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 3 ? 'sine' : i === 0 ? 'triangle' : 'sawtooth';
      const g = this.ctx.createGain();
      g.gain.value = i === 3 ? 0.30 : 0.11;
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = i === 3 ? 0 : (i - 1) * 0.55;
      osc.connect(g);
      g.connect(pan);
      pan.connect(this.padGain);
      osc.frequency.value = hz(48);
      osc.start();
      this.voices.push({ osc, gain: g, pan });
    }
    this._setChord(0, true);
  }

  _setChord(t, instant = false) {
    const m = this.mood;
    const scale = SCALES[m.scale] || SCALES.pentatonic;
    this.chordIndex = (this.chordIndex + 1 + Math.floor(Math.random() * 2)) % CHORDS.length;
    const chord = CHORDS[this.chordIndex];
    const now = this.ctx.currentTime;
    const glide = instant ? 0.01 : 9 + Math.random() * 7;
    for (let i = 0; i < 3; i++) {
      const n = degree(scale, m.root, chord[i % chord.length] + (i === 2 ? 7 : 0));
      const f = hz(n);
      const osc = this.voices[i].osc;
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setValueAtTime(osc.frequency.value, now);
      osc.frequency.linearRampToValueAtTime(f * (1 + (i - 1) * 0.0022), now + glide);
    }
    const drone = this.voices[3].osc;
    drone.frequency.cancelScheduledValues(now);
    drone.frequency.setValueAtTime(drone.frequency.value, now);
    drone.frequency.linearRampToValueAtTime(hz(m.root - 12), now + glide);
  }

  /** A single struck tone: FM sine with a long exponential tail. */
  bell(note, gain = 0.2, pan = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    carrier.type = 'sine';
    mod.type = 'sine';
    const f = hz(note);
    carrier.frequency.value = f;
    mod.frequency.value = f * 2.01;
    modGain.gain.value = f * 1.6;
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(g);
    g.connect(p);
    p.pan.value = pan;
    p.connect(this.out);
    // A second, quieter partial an octave up gives it shimmer.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6 + Math.random() * 2.4);
    modGain.gain.setValueAtTime(f * 1.6, t);
    modGain.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.9);
    carrier.start(t);
    mod.start(t);
    carrier.stop(t + 6.5);
    mod.stop(t + 6.5);
    this.a.reverbSendFrom(p, 0.5);
  }

  /** Called when something worth marking happens. */
  cue(kind) {
    if (!this._started) return;
    const m = this.mood;
    const scale = SCALES[m.scale] || SCALES.pentatonic;
    if (kind === 'discovery') {
      this.swell = Math.max(this.swell, 1);
      for (let i = 0; i < 4; i++) {
        setTimeout(() => this.bell(degree(scale, m.root + 12, i * 2), 0.16, (i - 1.5) * 0.4), i * 420);
      }
    } else if (kind === 'summit') {
      this.swell = Math.max(this.swell, 1.2);
      for (let i = 0; i < 3; i++) {
        setTimeout(() => this.bell(degree(scale, m.root + 24, i), 0.13, (Math.random() - 0.5) * 1.2), i * 900);
      }
    } else if (kind === 'note') {
      this.bell(degree(scale, m.root + 12, Math.floor(Math.random() * 5)), 0.07, (Math.random() - 0.5));
    }
  }

  update(dt) {
    if (!this._started) return;
    const w = this.world;
    const p = w.player;
    const s = w.terrain.sampleAt(p.position.x, p.position.z);
    const newMood = MOODS[s.biome] || MOODS[BIOME.GRASSLAND];
    if (newMood !== this.mood) {
      this.mood = newMood;
      this.chordT = Math.min(this.chordT, 4);
    }

    // How present the music should be right now.
    const sky = w.sky;
    const dawnDusk = Math.max(
      smoothstep(0.06, 0.0, Math.abs(sky.time - 0.26)),
      smoothstep(0.06, 0.0, Math.abs(sky.time - 0.76))
    );
    const night = 1 - sky.dayFactor;
    const height = smoothstep(400, 1400, p.position.y);
    const depth = p.underwater ? smoothstep(0, -120, p.position.y) : 0;
    const inTown = s.townInfluence;
    const storm = w.weather ? w.weather.precipitation : 0;

    this.swell = Math.max(0, this.swell - dt * 0.12);
    this.target = clamp(
      0.30 + dawnDusk * 0.5 + night * 0.14 + height * 0.42 + depth * 0.4 + this.swell * 0.6
      - inTown * 0.30 - storm * 0.22,
      0.05, 1.25
    );
    this.intensity = lerp(this.intensity, this.target, 1 - Math.exp(-dt * 0.22));

    const vol = this.intensity * 0.5;
    this.out.gain.setTargetAtTime(vol, this.ctx.currentTime, 1.2);
    this.padGain.gain.setTargetAtTime(this.mood.pad * 0.28 * (0.4 + this.intensity), this.ctx.currentTime, 2.5);
    this.padFilter.frequency.setTargetAtTime(
      lerp(420, 1900, clamp(this.intensity * 0.8 + height * 0.3, 0, 1)) * (p.underwater ? 0.3 : 1),
      this.ctx.currentTime, 1.5
    );

    this.chordT -= dt;
    if (this.chordT <= 0) {
      this.chordT = 22 + Math.random() * 26;
      this._setChord(this.ctx.currentTime);
    }

    this.bellT -= dt;
    if (this.bellT <= 0) {
      const m = this.mood;
      this.bellT = lerp(14, 3.5, this.intensity * m.bell) * (0.5 + Math.random());
      const scale = SCALES[m.scale] || SCALES.pentatonic;
      const n = degree(scale, m.root + 12, Math.floor(Math.random() * 7));
      this.bell(n, 0.05 + this.intensity * 0.09, (Math.random() - 0.5) * 1.6 * m.spread);
    }
  }
}

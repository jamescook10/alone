// Synthesis primitives. There are no audio files in this project: every sound
// you hear is built out of noise, oscillators and filters at run time.

/** White noise, cached per context. */
export function noiseBuffer(ctx, seconds = 2, seed = 1) {
  const key = '__noise' + seconds + '_' + seed;
  if (ctx[key]) return ctx[key];
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    d[i] = (s / 2147483648) - 1;
  }
  ctx[key] = buf;
  return buf;
}

/** Pink-ish noise: much better for wind and water than white. */
export function pinkBuffer(ctx, seconds = 4) {
  const key = '__pink' + seconds;
  if (ctx[key]) return ctx[key];
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let s = (1013 + ch * 7717) >>> 0;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const white = (s / 2147483648) - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    // Crossfade the ends so the loop is seamless.
    const fade = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
  }
  ctx[key] = buf;
  return buf;
}

/**
 * A synthetic impulse response. Exponentially decaying noise with a few early
 * reflections, optionally darkened - which is all a convolution reverb needs
 * to convince you that you are standing in a valley, a room, or the sea.
 */
export function impulseResponse(ctx, opts = {}) {
  const seconds = opts.seconds || 2.4;
  const decay = opts.decay || 2.6;
  const damp = opts.damp !== undefined ? opts.damp : 0.35;
  const preDelay = opts.preDelay || 0.012;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.floor(preDelay * ctx.sampleRate);
  const reflections = opts.reflections || [0.02, 0.037, 0.061, 0.089, 0.131];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = (7919 + ch * 104729) >>> 0;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const white = (s / 2147483648) - 1;
      lp += (white - lp) * (1 - damp);
      const t = Math.max(0, i - pre) / ctx.sampleRate;
      let env = Math.pow(1 - t / seconds, decay);
      if (i < pre) env = 0;
      d[i] = lp * env;
    }
    for (const r of reflections) {
      const idx = Math.floor((r + preDelay) * ctx.sampleRate) + (ch ? 37 : 0);
      if (idx < len) d[idx] += (ch ? -1 : 1) * 0.32 * Math.pow(1 - r / seconds, 1.6);
    }
  }
  return buf;
}

/** Sets a gain envelope: attack to peak, then exponential release. */
export function env(param, t0, peak, attack, release, floor = 0.0001) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(floor, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(floor, t0 + attack + release);
}

/** Musical helper: MIDI note to hertz. */
export function hz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  hirajoshi: [0, 2, 3, 7, 8],
};

/** Pick the nth degree of a scale, wrapping into higher octaves. */
export function degree(scale, root, n) {
  const len = scale.length;
  const oct = Math.floor(n / len);
  const i = ((n % len) + len) % len;
  return root + scale[i] + oct * 12;
}

// Offline terrain texture baking. Same spirit as the tree bake: the textures
// are still generated from the game's own noise, just once at build time and
// at a quality per-frame generation could never afford.
//
// Each set is two JPEGs: color (luminance centred on 0.5 - the shader
// multiplies it into the biome's vertex colour) and "nr" holding the tangent
// normal in RG and roughness in B.

import { Noise } from '../../src/core/noise.js';

const S = 512;

function torus(fn) {
  // Sample on a torus so every edge tiles.
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const b = (y / S) * Math.PI * 2;
    for (let x = 0; x < S; x++) {
      const a = (x / S) * Math.PI * 2;
      out[y * S + x] = fn(Math.cos(a) * 5, Math.sin(a) * 5, Math.cos(b) * 5, Math.sin(b) * 5, x, y);
    }
  }
  return out;
}

function normalsFrom(height, strength) {
  const n = new Float32Array(S * S * 2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xm = (x + S - 1) % S, xp = (x + 1) % S;
      const ym = (y + S - 1) % S, yp = (y + 1) % S;
      const dx = (height[y * S + xp] - height[y * S + xm]) * strength;
      const dy = (height[yp * S + x] - height[ym * S + x]) * strength;
      const il = 1 / Math.hypot(dx, dy, 1);
      n[(y * S + x) * 2] = -dx * il;
      n[(y * S + x) * 2 + 1] = -dy * il;
    }
  }
  return n;
}

function toJpeg(fill) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  fill(img.data);
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.90).split(',')[1];
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** { color, nr } base64 jpegs from per-pixel {lum, tint, height, rough}. */
function bakeSet(px, normalStrength) {
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  const colR = new Float32Array(S * S);
  const colG = new Float32Array(S * S);
  const colB = new Float32Array(S * S);
  torus((cx, sx, cy, sy, x, y) => {
    const o = px(cx, sx, cy, sy, x, y);
    const i = y * S + x;
    height[i] = o.h;
    rough[i] = o.rough;
    colR[i] = o.r; colG[i] = o.g; colB[i] = o.b;
    return 0;
  });
  const nrm = normalsFrom(height, normalStrength);
  return {
    color: toJpeg((d) => {
      for (let i = 0; i < S * S; i++) {
        d[i * 4] = clamp01(colR[i]) * 255;
        d[i * 4 + 1] = clamp01(colG[i]) * 255;
        d[i * 4 + 2] = clamp01(colB[i]) * 255;
        d[i * 4 + 3] = 255;
      }
    }),
    nr: toJpeg((d) => {
      for (let i = 0; i < S * S; i++) {
        d[i * 4] = (nrm[i * 2] * 0.5 + 0.5) * 255;
        d[i * 4 + 1] = (nrm[i * 2 + 1] * 0.5 + 0.5) * 255;
        d[i * 4 + 2] = clamp01(rough[i]) * 255;
        d[i * 4 + 3] = 255;
      }
    }),
  };
}

window.bakeTerrainSet = function (name) {
  const n1 = new Noise(1013);
  const n2 = new Noise(2027);
  const n3 = new Noise(3041);
  const TAU = Math.PI * 2;

  // Seamless 2D fbm by blending four shifted copies. The torus-projection
  // trick the runtime detail texture uses stalls wherever the collapsed z
  // axis has zero derivative, which smears two whole rows of the image;
  // fine for subtle break-up, ruinous for a hero texture.
  const iso = (n, cx, sx, cy, sy, s, o, x, y) => iso2(n, s, s, o, x, y);
  // Anisotropic variant: separate x/y spans, so blade strokes and strata are
  // possible without breaking the seam (corner blending keeps any (u,v)
  // function tileable).
  const iso2 = (n, spanX, spanY, o, x, y) => {
    const u = x / S, v = y / S;
    const X = u * spanX, Y = v * spanY;
    const A = n.fbm2(X, Y, o), B = n.fbm2(X - spanX, Y, o);
    const C = n.fbm2(X, Y - spanY, o), D = n.fbm2(X - spanX, Y - spanY, o);
    return A * (1 - u) * (1 - v) + B * u * (1 - v) + C * (1 - u) * v + D * u * v;
  };

  if (name === 'grass') {
    return bakeSet((cx, sx, cy, sy, x, y) => {
      const clump = iso(n1, cx, sx, cy, sy, 6.0, 4, x, y) * 0.5 + 0.5;
      // Blade strokes: strongly stretched fbm reads as short vertical tufts.
      const blade = iso2(n2, 26, 5, 3, x, y) * 0.5 + 0.5;
      const soil = iso(n3, cx, sx, cy, sy, 13.0, 3, x, y) * 0.5 + 0.5;
      const h = clump * 0.5 + blade * 0.42 + soil * 0.08;
      const lum = 0.36 + clump * 0.2 + blade * 0.18 - (soil < 0.3 ? 0.09 : 0);
      return { h, rough: 0.78 + clump * 0.16, r: lum * 0.94, g: lum * 1.06, b: lum * 0.86 };
    }, 5.0);
  }
  if (name === 'rock') {
    return bakeSet((cx, sx, cy, sy, x, y) => {
      const b = (y / S) * TAU;
      const base = iso(n1, cx, sx, cy, sy, 4.5, 5, x, y);
      const ridge = 1 - Math.abs(base) * 1.9;
      const strata = Math.sin(b * 8 + iso(n2, cx, sx, cy, sy, 5.0, 3, x, y) * 3.5) * 0.5 + 0.5;
      const crack = Math.abs(iso(n2, cx, sx, cy, sy, 8.0, 4, x, y));
      const isCrack = crack < 0.05 ? 1 - crack / 0.05 : 0;
      const h = clamp01(0.45 + ridge * 0.32 + strata * 0.10 - isCrack * 0.5);
      const lum = 0.34 + ridge * 0.2 + strata * 0.10 - isCrack * 0.22;
      return { h, rough: 0.88 - ridge * 0.18, r: lum * 1.04, g: lum * 1.0, b: lum * 0.95 };
    }, 6.5);
  }
  if (name === 'sand') {
    return bakeSet((cx, sx, cy, sy, x, y) => {
      const b = (y / S) * TAU;
      const warp = iso(n1, cx, sx, cy, sy, 5.0, 3, x, y);
      const ripple = Math.abs(Math.sin(b * 11 + warp * 3.4));
      const grain = iso(n2, cx, sx, cy, sy, 26.0, 2, x, y) * 0.5 + 0.5;
      const h = ripple * 0.65 + grain * 0.35;
      const lum = 0.44 + ripple * 0.12 + grain * 0.08;
      return { h, rough: 0.9, r: lum * 1.08, g: lum * 1.0, b: lum * 0.85 };
    }, 3.2);
  }
  if (name === 'snow') {
    return bakeSet((cx, sx, cy, sy, x, y) => {
      const drift = iso(n1, cx, sx, cy, sy, 5.0, 3, x, y) * 0.5 + 0.5;
      const crust = iso(n2, cx, sx, cy, sy, 16.0, 2, x, y) * 0.5 + 0.5;
      const sparkleH = ((x * 92821 + y * 68917) % 977) / 977;
      const sparkle = sparkleH > 0.993 ? 1 : 0;
      const h = drift * 0.8 + crust * 0.2;
      const lum = 0.5 + drift * 0.09 + crust * 0.04 + sparkle * 0.28;
      return { h, rough: 0.42 - sparkle * 0.3 + crust * 0.1, r: lum * 0.985, g: lum, b: lum * 1.03 };
    }, 1.6);
  }
  throw new Error('unknown set ' + name);
};

window.terrainReady = true;

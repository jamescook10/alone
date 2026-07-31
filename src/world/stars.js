// The celestial sphere: the frame everything in the sky is hung on, the star
// catalogue, the planets and the meteors.
//
// The sky is a real one. Directions are computed in equatorial coordinates and
// rotated into the world by one 3x3 matrix built from the local sidereal time
// and the observer's latitude, so the whole sky wheels about the celestial
// pole exactly once a sidereal day: Polaris sits still, Orion rises in the
// east on its side and sets upright in the west, and the constellations you
// see at midnight in one season are the ones you see at dusk two months later.
// The sun's declination comes out of the same maths, so the seasons - long
// summer evenings, a low winter sun - are a consequence rather than a fudge.
//
// Latitude follows the climate. The world is a hundred thousand kilometres
// wide and its cold country is its high country in every other respect, so a
// glacier gets a polar sky with Polaris overhead and the Plough circumpolar,
// and a jungle gets a tropical one where the Southern Cross clears the
// horizon. It moves slowly enough that you never see it move.

import * as THREE from 'three';
import { CONSTELLATIONS, LONE_STARS, PLEIADES } from './starData.js';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const HOUR = TAU / 24;
export const OBLIQUITY = 23.44 * DEG;
const SCRATCH = new THREE.Vector3();

/** Days in a year and a synodic month, in game days. */
export const YEAR = 48;
export const MONTH = 5.0;

/**
 * Equatorial -> world rotation for a given local sidereal time and latitude.
 * World axes are +X east, +Y up, -Z north, which is the convention the rest of
 * the game already uses for the sun.
 */
export function celestialFrame(lst, lat, out = new THREE.Matrix3()) {
  const cl = Math.cos(lst), sl = Math.sin(lst);
  const cp = Math.cos(lat), sp = Math.sin(lat);
  return out.set(
    -sl, cl, 0,
    cl * cp, sl * cp, sp,
    cl * sp, sl * sp, -cp
  );
}

/** Ecliptic longitude/latitude -> equatorial unit vector. */
export function eclipticToEquatorial(lon, latEc, out = new THREE.Vector3()) {
  const cb = Math.cos(latEc), sb = Math.sin(latEc);
  const x = cb * Math.cos(lon);
  const y = cb * Math.sin(lon);
  return out.set(
    x,
    y * Math.cos(OBLIQUITY) - sb * Math.sin(OBLIQUITY),
    y * Math.sin(OBLIQUITY) + sb * Math.cos(OBLIQUITY)
  );
}

/** Right ascension in hours + declination in degrees -> equatorial vector. */
function raDec(ra, dec, out = new THREE.Vector3()) {
  const r = ra * HOUR, d = dec * DEG;
  const cd = Math.cos(d);
  return out.set(cd * Math.cos(r), cd * Math.sin(r), Math.sin(d));
}

// B-V colour index to a display tint. Real stars run from about -0.35 (blue
// supergiants) to 2.0 (carbon stars); the eye barely sees the colour of the
// faint ones, so this is deliberately gentler than a blackbody curve would be.
const BV_TABLE = [
  [-0.40, 0.64, 0.74, 1.00],
  [0.00, 0.82, 0.88, 1.00],
  [0.40, 0.98, 0.97, 1.00],
  [0.80, 1.00, 0.93, 0.82],
  [1.20, 1.00, 0.84, 0.65],
  [1.60, 1.00, 0.74, 0.52],
  [2.10, 1.00, 0.64, 0.44],
];
function bvTint(bv, out) {
  let i = 0;
  while (i < BV_TABLE.length - 2 && bv > BV_TABLE[i + 1][0]) i++;
  const a = BV_TABLE[i], b = BV_TABLE[i + 1];
  const k = clamp((bv - a[0]) / (b[0] - a[0]), 0, 1);
  out[0] = lerp(a[1], b[1], k);
  out[1] = lerp(a[2], b[2], k);
  out[2] = lerp(a[3], b[3], k);
}

/* -- planets ------------------------------------------------------------- */
// Circular coplanar-ish orbits, which is all the eye can check. What it *can*
// check is that Venus is never far from the sun and only ever an evening or a
// morning star, that Mars flares up when the Earth passes it and fades to
// nothing on the far side of the sun, and that Jupiter takes a season to cross
// a constellation. All three fall out of doing the geometry rather than
// parking five dots on the ecliptic.
const PLANETS = [
  { name: 'Mercury', a: 0.387, T: 0.2408, L0: 1.51, inc: 7.0 * DEG, H: -0.60, col: [1.00, 0.92, 0.78], inner: true },
  { name: 'Venus', a: 0.723, T: 0.6152, L0: 2.94, inc: 3.4 * DEG, H: -4.40, col: [1.00, 0.97, 0.86], inner: true },
  { name: 'Mars', a: 1.524, T: 1.8808, L0: 5.13, inc: 1.85 * DEG, H: -1.50, col: [1.00, 0.46, 0.26], inner: false },
  { name: 'Jupiter', a: 5.203, T: 11.862, L0: 0.62, inc: 1.30 * DEG, H: -9.40, col: [1.00, 0.90, 0.74], inner: false },
  { name: 'Saturn', a: 9.537, T: 29.457, L0: 3.91, inc: 2.49 * DEG, H: -8.88, col: [1.00, 0.86, 0.58], inner: false },
];

const SKY_VERT = /* glsl */ `
uniform mat3 uSkyRot;
uniform float uNight;
uniform float uPix;
uniform float uTime;
uniform float uTwinkle;
uniform float uSizeBoost;
attribute float aMag;
attribute float aSeed;
attribute vec3 aTint;
varying vec3 vTint;
varying float vB;

void main() {
  vec3 d = normalize( uSkyRot * position );
  vec4 mv = viewMatrix * vec4( d, 0.0 );
  gl_Position = projectionMatrix * vec4( mv.xyz, 1.0 );
  gl_Position.z = gl_Position.w;

  // Atmospheric extinction: everything dims and reddens as it sinks, and is
  // gone a little below the true horizon. This is most of what makes a star
  // field sit *in* a landscape instead of behind a cut-out of one.
  float ext = smoothstep( -0.035, 0.16, d.y );
  // Magnitudes are a factor of 2.512 per step over seven stops from Sirius to
  // the faintest thing the eye can hold, which is a range no screen has. The
  // 0.46 exponent compresses it to about twelve to one - enough that the
  // bright stars are unmistakable and the faint ones are still there.
  float b = pow( 2.512, ( 1.6 - aMag ) * 0.46 ) * ext;

  // Scintillation, and only for the stars: a planet is a disc, not a point,
  // and famously does not twinkle. It gets stronger down near the horizon
  // where you are looking through more air.
  float low = 1.0 - smoothstep( 0.04, 0.42, d.y );
  float amp = uTwinkle * ( 0.10 + 0.42 * low );
  b *= 1.0 + amp * sin( uTime * ( 3.1 + aSeed * 8.0 ) + aSeed * 63.0 )
                 * ( 0.5 + 0.5 * sin( uTime * ( 1.7 + aSeed * 3.3 ) + aSeed * 11.0 ) );

  vB = b * uNight;
  vTint = mix( aTint, vec3( 1.0, 0.72, 0.52 ), ( 1.0 - ext ) * 0.75 );

  // Never smaller than two device pixels: a one-pixel star does not survive
  // the resolution scale, and a sky of half-lit single pixels is a sky with
  // no stars in it.
  gl_PointSize = clamp( 8.4 - aMag * 1.2, 2.0, 11.0 ) * uPix * uSizeBoost;
  if ( vB < 0.004 ) {
    // Cheaper than letting the rasteriser find out.
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    gl_PointSize = 0.0;
  }
}
`;

const SKY_FRAG = /* glsl */ `
precision mediump float;
varying vec3 vTint;
varying float vB;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot( q, q ) * 4.0;
  float core = exp( -r2 * 5.5 );
  // The faint cross on a bright star is not a lens artefact - it is what your
  // own eyelashes do, and leaving it out is what makes bright stars read as
  // small instead of brilliant.
  float flare = exp( -abs( q.x ) * 34.0 ) + exp( -abs( q.y ) * 34.0 );
  float a = core + flare * 0.05 * smoothstep( 0.9, 2.4, vB );
  gl_FragColor = vec4( vTint * a * vB, 1.0 );
}
`;

const LINE_VERT = /* glsl */ `
uniform mat3 uSkyRot;
uniform float uNight;
varying float vF;
void main() {
  vec3 d = normalize( uSkyRot * position );
  vec4 mv = viewMatrix * vec4( d, 0.0 );
  gl_Position = projectionMatrix * vec4( mv.xyz, 1.0 );
  gl_Position.z = gl_Position.w;
  vF = smoothstep( -0.01, 0.20, d.y ) * uNight;
}
`;

const LINE_FRAG = /* glsl */ `
precision mediump float;
uniform float uOpacity;
uniform vec3 uColor;
varying float vF;
void main() {
  gl_FragColor = vec4( uColor * vF * uOpacity, 1.0 );
}
`;

export class Stars {
  constructor(engine) {
    this.engine = engine;
    this.skyRot = new THREE.Matrix3();
    this.lat = 45 * DEG;
    this.latTarget = this.lat;
    this.lst = 0;

    // Meteors live in world space, not on the celestial sphere: they burn up
    // eighty kilometres overhead, which is the near side of the atmosphere,
    // not the far side of the galaxy. Four slots is plenty - two at once is
    // already a memorable night.
    // meteorA/B go straight into the sky shader as uniforms, so they carry
    // what it needs: head direction and glow, travel direction and trail
    // length. The bookkeeping lives alongside in meteorS.
    this.meteorA = [];
    this.meteorB = [];
    this.meteorS = [];
    for (let i = 0; i < 4; i++) {
      this.meteorA.push(new THREE.Vector4(0, 1, 0, 0));
      this.meteorB.push(new THREE.Vector4(0, 0, 1, 0.2));
      this.meteorS.push({ life: 0, life0: 1, speed: 0.5, bright: 1 });
    }

    this.uniforms = {
      uSkyRot: { value: this.skyRot },
      uNight: { value: 0 },
      uPix: { value: 1 },
      uTime: { value: 0 },
      uTwinkle: { value: 1 },
      uSizeBoost: { value: 1 },
    };
    this.lineUniforms = {
      uSkyRot: { value: this.skyRot },
      uNight: { value: 0 },
      uOpacity: { value: 0.10 },
      uColor: { value: new THREE.Color(0.42, 0.58, 0.95) },
    };
    this.planetUniforms = {
      uSkyRot: { value: this.skyRot },
      uNight: { value: 0 },
      uPix: { value: 1 },
      uTime: { value: 0 },
      uTwinkle: { value: 0 },
      uSizeBoost: { value: 1.5 },
    };

    this._buildCatalogue();
    this._buildLines();
    this._buildPlanets();
  }

  _pointMaterial(uniforms) {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      // Additive but *not* flagged transparent, so it stays in the opaque
      // queue and its negative renderOrder still means something. A
      // transparent star field draws after the terrain and hangs in front of
      // the hills.
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
  }

  _buildCatalogue() {
    // The catalogue, plus a procedural field of everything fainter. Naked-eye
    // stars run to about magnitude 6 and there are some nine thousand of them;
    // 2600 is enough for the sky to read as full, and they are all one draw.
    const cat = [];
    for (const c of CONSTELLATIONS) for (const s of c.stars) cat.push(s);
    for (const s of LONE_STARS) cat.push(s);
    for (const s of PLEIADES) cat.push(s);

    const FILL = 2600;
    const n = cat.length + FILL;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const seed = new Float32Array(n);
    const tint = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    const rgb = [0, 0, 0];

    for (let i = 0; i < cat.length; i++) {
      const [ra, dec, m, bv] = cat[i];
      raDec(ra, dec, v);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      mag[i] = m;
      seed[i] = (i * 0.6180339887) % 1;
      bvTint(bv, rgb);
      tint[i * 3] = rgb[0]; tint[i * 3 + 1] = rgb[1]; tint[i * 3 + 2] = rgb[2];
    }

    // The filler is drawn from a fixed sequence so every player's sky is the
    // same sky. Faint stars crowd toward the galactic plane, which is why the
    // Milky Way looks grainy rather than smooth at the edges.
    let s0 = 12345;
    const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
    const GP = new THREE.Vector3(-0.8678, -0.1970, 0.4560);
    for (let k = 0; k < FILL; k++) {
      const i = cat.length + k;
      let x, y, z, ok = false;
      for (let tries = 0; tries < 6 && !ok; tries++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * TAU;
        const r = Math.sqrt(Math.max(0, 1 - u * u));
        x = r * Math.cos(th); y = r * Math.sin(th); z = u;
        const b = Math.abs(x * GP.x + y * GP.y + z * GP.z);
        ok = rnd() < 0.45 + 0.55 * Math.exp(-(b * b) / 0.06);
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      // A magnitude distribution close to the real one: each magnitude step
      // has roughly three times as many stars as the one above it.
      mag[i] = 3.4 + Math.pow(rnd(), 0.42) * 2.9;
      seed[i] = rnd();
      bvTint(-0.2 + rnd() * 1.7, rgb);
      tint[i * 3] = rgb[0]; tint[i * 3 + 1] = rgb[1]; tint[i * 3 + 2] = rgb[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

    this.points = new THREE.Points(geo, this._pointMaterial(this.uniforms));
    this.points.frustumCulled = false;
    this.points.renderOrder = -999;
    this.points.visible = false;
    this.engine.scene.add(this.points);
  }

  _buildLines() {
    const v = new THREE.Vector3();
    const pos = [];
    for (const c of CONSTELLATIONS) {
      for (let i = 0; i < c.lines.length; i++) {
        const s = c.stars[c.lines[i]];
        raDec(s[0], s[1], v);
        pos.push(v.x, v.y, v.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.lineUniforms,
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -998;
    this.lines.visible = false;
    this.engine.scene.add(this.lines);
    // Off by default: the figures are there to be found, and a sky with the
    // joining lines always drawn is a planetarium, not a night.
    this.showFigures = false;
  }

  _buildPlanets() {
    const n = PLANETS.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(n), 1));
    const tint = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      tint[i * 3] = PLANETS[i].col[0];
      tint[i * 3 + 1] = PLANETS[i].col[1];
      tint[i * 3 + 2] = PLANETS[i].col[2];
    }
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    this.planets = new THREE.Points(geo, this._pointMaterial(this.planetUniforms));
    this.planets.frustumCulled = false;
    this.planets.renderOrder = -997;
    this.planets.visible = false;
    this.engine.scene.add(this.planets);
    this.planetDirs = PLANETS.map(() => new THREE.Vector3());
    this.planetMags = new Float32Array(n);
  }

  /** Latitude follows the region's climate; it eases so you never see it move. */
  setClimate(seaTemp, dt) {
    // -30 C is the far north, 35 C is the tropics. Beyond 68 degrees the sun
    // would stop setting in summer, which is a lovely thing in a photograph
    // and a miserable thing in a game.
    this.latTarget = clamp(5 + (35 - seaTemp) * 1.05, -8, 68) * DEG;
    this.lat += (this.latTarget - this.lat) * (1 - Math.exp(-dt * 0.05));
  }

  /**
   * Build the celestial frame for this instant. Split out from update()
   * because the sun's own direction comes out of it, and the sun's direction
   * is what decides whether it is night at all.
   */
  frame(dayFrac, sunEq) {
    // Local sidereal time, pinned so the sun transits at local noon. Because
    // the sun's own right ascension creeps round the ecliptic over the year,
    // this quietly gives the sidereal day its four-minute lead - the stars do
    // come round earlier every night.
    const raSun = Math.atan2(sunEq.y, sunEq.x);
    this.lst = raSun + (dayFrac - 0.5) * TAU;
    celestialFrame(this.lst, this.lat, this.skyRot);
  }

  /**
   * @param dayFrac  fractional day, 0..1
   * @param day      whole days since the world began
   * @param nightF   0 in daylight, 1 when the sky is dark enough for stars
   */
  update(dt, dayFrac, day, nightF) {
    const days = day + dayFrac;
    const t = this.uniforms.uTime.value + dt;
    const pix = this.engine.renderer.getPixelRatio();
    for (const u of [this.uniforms, this.planetUniforms]) {
      u.uNight.value = nightF;
      u.uTime.value = t;
      u.uPix.value = pix;
    }
    this.lineUniforms.uNight.value = nightF;

    const out = nightF > 0.004 && !this._underwater;
    this.points.visible = out;
    this.lines.visible = out && this.showFigures;
    this.planets.visible = out;

    this._updatePlanets(days);
    this._updateMeteors(dt, nightF, days);
  }

  _updatePlanets(days) {
    const years = days / YEAR;
    const lonSun = TAU * (years + 0.21);
    const lonEarth = lonSun + Math.PI;
    const ex = Math.cos(lonEarth), ey = Math.sin(lonEarth);

    const pos = this.planets.geometry.attributes.position;
    const mag = this.planets.geometry.attributes.aMag;
    const v = SCRATCH;
    for (let i = 0; i < PLANETS.length; i++) {
      const p = PLANETS[i];
      const L = p.L0 + TAU * years / p.T;
      const px = p.a * Math.cos(L), py = p.a * Math.sin(L);
      const pz = p.a * Math.sin(p.inc) * Math.sin(L - 1.2);
      // Geocentric, in ecliptic coordinates, then equatorial, then the sky.
      const gx = px - ex, gy = py - ey, gz = pz;
      const d = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1e-6;
      const lon = Math.atan2(gy, gx);
      const latEc = Math.asin(clamp(gz / d, -1, 1));
      eclipticToEquatorial(lon, latEc, v);
      this.planetDirs[i].copy(v);
      pos.setXYZ(i, v.x, v.y, v.z);

      // Apparent magnitude. The illuminated fraction matters for Mercury and
      // Venus, which is exactly why Venus is at its most brilliant as a fat
      // crescent low in the dusk rather than as a full disc behind the sun.
      let m = p.H + 5 * Math.log10(Math.max(0.05, p.a * d));
      if (p.inner) {
        const cosPh = clamp((p.a * p.a + d * d - 1) / (2 * p.a * d), -1, 1);
        const k = 0.5 * (1 + cosPh);
        m += -2.5 * Math.log10(Math.max(0.02, k));
      }
      this.planetMags[i] = m;
      mag.setX(i, m);
    }
    pos.needsUpdate = true;
    mag.needsUpdate = true;
  }

  _updateMeteors(dt, nightF, days) {
    for (let i = 0; i < this.meteorA.length; i++) {
      const a = this.meteorA[i], b = this.meteorB[i], s = this.meteorS[i];
      if (s.life <= 0) { a.w = 0; continue; }
      s.life = Math.max(0, s.life - dt);
      const step = s.speed * dt;
      a.x += b.x * step; a.y += b.y * step; a.z += b.z * step;
      const l = Math.hypot(a.x, a.y, a.z) || 1;
      a.x /= l; a.y /= l; a.z /= l;
      // They brighten as they drop into thicker air, then snuff out.
      const k = s.life / s.life0;
      a.w = s.life > 0 ? s.bright * smoothstep(0, 0.25, 1 - k) * smoothstep(0, 0.45, k) : 0;
    }

    if (nightF < 0.25) return;
    // A shower a few nights a year, when the world crosses a debris trail. On
    // an ordinary night you wait a minute or two between meteors; during a
    // shower they come every few seconds and all radiate from one point.
    const showerPhase = (days / YEAR) * 7.0;
    const shower = Math.pow(saturate(Math.sin(showerPhase * TAU) * 6.5 - 5.2), 1.5);
    const rate = (0.045 + shower * 0.55) * nightF;
    if (Math.random() > rate * dt) return;
    this.spawnMeteor(shower > 0.3 ? showerPhase : 0);
  }

  /**
   * Launch one meteor. `radiant` non-zero picks the fixed radiant of that
   * shower, so every trail on a shower night points back to one spot.
   */
  spawnMeteor(radiant = 0) {
    let slot = -1;
    for (let i = 0; i < this.meteorS.length; i++) if (this.meteorS[i].life <= 0) { slot = i; break; }
    if (slot < 0) return;

    // Radiant: fixed on the sky during a shower, anywhere at all otherwise.
    let dx, dy, dz;
    if (radiant) {
      const r = Math.floor(radiant) * 2.399963;
      dx = Math.cos(r) * 0.62; dz = Math.sin(r) * 0.62; dy = 0.48;
      const jitter = 0.55;
      dx += (Math.random() - 0.5) * jitter;
      dy += (Math.random() - 0.5) * jitter * 0.7;
      dz += (Math.random() - 0.5) * jitter;
    } else {
      const th = Math.random() * TAU;
      const el = 0.05 + Math.random() * 0.9;
      const r = Math.sqrt(Math.max(0, 1 - el * el));
      dx = r * Math.cos(th); dy = el; dz = r * Math.sin(th);
    }
    const head = new THREE.Vector3(dx, dy, dz).normalize();
    // Travel direction: any tangent to the sphere at the head.
    const tan = new THREE.Vector3(-head.z, 0, head.x);
    if (tan.lengthSq() < 1e-6) tan.set(1, 0, 0);
    tan.normalize();
    const perp = new THREE.Vector3().crossVectors(head, tan);
    const ang = Math.random() * TAU;
    tan.multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();

    // One in about twenty is a fireball: slower, longer, and bright enough to
    // notice out of the corner of your eye.
    const fire = Math.random() < 0.05;
    const life = fire ? 1.1 + Math.random() * 0.8 : 0.35 + Math.random() * 0.5;
    this.meteorA[slot].set(head.x, head.y, head.z, 0.001);
    this.meteorB[slot].set(tan.x, tan.y, tan.z, (fire ? 0.30 : 0.10) + Math.random() * 0.12);
    const s = this.meteorS[slot];
    s.life = s.life0 = life;
    s.speed = (fire ? 0.28 : 0.65) + Math.random() * 0.4;
    s.bright = fire ? 2.6 : 0.7 + Math.random() * 0.9;
    this.fireball = fire;
    this.meteorCount = (this.meteorCount || 0) + 1;
  }

  setUnderwater(v) {
    this._underwater = v;
  }
}

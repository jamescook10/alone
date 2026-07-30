// Sky, sun, moon, stars, aurora - and the day/night cycle that drives every
// light in the world.
//
// The sky is a simple vertical gradient between palette stops keyed to the
// sun's elevation: pale blue at noon, peach and pink around sunset, deep
// indigo at night. The same two gradient colours feed the fog, the lights and
// the water, so the horizon never shows a seam - agreement by construction
// instead of by keeping two scattering models in step.

import * as THREE from 'three';
import { atmo } from '../gfx/atmosphere.js';
import { detailTexture } from '../gfx/materials.js';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';

const TAU = Math.PI * 2;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunTint;
uniform float uStars;
uniform float uAurora;
uniform float uMoonPhase;
uniform sampler2D tNoise;
uniform float uUnderwater;
uniform vec3 uWaterFog;

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

float fbmTex( vec2 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 4; i++ ) {
    v += a * ( texture2D( tNoise, p ).r - 0.5 );
    p = p * 2.03 + vec2( 3.1, 1.7 );
    a *= 0.52;
  }
  return v;
}

void main() {
  vec3 dir = normalize( vDir );

  if ( uUnderwater > 0.5 ) {
    gl_FragColor = vec4( uWaterFog * ( 0.5 + 0.5 * smoothstep( -0.2, 0.8, dir.y ) ), 1.0 );
    return;
  }

  float day = smoothstep( -0.22, 0.10, uSunDir.y );

  // The gradient. The 0.6 exponent keeps a broad bright band at the horizon,
  // which is most of what makes a clear sky read as open air.
  vec3 col = mix( uHorizon, uZenith, pow( clamp( dir.y, 0.0, 1.0 ), 0.60 ) );

  // A warm wash around the sun's compass direction, strongest at the horizon
  // and around sunrise/sunset. This is the whole "sunset" effect now.
  float sunAmt = pow( max( dot( dir, uSunDir ), 0.0 ), 3.0 );
  float low = 1.0 - smoothstep( 0.02, 0.38, uSunDir.y );
  col = mix( col, uSunTint, sunAmt * ( 0.20 + low * 0.45 ) * smoothstep( -0.12, 0.02, uSunDir.y ) );

  /* stars ------------------------------------------------------------- */
  float nightF = ( 1.0 - day ) * uStars;
  if ( nightF > 0.002 && dir.y > -0.05 ) {
    vec3 sp = dir * 190.0;
    vec3 cell = floor( sp );
    float h = hash13( cell );
    if ( h > 0.982 ) {
      vec3 jitter = vec3( hash13( cell + 1.3 ), hash13( cell + 7.7 ), hash13( cell + 13.1 ) );
      vec3 starPos = ( cell + jitter ) / 190.0;
      float d = distance( normalize( starPos ), dir );
      float mag = ( h - 0.982 ) / 0.018;
      float tw = 0.72 + 0.28 * sin( uTime * ( 1.6 + mag * 5.0 ) + h * 90.0 );
      float s = smoothstep( 0.0035, 0.0, d ) * mag * tw;
      vec3 tint = mix( vec3( 0.75, 0.83, 1.0 ), vec3( 1.0, 0.86, 0.7 ), hash13( cell + 21.0 ) );
      col += tint * s * 1.6 * nightF * smoothstep( -0.02, 0.16, dir.y );
    }
    // Milky way: a soft band of unresolved stars.
    float band = exp( -pow( ( dot( dir, normalize( vec3( 0.42, 0.30, -0.85 ) ) ) ) * 3.4, 2.0 ) );
    float mw = 0.55 + 0.45 * ( texture2D( tNoise, dir.xz * 0.42 + dir.y * 0.2 ).r );
    col += vec3( 0.30, 0.34, 0.52 ) * band * mw * 0.028 * nightF * smoothstep( -0.02, 0.2, dir.y );
  }

  /* aurora ------------------------------------------------------------ */
  if ( uAurora > 0.01 && dir.y > 0.02 && day < 0.4 ) {
    float t = uTime * 0.055;
    vec2 ap = vec2( atan( dir.z, dir.x ) * 1.6, dir.y * 3.4 );
    float curtain = 0.0;
    for ( int i = 0; i < 3; i++ ) {
      float fi = float( i );
      float wave = sin( ap.x * ( 1.7 + fi * 0.6 ) + t * ( 1.0 + fi * 0.35 ) + fi * 2.1 ) * 0.30;
      float band = exp( -pow( ( ap.y - 0.85 - wave - fi * 0.22 ) * 3.2, 2.0 ) );
      float flick = 0.55 + 0.45 * fbmTex( vec2( ap.x * 0.9 + t * 1.6, fi * 4.0 ) );
      curtain += band * flick;
    }
    vec3 auroraCol = mix( vec3( 0.15, 0.95, 0.55 ), vec3( 0.45, 0.35, 0.95 ), smoothstep( 0.1, 0.7, dir.y ) );
    col += auroraCol * curtain * uAurora * ( 1.0 - day ) * 0.30;
  }

  /* sun and moon ------------------------------------------------------ */
  float sunD = distance( dir, uSunDir );
  float sunDisc = smoothstep( 0.0145, 0.0095, sunD );
  float sunGlow = exp( -sunD * 7.0 ) * 0.30;
  col += uSunTint * ( sunDisc * 3.2 + sunGlow ) * smoothstep( -0.06, 0.02, uSunDir.y );

  float moonD = distance( dir, uMoonDir );
  if ( moonD < 0.09 ) {
    float disc = smoothstep( 0.019, 0.0135, moonD );
    // Terminator: shade the limb away from the sun.
    vec3 up = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) );
    float across = dot( normalize( dir - uMoonDir * dot( dir, uMoonDir ) ), up );
    float phase = smoothstep( -0.9, 0.9, across * sign( uMoonPhase - 0.5 ) + ( uMoonPhase * 2.0 - 1.0 ) * 1.6 );
    float craters = 0.82 + 0.18 * fbmTex( dir.xz * 42.0 + dir.y * 9.0 );
    col += vec3( 0.95, 0.94, 0.88 ) * disc * phase * craters * 2.4 * ( 1.0 - day * 0.75 );
  }
  col += vec3( 0.5, 0.53, 0.62 ) * exp( -moonD * 12.0 ) * 0.09 * uMoonPhase * ( 1.0 - day * 0.9 );

  // Ground haze below the horizon so there is no hard edge at the sea line.
  col = mix( col, col * 0.55 + vec3( 0.05, 0.06, 0.07 ), smoothstep( 0.0, -0.12, dir.y ) );

  // A whisper of dither: a two-stop gradient over the whole dome bands
  // visibly in 8 bits without it.
  col += ( hash13( vec3( dir.xy * 1371.0, uTime ) ) - 0.5 ) * 0.006;

  gl_FragColor = vec4( col, 1.0 );
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = p.xyww;
}
`;

/**
 * The palette. Each stop is keyed to the sun's elevation (sin of altitude)
 * and authored in sRGB, converted to the linear working space once at boot.
 * zen/hor are the gradient, sun is both the disc tint and the light colour.
 */
const STOPS = [
  { y: -0.40, zen: [0.020, 0.024, 0.075], hor: [0.052, 0.060, 0.130], sun: [1.0, 0.55, 0.30], sunI: 0.0 },
  { y: -0.12, zen: [0.075, 0.075, 0.200], hor: [0.240, 0.170, 0.280], sun: [1.0, 0.48, 0.26], sunI: 0.0 },
  { y: 0.02, zen: [0.355, 0.360, 0.610], hor: [0.995, 0.640, 0.480], sun: [1.0, 0.55, 0.30], sunI: 0.35 },
  { y: 0.14, zen: [0.400, 0.575, 0.840], hor: [0.980, 0.800, 0.640], sun: [1.0, 0.80, 0.55], sunI: 0.85 },
  { y: 0.42, zen: [0.445, 0.665, 0.930], hor: [0.840, 0.910, 0.965], sun: [1.0, 0.97, 0.90], sunI: 1.0 },
];
for (const s of STOPS) {
  s.zenC = new THREE.Color().setRGB(...s.zen, THREE.SRGBColorSpace);
  s.horC = new THREE.Color().setRGB(...s.hor, THREE.SRGBColorSpace);
  s.sunC = new THREE.Color().setRGB(...s.sun, THREE.SRGBColorSpace);
}

const GREY = new THREE.Color();

export class Sky {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.dayLength = opts.dayLength || 1500; // seconds of real time per day
    this.time = opts.startTime !== undefined ? opts.startTime : 0.30; // 0..1, 0.25 = sunrise
    this.day = 0;

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color(0.2, 0.4, 0.8) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uSunTint: { value: new THREE.Color(1, 0.9, 0.8) },
      uStars: { value: 1 },
      uAurora: { value: 0 },
      uMoonPhase: { value: 0.7 },
      tNoise: { value: detailTexture() },
      uUnderwater: { value: 0 },
      uWaterFog: { value: new THREE.Color(0.06, 0.2, 0.26) },
    };

    const geo = new THREE.BoxGeometry(2, 2, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    engine.scene.add(this.mesh);

    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.zenithColor = new THREE.Color();
    this.ambientColor = new THREE.Color();
    this.groundColor = new THREE.Color();
    this.sunIntensity = 0;
    this.dayFactor = 1;
    this.ambientLevel = 0.3;
    this.cloudDim = 1;
    this.moonIntensity = 0;
    this.exposure = 1;
  }

  /** Hours as a 0..24 float, for the UI. */
  get hours() {
    return (this.time * 24) % 24;
  }

  get timeName() {
    const h = this.hours;
    if (h < 5) return 'night';
    if (h < 6.5) return 'first light';
    if (h < 8) return 'dawn';
    if (h < 11) return 'morning';
    if (h < 13.5) return 'midday';
    if (h < 17) return 'afternoon';
    if (h < 19) return 'golden hour';
    if (h < 20.5) return 'dusk';
    if (h < 22) return 'twilight';
    return 'night';
  }

  update(dt, camera, weather) {
    this.time += dt / this.dayLength;
    while (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    const t = this.time;
    this.uniforms.uTime.value += dt;

    // Sun on an inclined path; the inclination drifts to give seasons.
    const season = Math.sin((this.day / 48) * TAU) * 0.38;
    const a = (t - 0.25) * TAU;
    const ct = Math.cos(season);
    const st = Math.sin(season);
    this.sunDir.set(Math.cos(a), Math.sin(a) * ct, -Math.sin(a) * st - 0.18).normalize();

    // The moon runs slightly slower than the sun, so its phase evolves.
    const ma = a + Math.PI + (this.day * 0.42 + t * 0.03) * 0.5;
    this.moonDir.set(Math.cos(ma), Math.sin(ma) * 0.94, -Math.sin(ma) * 0.2 + 0.24).normalize();
    const phase = 0.5 - 0.5 * this.sunDir.dot(this.moonDir);
    this.uniforms.uMoonPhase.value = phase;

    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uMoonDir.value.copy(this.moonDir);

    if (weather) {
      this.uniforms.uAurora.value = weather.aurora;
      this.uniforms.uStars.value = 1 - weather.overcast * 0.92;
    }

    this._computeColors(weather);
    this._applyLights(weather);

    if (camera) this.mesh.position.copy(camera.position);
  }

  /** Sample the palette at a sun elevation. Outputs are linear colours. */
  _palette(sy, zen, hor, sun) {
    let i = 0;
    while (i < STOPS.length - 2 && sy > STOPS[i + 1].y) i++;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    const k = smoothstep(a.y, b.y, clamp(sy, a.y, b.y));
    zen.copy(a.zenC).lerp(b.zenC, k);
    hor.copy(a.horC).lerp(b.horC, k);
    sun.copy(a.sunC).lerp(b.sunC, k);
    return lerp(a.sunI, b.sunI, k);
  }

  _computeColors(weather) {
    const sy = this.sunDir.y;
    this.dayFactor = smoothstep(-0.22, 0.10, sy);

    this.sunIntensity = this._palette(sy, this.zenithColor, this.horizonColor, this.sunColor);

    let cloudDim = 1;
    if (weather) {
      // Overcast greys the gradient toward its own luminance; the direct sun
      // dims separately, so an overcast noon stays a bright grey afternoon
      // instead of collapsing to dusk.
      cloudDim = lerp(1, 0.55, weather.overcast) * lerp(1, 0.72, weather.cloudDark);
      const grey = (c, m) => {
        const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
        GREY.setRGB(l * 0.96, l * 0.99, l * 1.05);
        c.lerp(GREY, m);
      };
      grey(this.zenithColor, weather.overcast * 0.85);
      grey(this.horizonColor, weather.overcast * 0.80);
      const dk = lerp(1, 0.72, weather.cloudDark * weather.overcast);
      this.zenithColor.multiplyScalar(dk);
      this.horizonColor.multiplyScalar(dk);
    }
    this.cloudDim = cloudDim;

    const moonUp = smoothstep(-0.08, 0.20, this.moonDir.y);
    this.moonIntensity = moonUp * this.uniforms.uMoonPhase.value * (1 - this.dayFactor);

    // Skylight: hue between the two gradient stops, level from their size.
    this.ambientColor.copy(this.horizonColor).lerp(this.zenithColor, 0.5);
    const amb = Math.max(this.ambientColor.r, this.ambientColor.g, this.ambientColor.b);
    if (amb > 1e-5) this.ambientColor.multiplyScalar(1 / amb); // hue only; brightness lives in intensity
    this.ambientLevel = amb;
    this.groundColor.setRGB(0.42, 0.38, 0.30).lerp(this.ambientColor, 0.35);

    // Share with the sky dome and with every material in the world.
    this.uniforms.uZenith.value.copy(this.zenithColor);
    this.uniforms.uHorizon.value.copy(this.horizonColor);
    this.uniforms.uSunTint.value.copy(this.sunColor).multiplyScalar(0.35 + 0.85 * this.sunIntensity * cloudDim);
    atmo.uSunDir.value.copy(this.sunDir);
    atmo.uSunColor.value.copy(this.sunColor).multiplyScalar((0.15 + 0.55 * this.sunIntensity) * cloudDim);
    atmo.uHorizonColor.value.copy(this.horizonColor);
    atmo.uZenithColor.value.copy(this.zenithColor);
  }

  _applyLights(weather) {
    const e = this.engine;
    const dim = this.cloudDim;
    e.sun.color.copy(this.sunColor);
    e.sun.intensity = this.sunIntensity * 3.1 * dim;
    e.sun.visible = e.sun.intensity > 0.01;

    e.moon.color.setRGB(0.52, 0.64, 0.96);
    e.moon.intensity = this.moonIntensity * 0.22 * dim;
    e.moon.visible = e.moon.intensity > 0.004;

    e.hemi.color.copy(this.ambientColor);
    e.hemi.groundColor.copy(this.groundColor);
    // Skylight scales with the gradient's brightness, with a floor so night
    // shadows stay readable rather than pitch black - the "lifted shadows"
    // half of the flat look. The floor is small enough that unlit ground
    // still sits below the night sky's horizon band.
    e.hemi.intensity = (0.05 + this.ambientLevel * 1.55) * lerp(1, 0.85, weather ? weather.overcast : 0)
      + this.moonIntensity * 0.22;
  }

  /** Place the shadow-casting light relative to the player. */
  positionLights(target) {
    const e = this.engine;
    const d = 260;
    e.sun.target.position.copy(target);
    e.sun.position.copy(target).addScaledVector(this.sunDir, d);
    e.sun.target.updateMatrixWorld();
    e.moon.target.position.copy(target);
    e.moon.position.copy(target).addScaledVector(this.moonDir, d);
    e.moon.target.updateMatrixWorld();
  }

  /** Sky colour in a given direction - the same mix the fog uses. */
  radianceAt(dir, out = new THREE.Color()) {
    return out.copy(this.horizonColor).lerp(this.zenithColor, saturate(dir.y * 1.3));
  }

  setUnderwater(v, fogColor) {
    this.uniforms.uUnderwater.value = v ? 1 : 0;
    if (fogColor) this.uniforms.uWaterFog.value.copy(fogColor);
  }
}

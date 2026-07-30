// Sky, sun, moon, stars, clouds, aurora - and the day/night cycle that drives
// every light in the world.
//
// The sky shader and the CPU-side colour model are deliberately the same
// approximation, so the fog on a distant mountain is exactly the colour of the
// sky just above it.

import * as THREE from 'three';
import { atmo } from '../gfx/atmosphere.js';
import { detailTexture } from '../gfx/materials.js';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';

const TAU = Math.PI * 2;

// Shared between the shader and the CPU model below. They must agree, or the
// fog on a distant ridge will not match the sky behind it.
// 0.145: at 0.105 the whole sky metered dimmer than sunlit grass, which
// inverted the contrast of every daytime frame. Raising it brightens sky,
// fog and skylight together; adaptation then stops the ground at a level
// below the sky, the way a camera would.
const SKY_SCALE = 0.145;
const BETA_R = [5.5, 13.0, 22.4];
const BETA_M = 21.0;
// A tighter forward lobe than the classic 0.8: at 0.8 the Mie halo was a
// 30-degree white blob that washed out half the sky whenever the sun was in
// frame. The amount is weather-driven - see update() - so a dry clear day
// gets a compact brilliant sun and a humid one gets its haze back.
const MIE_G = 0.87;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uTime;
uniform float uDayT;
uniform float uCloudCover;
uniform float uCloudDark;
uniform float uOvercast;
uniform float uStars;
uniform float uAurora;
uniform float uMoonPhase;
uniform float uHaze;
uniform float uMieK;
uniform vec2 uWind;
uniform sampler2D tNoise;
uniform float uUnderwater;
uniform vec3 uWaterFog;
uniform float uExposure;

const vec3 betaR = vec3( 5.5, 13.0, 22.4 );
const float betaM = 21.0;
#define SKY_SCALE 0.145

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

// The same fbm, but forced down the mip chain. Cloud rays that graze the
// horizon cover enormous distances per pixel; without this bias the sky
// dissolves into shimmering static.
float fbmTexBias( vec2 p, float bias ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 4; i++ ) {
    v += a * ( texture2D( tNoise, p, bias ).r - 0.5 );
    p = p * 2.03 + vec2( 3.1, 1.7 );
    a *= 0.52;
    bias += 0.5;
  }
  return v;
}

// Single-scattering approximation. Not physically exact, but it has the
// behaviours that matter: blue overhead, bright band at the horizon, and a
// long red sunset when the sun grazes the atmosphere.
vec3 skyRadiance( vec3 dir, vec3 sun ) {
  float y = max( dir.y, -0.10 );
  float mu = clamp( dot( dir, sun ), -1.0, 1.0 );
  // Flatter than 1/(y+0.22): that curve made the zenith a quarter of the
  // horizon's brightness and the top of every daytime frame read as dusk.
  float airMass = 1.0 / ( y * 0.60 + 0.28 );
  float sunPath = 1.0 / ( max( sun.y, 0.0 ) + 0.085 );

  float phaseR = 0.0596831 * ( 1.0 + mu * mu );
  float g = 0.87;
  // The HG lobe peaks near 110x, which - through the eye adaptation that
  // pins apparent sky brightness - turned into a halo across half the frame.
  // Capping the peak flattens only the inner ~6 degrees; the sun disc itself
  // carries the core brightness.
  float phaseM = min( 0.1193662 * ( ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * mu, 1e-4 ), 1.5 ) ), 4.0 );

  vec3 transmit = exp( -betaR * 0.0118 * sunPath );
  vec3 col = ( betaR * phaseR + vec3( betaM ) * phaseM * uMieK ) * airMass * SKY_SCALE * transmit;

  // Daylight fade: below the horizon the sun contributes almost nothing.
  float day = smoothstep( -0.22, 0.10, sun.y );
  col *= day;

  // Night sky: a cold, deep blue that never quite reaches black.
  vec3 night = vec3( 0.008, 0.014, 0.032 ) * ( 0.55 + 0.45 * airMass * 0.28 );
  float moonUp = smoothstep( -0.10, 0.22, uMoonDir.y ) * uMoonPhase;
  night += vec3( 0.012, 0.017, 0.032 ) * moonUp * ( 0.4 + 0.6 * pow( max( dot( dir, uMoonDir ), 0.0 ), 3.0 ) );
  col += night * ( 1.0 - day );

  // Horizon haze.
  col = mix( col, col * 0.72 + vec3( 0.10, 0.12, 0.15 ) * ( 0.3 + day ), uHaze * smoothstep( 0.30, -0.02, dir.y ) );
  return col;
}

void main() {
  vec3 dir = normalize( vDir );

  if ( uUnderwater > 0.5 ) {
    gl_FragColor = vec4( uWaterFog * ( 0.5 + 0.5 * smoothstep( -0.2, 0.8, dir.y ) ), 1.0 );
    return;
  }

  vec3 col = skyRadiance( dir, uSunDir );
  float day = smoothstep( -0.22, 0.10, uSunDir.y );

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
  float sunDisc = smoothstep( 0.0125, 0.0075, sunD );
  float sunGlow = exp( -sunD * 9.0 ) * 0.35 + exp( -sunD * 2.2 ) * 0.09;
  vec3 sunTint = mix( vec3( 1.0, 0.42, 0.16 ), vec3( 1.0, 0.96, 0.90 ), smoothstep( -0.02, 0.28, uSunDir.y ) );
  col += sunTint * ( sunDisc * 14.0 + sunGlow * 2.6 ) * smoothstep( -0.06, 0.02, uSunDir.y );

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

  /* high cirrus -------------------------------------------------------- */
  // A thin streaky sheet far above the cumulus slab. It catches the sun's
  // tint long after the low clouds have gone grey, which is most of what a
  // good sunset is. Threshold high: only the ridges of the noise survive, so
  // a clear sky stays clear instead of going uniformly mottled.
  if ( dir.y > 0.012 && uOvercast < 0.85 ) {
    float tR = 7800.0 / max( dir.y, 0.06 );
    vec2 pc = dir.xz * tR * 0.000045 + uWind * uTime * 0.00088;
    float cf = fbmTexBias( pc * vec2( 0.7, 3.2 ), log2( 1.0 + tR * 0.0011 ) ) + 0.5;
    float sunAmtC = pow( max( dot( dir, uSunDir ), 0.0 ), 5.0 );
    float cirr = smoothstep( 0.70, 0.92, cf ) * 0.30 * ( 1.0 - uOvercast );
    cirr *= 0.35 + 0.85 * uCloudCover;
    // Strongest where it catches the sun. Spread evenly it stopped being
    // cloud and became grime on the whole sky.
    cirr *= 0.25 + 0.75 * sunAmtC;
    cirr *= smoothstep( 0.012, 0.10, dir.y );
    vec3 cirrCol = mix( vec3( 0.92, 0.94, 0.99 ), sunTint * 1.25, sunAmtC * 0.65 ) * ( 0.12 + 0.88 * day );
    // Ice cloud scatters light in: it can only brighten the sky behind it.
    // A plain mix let it grey out the glow around the sun instead.
    col = mix( col, max( cirrCol, col ), cirr );
  }

  /* clouds ------------------------------------------------------------ */
  if ( dir.y > 0.005 && uCloudCover > 0.001 ) {
    vec2 windOff = uWind * uTime * 0.0016;
    float dens = 0.0;
    float lit = 0.0;
    const int STEPS = 5;
    for ( int i = 0; i < STEPS; i++ ) {
      float fi = float( i ) / float( STEPS - 1 );
      float hgt = mix( 900.0, 2100.0, fi );
      float tRay = min( hgt / max( dir.y, 0.02 ), 60000.0 );
      float bias = log2( 1.0 + tRay * 0.0026 );
      vec2 p = dir.xz * tRay * 0.00030 + windOff * ( 1.0 + fi * 0.15 );
      float f = fbmTexBias( p, bias ) + 0.5;
      // Narrow band, steep cover response: at low cover only the strongest
      // noise ridges become cloud, so "clear" means clear - the old edges
      // laid faint grey mottle over the entire sky at 0.16 cover.
      float shape = smoothstep( 0.99 - uCloudCover * 0.80, 1.08 - uCloudCover * 0.58, f + 0.30 );
      // thinner at the top of the slab gives rounded tops
      shape *= 1.0 - abs( fi - 0.42 ) * 1.15;
      dens += max( shape, 0.0 );
      lit += max( shape, 0.0 ) * ( 1.0 - fi );
    }
    dens = clamp( dens / float( STEPS ) * 2.6, 0.0, 1.0 );
    dens *= smoothstep( 0.012, 0.16, dir.y );
    float shade = clamp( lit / max( dens * float( STEPS ), 0.001 ) * 0.6, 0.0, 1.0 );

    float sunAmt = pow( max( dot( dir, uSunDir ), 0.0 ), 6.0 );
    vec3 cloudLit = mix( vec3( 0.95, 0.95, 0.97 ), sunTint * 1.15, 0.35 ) * ( 0.35 + 0.65 * day );
    vec3 cloudDark = mix( vec3( 0.23, 0.26, 0.33 ), vec3( 0.10, 0.11, 0.15 ), uCloudDark ) * ( 0.30 + 0.70 * day );
    vec3 cc = mix( cloudDark, cloudLit, shade );
    cc += sunTint * sunAmt * 0.5 * day * ( 1.0 - uCloudDark * 0.6 );
    col = mix( col, cc, dens * mix( 0.92, 0.99, uOvercast ) );
  }

  // Ground haze below the horizon so there is no hard edge at the sea line.
  col = mix( col, col * 0.55 + vec3( 0.05, 0.06, 0.07 ), smoothstep( 0.0, -0.12, dir.y ) );

  gl_FragColor = vec4( col * uExposure, 1.0 );
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

const RGB_A = [0, 0, 0];
const RGB_B = [0, 0, 0];
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
      uDayT: { value: this.time },
      uCloudCover: { value: 0.35 },
      uCloudDark: { value: 0.0 },
      uOvercast: { value: 0 },
      uStars: { value: 1 },
      uAurora: { value: 0 },
      uMoonPhase: { value: 0.7 },
      uHaze: { value: 0.35 },
      uMieK: { value: 0.20 },
      uWind: { value: new THREE.Vector2(1, 0.2) },
      tNoise: { value: detailTexture() },
      uUnderwater: { value: 0 },
      uWaterFog: { value: new THREE.Color(0.06, 0.2, 0.26) },
      uExposure: { value: 1.0 },
    };

    // The ground-shadow field every world material samples uses the same
    // noise the sky's clouds are built from.
    atmo.tAtmoNoise.value = detailTexture();

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

    // Environment probe: the same sky shader rendered into a small cubemap
    // and prefiltered, so every rough or wet surface picks up real sky
    // reflection that tracks the time of day. Refreshed every couple of
    // seconds - the sun does not move faster than that.
    this._envScene = new THREE.Scene();
    this._envScene.add(new THREE.Mesh(geo, mat));
    this._envRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
    this._envCam = new THREE.CubeCamera(0.1, 50, this._envRT);
    this._pmrem = new THREE.PMREMGenerator(engine.renderer);
    this._pmrem.compileCubemapShader();
    this._envOut = null;
    this._envT = 0;

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
    this.mieK = 0.20;
    this.cloudDim = 1;
    this.moonIntensity = 0;
    this._tmp = new THREE.Vector3();
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
    this.uniforms.uDayT.value = t;

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
      this.uniforms.uCloudCover.value = weather.cloudCover;
      this.uniforms.uCloudDark.value = weather.cloudDark;
      this.uniforms.uOvercast.value = weather.overcast;
      this.uniforms.uHaze.value = 0.10 + weather.humidity * 0.30 + weather.fog * 0.45;
      this.uniforms.uWind.value.set(weather.windDir.x, weather.windDir.y);
      this.uniforms.uAurora.value = weather.aurora;
      // How much air is in the air. Shader and CPU model share this value,
      // or the fog on a ridge would stop matching the sky behind it.
      const mieT = saturate(-0.05 + weather.humidity * 0.50 + weather.fog * 1.4 + weather.overcast * 0.40);
      this.mieK = lerp(0.10, 0.46, mieT);
      this.uniforms.uMieK.value = this.mieK;
    }

    this._computeColors(weather);
    this._applyLights(weather);
    this._adapt(dt);

    // Cloud shadows: patchy skies cast sweeping dapples; full overcast has
    // already dimmed the sun itself, so its patchiness fades out rather than
    // double-darkening. Strength carries the sun term so night costs nothing.
    const cover = weather ? weather.cloudCover : this.uniforms.uCloudCover.value;
    const over = weather ? weather.overcast : 0;
    const patchy = saturate(cover * 1.6 - 0.10) * (1 - over * 0.85);
    atmo.uCloudShadow.value = Math.min(0.62, patchy * this.sunIntensity * this.cloudDim);
    atmo.uCloudShadowCover.value = cover;
    const drift = dt * 0.0011;
    atmo.uCloudOff.value.x += (weather ? weather.windDir.x : 1) * drift;
    atmo.uCloudOff.value.y += (weather ? weather.windDir.y : 0.2) * drift;

    this._envT -= dt;
    if (this._envT <= 0) {
      this._envT = 2.0;
      const renderer = this.engine.renderer;
      this._envCam.update(renderer, this._envScene);
      const out = this._pmrem.fromCubemap(this._envRT.texture);
      if (this._envOut) this._envOut.dispose();
      this._envOut = out;
      this.engine.scene.environment = out.texture;
    }
    this.engine.scene.environmentIntensity = this.uniforms.uUnderwater.value > 0.5 ? 0.08 : 0.5;

    if (camera) this.mesh.position.copy(camera.position);
  }

  /**
   * A direct port of skyRadiance() from the shader above. Fog, lights and
   * water reflections all read from this, which is why the horizon never
   * shows a seam between the sky and the land in front of it.
   */
  _radiance(dx, dy, dz, out) {
    const sun = this.sunDir;
    const y = Math.max(dy, -0.1);
    const mu = clamp(dx * sun.x + dy * sun.y + dz * sun.z, -1, 1);
    const airMass = 1 / (y * 0.60 + 0.28);
    const sunPath = 1 / (Math.max(sun.y, 0) + 0.085);
    const phaseR = 0.0596831 * (1 + mu * mu);
    const g = MIE_G;
    const phaseM = Math.min(0.1193662 * ((1 - g * g) / Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5)), 4.0);
    const day = smoothstep(-0.22, 0.1, sun.y);

    const moonUp = smoothstep(-0.1, 0.22, this.moonDir.y) * this.uniforms.uMoonPhase.value;
    const moonMu = Math.max(dx * this.moonDir.x + dy * this.moonDir.y + dz * this.moonDir.z, 0);
    const nightBase = [0.008, 0.014, 0.032];
    const moonTint = [0.012, 0.017, 0.032];

    const haze = this.uniforms.uHaze.value * smoothstep(0.3, -0.02, dy);
    const hazeAdd = [0.1, 0.12, 0.15];

    for (let i = 0; i < 3; i++) {
      const transmit = Math.exp(-BETA_R[i] * 0.0118 * sunPath);
      let c = (BETA_R[i] * phaseR + BETA_M * phaseM * this.mieK) * airMass * SKY_SCALE * transmit * day;
      let night = nightBase[i] * (0.55 + 0.45 * airMass * 0.28);
      night += moonTint[i] * moonUp * (0.4 + 0.6 * Math.pow(moonMu, 3));
      c += night * (1 - day);
      c = lerp(c, c * 0.72 + hazeAdd[i] * (0.3 + day), haze);
      out[i] = c;
    }
    return out;
  }

  _computeColors(weather) {
    const sy = this.sunDir.y;
    const day = smoothstep(-0.22, 0.10, sy);
    this.dayFactor = day;
    const goldenness = 1 - smoothstep(0.0, 0.32, sy);

    // Zenith, straight up.
    const z = this._radiance(0, 1, 0, RGB_A);
    this.zenithColor.setRGB(z[0], z[1], z[2]);

    // Horizon: an average of four compass directions plus a look toward the
    // sun, so haze reddens in the right direction without banding.
    const h = RGB_B;
    h[0] = h[1] = h[2] = 0;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU;
      const r = this._radiance(Math.cos(a), 0.045, Math.sin(a), RGB_A);
      h[0] += r[0] * 0.1875;
      h[1] += r[1] * 0.1875;
      h[2] += r[2] * 0.1875;
    }
    const sd = this._tmp.set(this.sunDir.x, 0.045, this.sunDir.z).normalize();
    const rs = this._radiance(sd.x, 0.045, sd.z, RGB_A);
    h[0] += rs[0] * 0.25;
    h[1] += rs[1] * 0.25;
    h[2] += rs[2] * 0.25;
    this.horizonColor.setRGB(h[0], h[1], h[2]);

    // Direct sunlight: white overhead, orange at the horizon.
    this.sunColor.setRGB(
      1.0,
      lerp(0.40, 0.97, smoothstep(-0.02, 0.30, sy)),
      lerp(0.13, 0.92, smoothstep(0.0, 0.36, sy))
    );
    this.sunIntensity = smoothstep(-0.09, 0.14, sy);

    const moonUp = smoothstep(-0.08, 0.20, this.moonDir.y);
    this.moonIntensity = moonUp * this.uniforms.uMoonPhase.value * (1 - day);

    let cloudDim = 1;
    if (weather) {
      // The sky colours already go grey below, so this only takes the edge
      // off the direct sun - dimming twice is what makes overcast look like
      // midnight instead of like an overcast afternoon.
      cloudDim = lerp(1, 0.62, weather.overcast) * lerp(1, 0.74, weather.cloudDark);
      const g = lerp(0.016, 0.52, day) * lerp(1, 0.55, weather.cloudDark);
      GREY.setRGB(g * 0.94, g * 0.98, g * 1.06);
      this.zenithColor.lerp(GREY, weather.overcast * 0.88);
      GREY.setRGB(g * 1.30, g * 1.34, g * 1.40);
      this.horizonColor.lerp(GREY, weather.overcast * 0.85);
    }
    this.cloudDim = cloudDim;

    this.ambientColor.copy(this.horizonColor).lerp(this.zenithColor, 0.5);
    const amb = Math.max(this.ambientColor.r, this.ambientColor.g, this.ambientColor.b);
    if (amb > 1e-5) this.ambientColor.multiplyScalar(1 / amb); // hue only; brightness lives in intensity
    this.ambientLevel = amb;
    this.groundColor.setRGB(0.30, 0.26, 0.19).lerp(this.ambientColor, 0.30);

    // Share with every material in the world.
    atmo.uSunDir.value.copy(this.sunDir);
    // The glow the sun puts into haze, scaled by how bright the sky is.
    const hz = Math.max(this.horizonColor.r, this.horizonColor.g, this.horizonColor.b);
    atmo.uSunColor.value.copy(this.sunColor).multiplyScalar(hz * 1.7 + 0.015);
    atmo.uHorizonColor.value.copy(this.horizonColor);
    atmo.uZenithColor.value.copy(this.zenithColor);
    this.uniforms.uStars.value = 1 - (weather ? weather.overcast * 0.92 : 0);
  }

  _applyLights(weather) {
    const e = this.engine;
    const dim = this.cloudDim;
    e.sun.color.copy(this.sunColor);
    // 5.3, down from 6.4: with the eye pinned to apparent sky brightness,
    // the old value left sunlit grass reading brighter than the sky itself -
    // an inverted, lime-tinted contrast no photograph has.
    e.sun.intensity = this.sunIntensity * 5.3 * dim;
    e.sun.visible = e.sun.intensity > 0.01;

    e.moon.color.setRGB(0.52, 0.64, 0.96);
    e.moon.intensity = this.moonIntensity * 0.22 * dim;
    e.moon.visible = e.moon.intensity > 0.004;

    e.hemi.color.copy(this.ambientColor);
    e.hemi.groundColor.copy(this.groundColor);
    // Skylight scales with how bright the sky actually is, which keeps dawn,
    // storms and starlight all lit by the right amount without any tuning.
    e.hemi.intensity = (0.14 + this.ambientLevel * 8.6) * dim + this.moonIntensity * 0.16;
  }

  /**
   * Eye adaptation. Aims for a constant apparent sky brightness, but keeps a
   * ceiling at night so that darkness still reads as darkness.
   */
  _adapt(dt) {
    const lum = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    let mid = lum(this.horizonColor) * 0.42 + lum(this.zenithColor) * 0.58;
    // The colour model doesn't know the cloud slab exists, but the eye does:
    // a clouded day sky is BRIGHT, and metering as if it were clear blew the
    // clouds out to one structureless white sheet.
    mid *= 1 + this.uniforms.uCloudCover.value * 1.2 * this.dayFactor;
    // Aim brighter by day than by night: a clear daytime sky in a photograph
    // sits well above middle grey. Metering it to 0.44 made mornings dusk.
    const aim = lerp(0.46, 0.64, this.dayFactor);
    let target = clamp(aim / Math.max(0.015, mid), 1.05, 3.4);
    target = lerp(Math.min(target, 2.5), target, this.dayFactor);
    if (this.exposure === undefined) this.exposure = target;
    this.exposure = lerp(this.exposure, target, 1 - Math.exp(-dt * 0.55));
    this.engine.renderer.toneMappingExposure = this.exposure;
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

  /** Sky colour in a given direction, for water reflections and audio moods. */
  radianceAt(dir, out = new THREE.Color()) {
    const r = this._radiance(dir.x, dir.y, dir.z, RGB_A);
    return out.setRGB(r[0], r[1], r[2]);
  }

  setUnderwater(v, fogColor) {
    this.uniforms.uUnderwater.value = v ? 1 : 0;
    if (fogColor) this.uniforms.uWaterFog.value.copy(fogColor);
  }
}

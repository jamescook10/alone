// Sky, sun, moon, deep sky - and the day/night cycle that drives every light
// in the world.
//
// The gradient is still a palette keyed to the sun's elevation, and the same
// two gradient colours still feed the fog, the lights and the water, so the
// horizon can never show a seam: agreement by construction instead of by
// keeping two scattering models in step. What sits on top of that gradient is
// where nearly all of the work is.
//
// By day: a broad wash of colour along the sun's side of the horizon, a Mie
// aureole that swells as the sun sinks, the Belt of Venus and the Earth's own
// shadow rising opposite it at dusk, high cirrus lit from underneath, and a
// rainbow at forty-two degrees from the antisolar point whenever there is sun
// on falling rain.
//
// By night: the Milky Way in real galactic coordinates with its dust rift and
// its bulge in Sagittarius, a handful of real nebulae and satellite galaxies,
// meteors, and aurora curtains over the pole. The stars themselves are not in
// here - they are a real catalogue drawn as points, in `stars.js`, which also
// owns the celestial frame that this file rotates everything by.

import * as THREE from 'three';
import { atmo } from '../gfx/atmosphere.js';
import { detailTexture } from '../gfx/materials.js';
import { Stars, YEAR, MONTH, eclipticToEquatorial } from './stars.js';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHorizonCool;
uniform vec3 uSunTint;
uniform float uStars;
uniform float uAurora;
uniform float uMoonPhase;
uniform float uMoonBright;
uniform sampler2D tNoise;
uniform float uUnderwater;
uniform vec3 uWaterFog;
uniform mat3 uSkyRot;
uniform vec4 uMeteorA[4];
uniform vec4 uMeteorB[4];
uniform vec4 uNebPos[8];
uniform vec4 uNebCol[8];
uniform float uCirrus;
uniform vec3 uCirrusDrift;
uniform float uRainbow;
uniform float uFlash;
uniform float uTwilight;

// Galactic pole, centre and the third axis, in equatorial coordinates. The
// Milky Way is authored in the frame it actually lives in, so it crosses the
// sky at the angle it really does and swings round the pole with everything
// else.
const vec3 GP = vec3( -0.8678, -0.1970, 0.4560 );
const vec3 GC = vec3( -0.0549, -0.8734, -0.4839 );
const vec3 GY = vec3( 0.4936, -0.4450, 0.7471 );

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

float fbmTex( vec2 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    v += a * ( texture2D( tNoise, p ).r - 0.5 );
    p = p * 2.07 + vec2( 3.1, 1.7 );
    a *= 0.52;
  }
  return v;
}

// Violet at 0, red at 1. Not a spectrum so much as what a bow looks like.
vec3 bowSpectrum( float t ) {
  t = clamp( t, 0.0, 1.0 );
  return vec3(
    smoothstep( 0.45, 0.92, t ) + 0.34 * smoothstep( 0.22, 0.0, t ),
    exp( -pow( ( t - 0.55 ) * 3.2, 2.0 ) ),
    smoothstep( 0.58, 0.10, t )
  );
}

void main() {
  vec3 dir = normalize( vDir );

  if ( uUnderwater > 0.5 ) {
    gl_FragColor = vec4( uWaterFog * ( 0.5 + 0.5 * smoothstep( -0.2, 0.8, dir.y ) ), 1.0 );
    return;
  }

  float day = smoothstep( -0.22, 0.10, uSunDir.y );
  float night = 1.0 - day;

  /* --- the shape of a sunset ------------------------------------------- */
  vec3 sunAz = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
  vec3 dirAz = normalize( vec3( dir.x, 0.0, dir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
  float toward = dot( dirAz, sunAz );
  float towardK = clamp( toward * 0.5 + 0.5, 0.0, 1.0 );
  float away = 1.0 - towardK;
  float lowSun = 1.0 - smoothstep( 0.02, 0.40, uSunDir.y );
  float hband = exp( -max( dir.y, 0.0 ) * 5.2 );

  // The gradient. The 0.6 exponent keeps a broad bright band at the horizon,
  // which is most of what makes a clear sky read as open air. The horizon
  // colour itself swings with the bearing: at dusk the sky under the sun is
  // on fire and the sky behind you is still blue, and painting the warm stop
  // all the way round is what turned every sunset into a flat red wash.
  vec3 hor = mix( uHorizonCool, uHorizon, towardK );
  // The warm band pulls in toward the horizon as the sun drops. A sunset is
  // the last ten degrees of sky on fire under a sky that is still blue; with
  // the daytime exponent the fire reached the zenith and the whole dome went
  // one flat red.
  vec3 col = mix( hor, uZenith, pow( clamp( dir.y, 0.0, 1.0 ), mix( 0.60, 0.36, lowSun ) ) );

  // A wash of colour along the sun's side of the horizon. The old sky only
  // tinted a tight cone around the disc, which is why sunsets read as a
  // bright spot rather than as a sunset.
  col = mix( col, uSunTint,
    towardK * towardK * hband * lowSun * 0.45
    * smoothstep( -0.28, 0.02, uSunDir.y ) );

  // The Belt of Venus: backscattered sunset light in a pink band ten degrees
  // up on the opposite horizon, with the Earth's own shadow as a blue-grey
  // wedge underneath it. It is the quietest twenty minutes of the day.
  if ( uTwilight > 0.01 ) {
    float belt = exp( -pow( ( dir.y - 0.105 ) / 0.075, 2.0 ) ) * away * uTwilight;
    col += vec3( 0.52, 0.20, 0.26 ) * belt * 0.30;
    col *= 1.0 - 0.30 * uTwilight * away * smoothstep( 0.085, -0.02, dir.y );
  }

  /* --- deep sky --------------------------------------------------------- */
  float nightF = night * uStars;
  if ( nightF > 0.003 && dir.y > -0.06 ) {
    // World -> equatorial is the transpose, and v * M is exactly that.
    vec3 sdir = dir * uSkyRot;
    float up = smoothstep( -0.04, 0.16, dir.y );

    float sb = dot( sdir, GP );
    float glon = atan( dot( sdir, GY ), dot( sdir, GC ) );
    float bulge = exp( -glon * glon * 0.85 );
    float thick = 0.085 + 0.17 * bulge;
    float band = exp( -( sb * sb ) / ( thick * thick ) );

    // Two samples across each other, because one stretched fbm of a tiling
    // texture combs the whole band into parallel scratches. Star clouds are
    // blotchy, not striped.
    vec2 gp2 = vec2( glon * 1.5, sb * 3.2 );
    float clumps = fbmTex( gp2 * 0.55 ) * 0.75 + fbmTex( vec2( sb * 2.4 + 5.0, glon * 0.8 + 9.0 ) ) * 0.6;
    float lum = band * ( 0.30 + 1.45 * bulge ) * max( 0.55 + 1.7 * clumps, 0.0 );

    // The Great Rift: the dust lane that splits the band from Cygnus down to
    // Sagittarius. Without it the Milky Way is a smear; with it, it has a
    // near side and a far side.
    float rift = exp( -pow( ( sb + 0.010 - 0.020 * sin( glon * 1.7 ) ) / 0.030, 2.0 ) )
      * ( 0.35 + 0.65 * bulge );
    lum *= 1.0 - 0.72 * rift * ( 0.6 + 1.2 * fbmTex( gp2 * 1.9 + 7.0 ) );

    // Blue-white in the arms where the young stars are, warm gold in the
    // bulge where the old ones are and the dust reddens what gets through.
    vec3 mwCol = mix( vec3( 0.24, 0.60, 1.32 ), vec3( 1.15, 0.80, 0.52 ), bulge * 0.62 );
    col += mwCol * lum * 0.115 * nightF * up;
    // Hydrogen glowing along the plane - the pink in every long exposure of
    // the summer Milky Way. Its own noise, not the star clouds', and hard
    // thresholded: correlated with the star clouds and spread thin it just
    // filled the red channel everywhere and turned the whole band grey.
    float hii = fbmTex( vec2( glon * 2.1 + 17.0, sb * 4.5 + 23.0 ) );
    col += vec3( 1.00, 0.18, 0.42 ) * band * max( hii - 0.15, 0.0 ) * 0.75 * nightF * up;

    // Named smudges: two satellite galaxies, Andromeda, and a handful of
    // nebulae bright enough to see without a telescope.
    for ( int i = 0; i < 8; i++ ) {
      vec4 P = uNebPos[ i ];
      float d = distance( sdir, P.xyz );
      float g = exp( -( d * d ) / ( P.w * P.w ) );
      col += uNebCol[ i ].rgb * g * uNebCol[ i ].a * nightF * up;
    }
  }

  /* --- meteors ---------------------------------------------------------- */
  // In world space, not on the celestial sphere: they burn up eighty
  // kilometres overhead, which is the near side of the sky.
  if ( night > 0.05 ) {
    for ( int i = 0; i < 4; i++ ) {
      float g = uMeteorA[ i ].w;
      if ( g <= 0.0 ) continue;
      vec3 head = uMeteorA[ i ].xyz;
      vec3 tv = uMeteorB[ i ].xyz;
      float len = uMeteorB[ i ].w;
      float along = clamp( dot( dir - head, -tv ), 0.0, len );
      float d = distance( dir, head - tv * along );
      float taper = 1.0 - along / len;
      float w = 0.0016 + 0.0055 * ( 1.0 - taper );
      float trail = exp( -( d * d ) / ( w * w ) ) * taper * taper;
      float core = exp( -pow( distance( dir, head ) / 0.007, 2.0 ) );
      col += vec3( 0.86, 0.93, 1.0 ) * ( trail * 0.9 + core * 1.7 ) * g * night;
    }
  }

  /* --- aurora ----------------------------------------------------------- */
  if ( uAurora > 0.01 && dir.y > -0.05 && night > 0.25 ) {
    float t = uTime * 0.05;
    float az = atan( dir.z, dir.x );
    // An arc over the pole. Only a big storm pushes it overhead and round
    // behind you, which is the difference between a green smudge on the
    // northern horizon and the night people talk about for years.
    float sector = smoothstep( -0.10, 0.90, -dirAz.z );
    sector = mix( sector, 1.0, smoothstep( 0.55, 1.0, uAurora ) * 0.55 );
    float glow = 0.0;
    float edgeGlow = 0.0;
    for ( int i = 0; i < 3; i++ ) {
      float fi = float( i );
      // The lower edge of a curtain wanders as you follow it along the arc,
      // and it is sharp: that hard bottom edge with the soft fade above it is
      // the shape of an aurora.
      float base = 0.055 + fi * 0.06
        + 0.070 * sin( az * ( 1.3 + fi * 0.7 ) + t * ( 0.7 + fi * 0.3 ) + fi * 2.4 )
        + 0.030 * sin( az * ( 3.1 + fi ) - t * 1.1 );
      float top = base + 0.30 + 0.14 * sin( az * 2.2 + t * 0.8 + fi * 1.9 );
      float inBand = smoothstep( base - 0.006, base + 0.016, dir.y )
        * smoothstep( top, top - 0.26, dir.y );
      // Vertical rays standing up the field lines. Two frequencies, warped by
      // noise so the spacing wanders, under a slow envelope - a real curtain
      // is bright in patches with long quiet stretches between, and an even
      // comb of stripes reads as corduroy.
      float n1 = fbmTex( vec2( az * 2.6 + t, fi * 5.0 ) );
      float warp = fbmTex( vec2( az * 0.9 + 31.0, fi * 7.0 ) ) * 0.05;
      float r1 = 0.5 + 0.5 * sin( ( az + warp ) * ( 96.0 + fi * 29.0 ) + n1 * 8.0 );
      float r2 = 0.5 + 0.5 * sin( az * ( 27.0 + fi * 11.0 ) - t * 0.6 + n1 * 4.0 );
      float env = clamp( fbmTex( vec2( az * 1.1 + t * 0.4, fi * 3.0 + 21.0 ) ) * 3.4 + 0.55, 0.0, 1.0 );
      float rays = ( 0.14 + 0.86 * r1 * r1 * r2 ) * ( 0.22 + 0.78 * env );
      float pulse = 0.35 + 0.65 * ( 0.5 + 0.5 * sin( az * 4.0 - t * 2.2 + fi * 1.7 ) );
      glow += inBand * rays * pulse * ( 1.0 - fi * 0.22 );
      // The bottom edge of a curtain is far brighter than the body of it, and
      // that bright green hem is the thing you actually recognise.
      edgeGlow += exp( -pow( ( dir.y - base - 0.018 ) / 0.038, 2.0 ) )
        * pulse * env * ( 1.0 - fi * 0.3 );
    }
    // Oxygen green low down, nitrogen violet at the tops, and a red fringe
    // above that on the strongest nights.
    vec3 ac = mix( vec3( 0.14, 1.00, 0.48 ), vec3( 0.52, 0.26, 0.98 ),
      smoothstep( 0.26, 0.72, dir.y ) );
    ac = mix( ac, vec3( 0.95, 0.22, 0.42 ), smoothstep( 0.55, 0.90, dir.y ) * 0.6 );
    col += ac * glow * sector * uAurora * night * 0.95;
    col += vec3( 0.20, 1.00, 0.55 ) * edgeGlow * sector * uAurora * night * 0.30;
  }

  /* --- sun -------------------------------------------------------------- */
  float sunD = distance( dir, uSunDir );
  float disc = smoothstep( 0.0125, 0.0088, sunD );
  // A tight glare plus a broad aureole that swells as the light takes a
  // longer path through the air.
  float aureole = exp( -sunD * 21.0 ) * 0.50 + exp( -sunD * 5.0 ) * ( 0.09 + 0.36 * lowSun );
  col += uSunTint * ( disc * 4.2 + aureole ) * smoothstep( -0.08, 0.02, uSunDir.y );

  /* --- moon ------------------------------------------------------------- */
  // A lit sphere, not a shaded disc: the terminator falls where the sun
  // actually is, so every phase from a wire-thin crescent to full comes out
  // of the geometry, and the horns point away from the sun without being told.
  float mR = 0.026;
  if ( dot( dir, uMoonDir ) > 0.9985 ) {
    vec3 mx = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-5 ) );
    vec3 my = cross( mx, uMoonDir );
    float ax = dot( dir, mx ) / mR;
    float ay = dot( dir, my ) / mR;
    float r2 = ax * ax + ay * ay;
    if ( r2 < 1.02 ) {
      // The normal at the middle of the disc points back at the observer,
      // which is -uMoonDir. Getting that sign wrong lights the moon fully at
      // new moon and blacks it out when it is full.
      vec3 n = normalize( mx * ax + my * ay - uMoonDir * sqrt( max( 1.0 - r2, 0.0 ) ) );
      float lam = max( dot( n, uSunDir ), 0.0 );
      float maria = 0.78 + 0.44 * fbmTex( vec2( ax, ay ) * 1.7 + 13.0 );
      // Earthshine: a full Earth lighting the dark limb of a young moon -
      // the old moon in the new moon's arms.
      float earthshine = 0.045 * ( 1.0 - uMoonPhase );
      vec3 mc = vec3( 0.98, 0.96, 0.90 ) * maria * ( lam * 1.30 + earthshine );
      // Reddened when it is low, the same as everything else out there.
      mc = mix( mc * vec3( 1.0, 0.72, 0.48 ), mc, smoothstep( -0.02, 0.20, uMoonDir.y ) );
      col += mc * smoothstep( 1.02, 0.94, r2 ) * uMoonBright;
    }
  }
  col += vec3( 0.52, 0.58, 0.78 ) * exp( -distance( dir, uMoonDir ) * 10.0 )
    * 0.075 * uMoonPhase * uMoonBright;

  /* --- cirrus ----------------------------------------------------------- */
  if ( uCirrus > 0.01 && dir.y > 0.014 ) {
    // A sheet at eight kilometres, projected flat and combed out along the
    // wind by the jet stream. Two samples at different scales and across the
    // grain, because one stretched fbm of a tiling texture gives a corduroy
    // sky - regular ribs from horizon to horizon.
    vec2 pp = dir.xz / dir.y * 0.055 + uCirrusDrift.xy;
    float ca = uCirrusDrift.z;
    vec2 rp = vec2( pp.x * cos( ca ) - pp.y * sin( ca ), pp.x * sin( ca ) + pp.y * cos( ca ) );
    float f = fbmTex( vec2( rp.x * 0.22, rp.y * 0.95 ) ) * 0.8
      + fbmTex( vec2( rp.y * 0.40 + 11.0, rp.x * 0.26 + 3.0 ) ) * 0.6;
    float streak = clamp( ( f - 0.06 ) * 2.6, 0.0, 1.0 )
      * smoothstep( 0.014, 0.11, dir.y ) * ( 1.0 - smoothstep( 0.6, 1.0, dir.y ) * 0.4 );
    // Lit from below near sunset, which is why a cirrus sky stays salmon pink
    // for twenty minutes after the sun has gone. After dark it stops being
    // lit at all and becomes what it really is: a veil over the stars.
    float lit = smoothstep( -0.16, 0.05, uSunDir.y );
    vec3 cc = mix( vec3( 0.94, 0.95, 0.99 ), uSunTint * 1.7,
      lowSun * 0.9 * clamp( toward * 0.45 + 0.55, 0.0, 1.0 ) );
    cc = mix( uZenith * 1.6 + vec3( 0.0006 ), cc, lit );
    col = mix( col, cc, streak * uCirrus * 0.72 );
  }

  /* --- rainbow ---------------------------------------------------------- */
  if ( uRainbow > 0.01 && dir.y > -0.07 ) {
    float ang = degrees( acos( clamp( dot( dir, -uSunDir ), -1.0, 1.0 ) ) );
    float k = ( ang - 40.2 ) / 2.4;
    float prim = exp( -pow( ( k - 0.5 ) * 2.7, 2.0 ) );
    float k2 = ( ang - 50.4 ) / 3.4;
    float sec = exp( -pow( ( k2 - 0.5 ) * 2.5, 2.0 ) );
    // Alexander's dark band: the sky between the two bows really is darker.
    float dark = smoothstep( 42.8, 44.5, ang ) * smoothstep( 50.2, 48.6, ang );
    float fade = smoothstep( -0.07, 0.05, dir.y );
    col *= 1.0 - dark * 0.11 * uRainbow;
    col += ( bowSpectrum( 1.0 - k ) * prim + bowSpectrum( k2 ) * sec * 0.26 )
      * uRainbow * fade * 1.05;
  }

  /* --- lightning -------------------------------------------------------- */
  col += vec3( 0.70, 0.79, 1.00 ) * uFlash * ( 0.25 + 0.75 * hband );

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
 *
 * The twilight half of this table is much finer grained than the daylight
 * half, because that is where all the colour is: from ten degrees below the
 * horizon to ten above, the sky runs through indigo, violet, rose, orange and
 * gold in about fifteen minutes, and two stops across that range gave a
 * straight fade from navy to peach.
 */
const STOPS = [
  // Night is not black. A moonless sky still runs a couple of stops above the
  // unlit ground under it, and the old stops sat so far below that the ground
  // read as brighter than the air - which is the one thing a night sky never
  // is. Blue-green rather than navy, which is both what a dark-adapted eye
  // reports and what every photograph of one looks like.
  { y: -0.55, zen: [0.095, 0.130, 0.250], hor: [0.160, 0.190, 0.325], sun: [1.0, 0.55, 0.30], sunI: 0.0 },
  { y: -0.30, zen: [0.105, 0.140, 0.262], hor: [0.172, 0.200, 0.335], sun: [1.0, 0.55, 0.30], sunI: 0.0 },
  { y: -0.19, zen: [0.125, 0.155, 0.285], hor: [0.245, 0.200, 0.350], sun: [0.95, 0.45, 0.28], sunI: 0.0 },
  { y: -0.11, zen: [0.085, 0.088, 0.222], hor: [0.310, 0.180, 0.290], sun: [1.0, 0.42, 0.24], sunI: 0.0 },
  { y: -0.045, zen: [0.185, 0.215, 0.450], hor: [0.700, 0.350, 0.330], sun: [1.0, 0.44, 0.23], sunI: 0.04 },
  { y: 0.015, zen: [0.300, 0.360, 0.640], hor: [0.985, 0.580, 0.400], sun: [1.0, 0.56, 0.31], sunI: 0.30 },
  { y: 0.07, zen: [0.360, 0.480, 0.760], hor: [0.995, 0.735, 0.545], sun: [1.0, 0.72, 0.46], sunI: 0.62 },
  { y: 0.16, zen: [0.400, 0.575, 0.840], hor: [0.980, 0.820, 0.670], sun: [1.0, 0.84, 0.60], sunI: 0.88 },
  { y: 0.42, zen: [0.445, 0.665, 0.930], hor: [0.840, 0.910, 0.965], sun: [1.0, 0.97, 0.90], sunI: 1.0 },
];
for (const s of STOPS) {
  s.zenC = new THREE.Color().setRGB(...s.zen, THREE.SRGBColorSpace);
  s.horC = new THREE.Color().setRGB(...s.hor, THREE.SRGBColorSpace);
  s.sunC = new THREE.Color().setRGB(...s.sun, THREE.SRGBColorSpace);
}

// Things out there worth seeing without a telescope: direction in equatorial
// coordinates, angular size, colour and strength. The two Magellanic Clouds
// only rise for a player whose country is warm enough to have pushed their
// latitude far enough south, which is exactly right.
const DEEP_SKY = [
  { d: [0.7387, 0.1394, 0.6596], s: 0.030, c: [0.62, 0.64, 0.76], a: 0.060 }, // M31, Andromeda
  { d: [0.0548, 0.3418, -0.9382], s: 0.055, c: [0.64, 0.70, 0.82], a: 0.052 }, // Large Magellanic Cloud
  { d: [0.2879, 0.0673, -0.9553], s: 0.032, c: [0.62, 0.68, 0.82], a: 0.040 }, // Small Magellanic Cloud
  { d: [0.1072, 0.9898, -0.0940], s: 0.016, c: [1.00, 0.44, 0.54], a: 0.085 }, // M42, the Orion Nebula
  { d: [0.5017, -0.5070, 0.7009], s: 0.028, c: [0.96, 0.32, 0.44], a: 0.048 }, // North America Nebula
  { d: [-0.3451, -0.8265, -0.4446], s: 0.045, c: [0.96, 0.48, 0.56], a: 0.048 }, // Rho Ophiuchi
  { d: [-0.4761, 0.1616, -0.8646], s: 0.035, c: [1.00, 0.40, 0.50], a: 0.058 }, // Eta Carinae
  { d: [0.4991, 0.7643, 0.4084], s: 0.014, c: [0.56, 0.72, 1.00], a: 0.050 }, // the Pleiades' dust
];

const GREY = new THREE.Color();
const COOL = new THREE.Color();

export class Sky {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.dayLength = opts.dayLength || 1500; // seconds of real time per day
    this.time = opts.startTime !== undefined ? opts.startTime : 0.30; // 0..1, 0.25 = sunrise
    this.day = 0;

    this.stars = new Stars(engine);

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color(0.2, 0.4, 0.8) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uHorizonCool: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uSunTint: { value: new THREE.Color(1, 0.9, 0.8) },
      uStars: { value: 1 },
      uAurora: { value: 0 },
      uMoonPhase: { value: 0.7 },
      uMoonBright: { value: 2.2 },
      tNoise: { value: detailTexture() },
      uUnderwater: { value: 0 },
      uWaterFog: { value: new THREE.Color(0.06, 0.2, 0.26) },
      uSkyRot: { value: this.stars.skyRot },
      uMeteorA: { value: this.stars.meteorA },
      uMeteorB: { value: this.stars.meteorB },
      uNebPos: { value: DEEP_SKY.map((n) => new THREE.Vector4(n.d[0], n.d[1], n.d[2], n.s)) },
      uNebCol: { value: DEEP_SKY.map((n) => new THREE.Vector4(n.c[0], n.c[1], n.c[2], n.a)) },
      uCirrus: { value: 0 },
      uCirrusDrift: { value: new THREE.Vector3(0, 0, 0) },
      uRainbow: { value: 0 },
      uFlash: { value: 0 },
      uTwilight: { value: 0 },
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
    this.sunEq = new THREE.Vector3();
    this.moonEq = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.horizonCool = new THREE.Color();
    this.zenithColor = new THREE.Color();
    this.ambientColor = new THREE.Color();
    this.groundColor = new THREE.Color();
    this.sunIntensity = 0;
    this.dayFactor = 1;
    this.ambientLevel = 0.3;
    this.cloudDim = 1;
    this.moonIntensity = 0;
    this.moonPhase = 0.5;
    this.exposure = 1;
    this._cirrusDrift = new THREE.Vector2();
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

  /** Name of the moon's phase, for the journal and the HUD. */
  get moonName() {
    const p = this.moonPhase;
    const waxing = this.moonWaxing;
    if (p < 0.04) return 'new moon';
    if (p > 0.96) return 'full moon';
    if (p < 0.45) return waxing ? 'waxing crescent' : 'waning crescent';
    if (p < 0.56) return waxing ? 'first quarter' : 'last quarter';
    return waxing ? 'waxing gibbous' : 'waning gibbous';
  }

  update(dt, camera, weather) {
    this.time += dt / this.dayLength;
    while (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    const t = this.time;
    const days = this.day + t;
    this.uniforms.uTime.value += dt;

    // The sun's place on the ecliptic. Everything else - the sidereal day, the
    // seasons, the moon's phase - is measured from here.
    const lonSun = TAU * (days / YEAR + 0.21);
    eclipticToEquatorial(lonSun, 0, this.sunEq);

    this.stars.setClimate(atmo.uClimateTemp.value, dt);
    this.stars.frame(t, this.sunEq);
    this.sunDir.copy(this.sunEq).applyMatrix3(this.stars.skyRot).normalize();

    // The moon runs a full cycle of phases every MONTH days, and its orbit is
    // tipped five degrees to the ecliptic, so it does not sit on the same
    // track night after night.
    const elong = TAU * days / MONTH;
    const latMoon = 5.14 * DEG * Math.sin(TAU * days / (MONTH * 0.9214) + 1.3);
    eclipticToEquatorial(lonSun + elong, latMoon, this.moonEq);
    this.moonDir.copy(this.moonEq).applyMatrix3(this.stars.skyRot).normalize();

    this.moonPhase = 0.5 - 0.5 * this.sunDir.dot(this.moonDir);
    this.moonWaxing = Math.sin(elong) > 0;
    this.uniforms.uMoonPhase.value = this.moonPhase;
    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uMoonDir.value.copy(this.moonDir);

    if (weather) {
      this.uniforms.uAurora.value = weather.aurora;
      this.uniforms.uStars.value = 1 - weather.overcast * 0.92;
      this.uniforms.uRainbow.value = weather.rainbow;
      this.uniforms.uFlash.value = weather.lightning * 0.55;
      this.uniforms.uCirrus.value = weather.cirrus;
      this._cirrusDrift.addScaledVector(weather.windDir, dt * 0.0028 * (0.4 + weather.wind));
      this.uniforms.uCirrusDrift.value.set(
        this._cirrusDrift.x, this._cirrusDrift.y, Math.atan2(weather.windDir.y, weather.windDir.x));
    }

    this._computeColors(weather);
    this._applyLights(weather, dt);

    // Twilight: strongest with the sun just under the horizon, gone by the
    // time it is properly up or properly down.
    const sy = this.sunDir.y;
    this.uniforms.uTwilight.value = smoothstep(-0.19, -0.09, sy) * smoothstep(0.07, 0.0, sy);
    // The daytime moon is a pale ghost, not a lamp - it is only about as
    // bright as the sky it sits in.
    this.uniforms.uMoonBright.value = 2.3 * (1 - this.dayFactor * 0.88);

    const nightF = (1 - this.dayFactor) * (weather ? 1 - weather.overcast * 0.92 : 1);
    this.stars.update(dt, t, this.day, nightF);

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

    // The horizon behind you at dusk: pull it most of the way to the zenith,
    // lifted a little because the air at the horizon is always brighter than
    // the air overhead however you are facing.
    const lowSun = 1 - smoothstep(0.02, 0.40, sy);
    this.horizonCool.copy(this.horizonColor).lerp(
      COOL.copy(this.zenithColor).multiplyScalar(1.35).addScalar(0.006), 0.78 * lowSun);

    const moonUp = smoothstep(-0.08, 0.20, this.moonDir.y);
    this.moonIntensity = moonUp * this.moonPhase * (1 - this.dayFactor);

    // Skylight: hue between the two gradient stops, level from their size.
    // Weighted toward the zenith when the sun is low, because the warm half
    // of a sunset is already carried by the sun's own light - taking the fill
    // half from the fire on the horizon too made the whole world one colour.
    this.ambientColor.copy(this.horizonColor).lerp(this.zenithColor, 0.5 + 0.28 * lowSun);
    const amb = Math.max(this.ambientColor.r, this.ambientColor.g, this.ambientColor.b);
    if (amb > 1e-5) this.ambientColor.multiplyScalar(1 / amb); // hue only; brightness lives in intensity
    this.ambientLevel = amb;
    this.groundColor.setRGB(0.42, 0.38, 0.30).lerp(this.ambientColor, 0.35);

    // Share with the sky dome and with every material in the world.
    this.uniforms.uZenith.value.copy(this.zenithColor);
    this.uniforms.uHorizon.value.copy(this.horizonColor);
    this.uniforms.uHorizonCool.value.copy(this.horizonCool);
    this.uniforms.uSunTint.value.copy(this.sunColor).multiplyScalar(0.35 + 0.85 * this.sunIntensity * cloudDim);
    atmo.uSunDir.value.copy(this.sunDir);
    atmo.uSunColor.value.copy(this.sunColor).multiplyScalar((0.15 + 0.55 * this.sunIntensity) * cloudDim);
    atmo.uHorizonColor.value.copy(this.horizonColor);
    atmo.uHorizonCool.value.copy(this.horizonCool);
    atmo.uZenithColor.value.copy(this.zenithColor);
  }

  _applyLights(weather, dt = 0) {
    const e = this.engine;
    const dim = this.cloudDim;

    // Dark adaptation. The eye opens up by orders of magnitude after dark and
    // the tone curve has to do something like it, or the whole deep sky lands
    // in the bottom two values of an 8-bit frame: the filmic curve alone takes
    // a night zenith of 0.006 down to 0.0004, which is black. A full moon
    // closes it back down, which is exactly what a full moon does to a sky
    // full of stars.
    const want = lerp(1.55, 1.0, this.dayFactor) * lerp(1, 0.76, this.moonIntensity);
    this.exposure += (want - this.exposure) * (1 - Math.exp(-dt * 1.2));
    e.renderer.toneMappingExposure = this.exposure;
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
    const aurora = weather ? weather.aurora : 0;
    // The night stops are painted well above the radiance a moonless sky
    // really has, because a physical one lands in the bottom two values of an
    // 8-bit frame and takes the Milky Way with it. That lift belongs to the
    // dome and the fog, which have to agree with each other, and not to the
    // light the sky casts on the ground - so skylight is scaled back by the
    // same amount after dark, and an unlit hillside stays as dark as it was.
    e.hemi.intensity = (0.05 + this.ambientLevel * lerp(0.60, 1.55, this.dayFactor))
      * lerp(1, 0.85, weather ? weather.overcast : 0)
      + this.moonIntensity * 0.22
      // A strong aurora is bright enough to read a map by, and the ground
      // going faintly green under one is half of why they are worth seeing.
      + aurora * (1 - this.dayFactor) * 0.10;
    if (aurora > 0.02) {
      e.hemi.color.lerp(GREY.setRGB(0.35, 1.0, 0.55), aurora * (1 - this.dayFactor) * 0.30);
    }
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
    this.stars.setUnderwater(v);
    if (fogColor) this.uniforms.uWaterFog.value.copy(fogColor);
  }
}

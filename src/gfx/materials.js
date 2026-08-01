// All world materials. Flat-shaded Lambert throughout: solid vertex colours,
// faceted normals from screen-space derivatives, no texture sets and no PBR.
// The only texture left is a generated noise map used as a noise source for
// the sky's stars and the water's foam.

import * as THREE from 'three';
import { atmo, injectAtmosphere, ATMO_PARS, WIND_PARS } from './atmosphere.js';
import { Noise } from '../core/noise.js';

/* ---------------------------------------------------------- textures */

let _detailTex = null;
export function detailTexture() {
  if (_detailTex) return _detailTex;
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const n1 = new Noise(11);
  const n2 = new Noise(29);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // tileable-ish fbm by sampling on a torus
      const a = (x / S) * Math.PI * 2;
      const b = (y / S) * Math.PI * 2;
      const tx = Math.cos(a) * 6,
        ty = Math.sin(a) * 6,
        tz = Math.cos(b) * 6,
        tw = Math.sin(b) * 6;
      const v = n1.fbm3(tx, ty, tz + tw * 0.5, 4) * 0.5 + 0.5;
      const w = n2.fbm3(tx * 2.4 + 10, tz * 2.4, ty * 2.4 - tw, 3) * 0.5 + 0.5;
      data[i] = v * 255;
      data[i + 1] = w * 255;
      data[i + 2] = (v * w) * 255;
      data[i + 3] = 255;
    }
  }
  _detailTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.needsUpdate = true;
  _detailTex.generateMipmaps = true;
  _detailTex.minFilter = THREE.LinearMipmapLinearFilter;
  _detailTex.magFilter = THREE.LinearFilter;
  return _detailTex;
}

/** Soft round alpha sprite, used for particles. */
export function blobTexture(softness = 0.55, seed = 3) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(softness, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------------------------------------------------- terrain */

export function makeTerrainMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    // Faceted normals from derivatives: every terrain triangle reads as one
    // flat plane, which is the whole look - and it makes the worker's smooth
    // normals irrelevant to lighting.
    flatShading: true,
  });
  injectAtmosphere(mat, {
    key: 'terrain',
    // The worker already baked climate snow into the vertex colours using the
    // true local temperature, so the shared shader term would double it.
    snow: false,
    vertexPars: /* glsl */ `
      attribute vec4 aux;
      varying vec4 vAux;
    `,
    vertexBody: `vAux = aux;`,
    fragmentPars: /* glsl */ `
      uniform float uWetness;
      uniform float uSnowAmount;
      varying vec4 vAux;
    `,
    colorFragment: /* glsl */ `
      {
        // Rain darkens the ground; puddled shorelines (vAux.x) stay darker.
        float wet = clamp( vAux.x + uWetness * ( 1.0 - vAux.y * 1.6 ), 0.0, 1.0 );
        diffuseColor.rgb *= mix( 1.0, 0.72, wet * 0.8 );
        // Fresh snowfall whitens flat ground.
        float snow = clamp( uSnowAmount * ( 1.0 - vAux.y * 1.3 ), 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.89, 0.94 ), snow * 0.9 );
      }
    `,
  });
  return mat;
}

/* ------------------------------------------------------------ water */

// Shared between the vertex shader and World.waveHeightAt - if these drift
// apart, the player stops bobbing on the swell they can see.
export const GERSTNER_WAVES = [
  // dirX, dirZ, wavelength (m), amplitude (m), steepness
  [0.80, 0.60, 46, 0.40, 0.34],
  [-0.55, 0.83, 27, 0.22, 0.40],
  [0.20, -0.98, 13, 0.10, 0.46],
  [0.95, -0.31, 6.5, 0.045, 0.50],
];

const GERSTNER_GLSL = GERSTNER_WAVES.map(([dx, dz, L, A, Q], i) => {
  const k = (Math.PI * 2) / L;
  const w = Math.sqrt(9.81 * k);
  const il = 1 / Math.hypot(dx, dz);
  return `
    {
      vec2 D = vec2( ${(dx * il).toFixed(4)}, ${(dz * il).toFixed(4)} );
      float kk = ${k.toFixed(5)};
      float A = ${A.toFixed(3)} * amp;
      float ph = kk * dot( D, p0 ) + ${w.toFixed(4)} * uTime;
      float ca = cos( ph ), sa = sin( ph );
      wp.xz -= D * ( ${Q.toFixed(2)} * A * ca );
      wp.y += A * sa;
      crest += sa * ${(A / 0.765).toFixed(3)};
    }`;
}).join('\n');

const WATER_VERT = /* glsl */ `
  attribute vec2 flow;
  attribute float depth;
  uniform float uTime;
  uniform float uWaveScale;
  uniform float uWindStrength;
  varying vec3 vWorldPos;
  varying vec2 vFlow;
  varying float vDepth;
  varying float vCrest;

  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vFlow = flow;
    vDepth = depth;
    // Waves flatten in the shallows and in rivers, where flow takes over -
    // and the sea state follows the wind: glass at dawn, whitecaps in a storm.
    float shore = clamp( depth / 2.5, 0.0, 1.0 );
    float amp = uWaveScale * shore * ( 1.0 - clamp( length( flow ) * 0.8, 0.0, 0.85 ) )
      * ( 0.45 + clamp( uWindStrength, 0.0, 1.5 ) * 0.75 );
    vec2 p0 = wp.xz;
    float crest = 0.0;
    ${'${GERSTNER}'}
    vCrest = crest;
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`.replace('${GERSTNER}', GERSTNER_GLSL);

const WATER_FRAG = /* glsl */ `
  precision highp float;
  ${ATMO_PARS}
  uniform sampler2D tDetail;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform float uWindStrength;
  varying vec2 vFlow;
  varying float vDepth;
  varying float vCrest;

  void main() {
    vec3 dv = cameraPosition - vWorldPos;
    float vdist = length( dv );
    vec3 V = dv / max( vdist, 1e-4 );
    vec2 p = vWorldPos.xz;
    // Foam flecks and facet glints are sub-pixel past a few hundred metres,
    // where they alias into white noise crawling over the whole sea - worst
    // from the aeroplane. Distance keeps the body colour and the fresnel and
    // lets the glitter live only where it can resolve.
    float farK = 1.0 - smoothstep( 350.0, 1100.0, vdist );

    // Faceted normal straight from the displaced surface: every triangle of
    // the swell is one flat mirror shard, which is what makes Gerstner waves
    // look hand-made instead of simulated.
    vec3 N = normalize( cross( dFdx( vWorldPos ), dFdy( vWorldPos ) ) );
    if ( dot( N, V ) < 0.0 ) N = -N;

    // Body colour by depth, with a fresnel tint toward the sky's horizon
    // stop standing in for reflection.
    float deepK = clamp( vDepth / 22.0, 0.0, 1.0 );
    deepK = deepK * ( 2.0 - deepK );
    vec3 body = mix( uShallow, uDeep, deepK );
    float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.0 );
    vec3 col = mix( body, uHorizonColor, 0.10 + fres * 0.60 );

    // Sun sparkle off the facets.
    vec3 H = normalize( uSunDir + V );
    float spec = pow( max( dot( N, H ), 0.0 ), 140.0 );
    col += uSunColor * spec * 1.6 * ( 0.12 + 0.88 * farK );

    // Foam: shoreline wash, river churn, and wind-torn whitecaps on crests.
    // Thresholds sit high so foam stays a ribbon at the water's edge and a
    // fleck on the crests - a low threshold painted every shallow in white.
    float speed = length( vFlow );
    vec2 adv = vFlow * uTime * 0.55;
    float shoreFoam = smoothstep( 0.7, 0.04, vDepth );
    float churn = smoothstep( 0.55, 1.5, speed );
    float fn = texture2D( tDetail, p * 0.045 - adv * 0.08 + vec2( uTime * 0.02, 0.0 ) ).r;
    float fn2 = texture2D( tDetail, p * 0.11 + adv * 0.03 ).g;
    float whitecap = smoothstep( 0.80, 1.10, vCrest ) * smoothstep( 0.6, 1.3, uWindStrength );
    float foam = shoreFoam * smoothstep( 0.58, 0.78, fn )
      + churn * smoothstep( 0.55, 0.85, fn2 ) * 0.85
      + whitecap * smoothstep( 0.55, 0.80, fn2 );
    // Hard-edged foam patches, not a soft wash: quantising the mask keeps it
    // in the same graphic language as the flat facets.
    foam = smoothstep( 0.34, 0.48, foam ) * farK;
    col = mix( col, vec3( 0.97, 0.99, 1.0 ), clamp( foam, 0.0, 0.9 ) );

    float alpha = mix( 0.55, 0.93, clamp( vDepth / 1.6, 0.0, 1.0 ) );
    alpha = clamp( alpha + fres * 0.25 + foam * 0.6, 0.0, 1.0 );

    if ( uUnderwater > 0.5 ) {
      // Seen from below the surface is a shifting mirror.
      col = mix( uWaterFog * 1.6, uHorizonColor, 0.35 );
      col += uSunColor * spec * 1.2;
      alpha = 0.55;
    }

    vec3 outCol = atmoApply( col, vWorldPos, cameraPosition );
    gl_FragColor = vec4( outCol, alpha );
  }
`;

export function makeWaterMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, atmo, {
      tDetail: { value: detailTexture() },
      uDeep: { value: new THREE.Color().setRGB(0.09, 0.29, 0.42, THREE.SRGBColorSpace) },
      uShallow: { value: new THREE.Color().setRGB(0.36, 0.71, 0.66, THREE.SRGBColorSpace) },
      uWaveScale: { value: 1.0 },
    }),
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return mat;
}

/* ---------------------------------------------------------- foliage */

/**
 * Vegetation: flat-shaded Lambert plus wind, with a hook for per-instance
 * tint and for the seasonal / burnt colour shifts the simulation applies.
 */
export function makeFoliageMaterial(opts = {}) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  injectAtmosphere(mat, {
    key: 'foliage' + (opts.key || ''),
    // Snow on leaves and branches comes from the shared climate term now, so
    // a spruce standing in a snowfield is white whether or not it is snowing.
    vertexPars: WIND_PARS,
    vertexBody: /* glsl */ `
      {
        vec3 origin = vec3( 0.0 );
        #ifdef USE_INSTANCING
          origin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
        #endif
        origin += vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
        transformed = windSway( transformed, origin, ${(opts.stiffness || 0.22).toFixed(3)}, ${(opts.sway || 1.0).toFixed(3)} );
      }
    `,
    // Leaves are thin: looking through a canopy toward the sun should glow.
    // uSunColor already carries the sky's brightness, so this fades itself out
    // at night and under overcast without any extra bookkeeping.
    emissiveFragment: opts.translucency
      ? /* glsl */ `
      {
        vec3 tV = normalize( cameraPosition - vWorldPos );
        float back = pow( clamp( dot( -tV, uSunDir ), 0.0, 1.0 ), 3.0 );
        totalEmissiveRadiance += diffuseColor.rgb * uSunColor * back * ${opts.translucency.toFixed(2)};
      }
    `
      : '',
  });
  return mat;
}

/** Flat-shaded solid material for rocks, buildings, vehicles and props. */
export function makeSolidMaterial(opts = {}) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: opts.vertexColors !== false,
    color: opts.color !== undefined ? opts.color : 0xffffff,
    flatShading: opts.flat !== false,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
    emissiveIntensity: opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1,
  });
  injectAtmosphere(mat, { key: 'solid' + (opts.key || '') });
  return mat;
}

/** Additive, unlit material for fire, sparks, glow and light shafts. */
export function makeGlowMaterial(map, color = 0xffffff) {
  return new THREE.MeshBasicMaterial({
    map: map || null,
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
}

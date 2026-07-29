// All world materials. Nothing is loaded from disk - every texture here is
// generated at boot from noise, so the game is a few hundred kilobytes and
// still has variety at every scale.

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

/** Soft round alpha sprite, used for leaf clusters and particles. */
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

/** A tuft of grass blades drawn as an alpha card. */
export function grassTexture() {
  const W = 64,
    H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  for (let i = 0; i < 9; i++) {
    const x0 = 8 + Math.random() * (W - 16);
    const lean = (Math.random() - 0.5) * 22;
    const w = 1.6 + Math.random() * 2.4;
    const h = H * (0.45 + Math.random() * 0.55);
    const shade = 120 + Math.random() * 95;
    g.strokeStyle = `rgba(${(shade * 0.78) | 0},${shade | 0},${(shade * 0.50) | 0},1)`;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, H);
    g.quadraticCurveTo(x0 + lean * 0.4, H - h * 0.55, x0 + lean, H - h);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------------------------------------------------- terrain */

export function makeTerrainMaterial() {
  const detail = detailTexture();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0.0,
    dithering: true,
  });
  injectAtmosphere(mat, {
    key: 'terrain',
    uniforms: { tDetail: { value: detail } },
    vertexPars: /* glsl */ `
      attribute vec2 aux;
      varying vec2 vAux;
    `,
    vertexBody: `vAux = aux;`,
    fragmentPars: /* glsl */ `
      uniform sampler2D tDetail;
      uniform float uTime;
      uniform float uWetness;
      uniform float uWaterY;
      uniform float uCaustics;
      varying vec2 vAux;
      float terrainWetness() {
        return clamp( vAux.x + uWetness * ( 1.0 - vAux.y * 1.6 ), 0.0, 1.0 );
      }
    `,
    roughnessFragment: `roughnessFactor = mix( roughnessFactor, 0.11, terrainWetness() * 0.8 );`,
    colorFragment: /* glsl */ `
      {
        vec2 p = vWorldPos.xz;
        vec3 d0 = texture2D( tDetail, p * 0.29 ).rgb;
        vec3 d1 = texture2D( tDetail, p * 0.048 ).rgb;
        vec3 d2 = texture2D( tDetail, p * 0.0067 ).rgb;
        // Three octaves of break-up, centred on zero so the average albedo is
        // exactly what the biome asked for.
        float grain = ( d0.r - 0.5 ) * 0.30 + ( d1.g - 0.5 ) * 0.44 + ( d2.r - 0.5 ) * 0.52;
        diffuseColor.rgb *= 1.0 + grain * 0.55;
        diffuseColor.g *= 1.0 + ( d1.r - 0.5 ) * 0.13;
        diffuseColor.b *= 1.0 - ( d2.g - 0.5 ) * 0.17;

        // Wet ground goes darker and glossier when it rains, and puddles
        // gather where the ground is already damp.
        float wet = terrainWetness();
        diffuseColor.rgb *= mix( 1.0, 0.62, wet * 0.8 );

        // Caustics on anything below the local water surface.
        float below = uWaterY - vWorldPos.y;
        if ( uCaustics > 0.5 && below > 0.0 ) {
          float t = uTime * 0.55;
          vec2 q = p * 0.42;
          float c1 = texture2D( tDetail, q * 0.25 + vec2( t * 0.06, t * 0.04 ) ).b;
          float c2 = texture2D( tDetail, q * 0.31 - vec2( t * 0.05, t * 0.07 ) ).r;
          float caus = pow( max( 0.0, 1.0 - abs( c1 - c2 ) * 4.5 ), 3.0 );
          float atten = exp( -below * 0.055 );
          diffuseColor.rgb += vec3( 0.55, 0.85, 0.8 ) * caus * atten * 0.5;
        }
      }
    `,
  });
  return mat;
}

/* ------------------------------------------------------------ water */

const WATER_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 flow;
  attribute float depth;
  uniform float uTime;
  uniform float uWaveScale;
  varying vec3 vWorldPos;
  varying vec2 vFlow;
  varying float vDepth;
  varying vec3 vNormalW;

  // Two crossing gerstner-ish swells plus chop. Cheap, but it reads as water.
  float waveH( vec2 p, float t, out vec2 grad ) {
    float h = 0.0;
    grad = vec2( 0.0 );
    vec2 d1 = normalize( vec2( 0.8, 0.6 ) );
    vec2 d2 = normalize( vec2( -0.55, 0.83 ) );
    vec2 d3 = normalize( vec2( 0.2, -0.98 ) );
    float k1 = 0.055, a1 = 0.62;
    float k2 = 0.101, a2 = 0.30;
    float k3 = 0.27, a3 = 0.085;
    float p1 = dot( p, d1 ) * k1 + t * 0.62;
    float p2 = dot( p, d2 ) * k2 + t * 0.90;
    float p3 = dot( p, d3 ) * k3 + t * 1.7;
    h += sin( p1 ) * a1 + sin( p2 ) * a2 + sin( p3 ) * a3;
    grad += d1 * ( cos( p1 ) * a1 * k1 );
    grad += d2 * ( cos( p2 ) * a2 * k2 );
    grad += d3 * ( cos( p3 ) * a3 * k3 );
    return h;
  }

  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vFlow = flow;
    vDepth = depth;
    // Waves flatten in the shallows and in rivers, where flow takes over.
    float shore = clamp( depth / 2.5, 0.0, 1.0 );
    float amp = uWaveScale * shore * ( 1.0 - clamp( length( flow ) * 0.8, 0.0, 0.85 ) );
    vec2 grad;
    float h = waveH( wp.xz, uTime, grad );
    wp.y += h * amp;
    vec3 n = normalize( vec3( -grad.x * amp * 3.0, 1.0, -grad.y * amp * 3.0 ) );
    vNormalW = n;
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const WATER_FRAG = /* glsl */ `
  precision highp float;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${ATMO_PARS}
  uniform sampler2D tDetail;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform float uOpacity;
  varying vec2 vFlow;
  varying float vDepth;
  varying vec3 vNormalW;

  void main() {
    #include <logdepthbuf_fragment>
    vec3 V = normalize( cameraPosition - vWorldPos );
    vec2 p = vWorldPos.xz;

    // Ripple normals. Rivers scroll their ripples along the flow direction.
    vec2 fl = vFlow;
    float speed = length( fl );
    vec2 adv = fl * uTime * 0.55;
    float s = 1.35;
    vec3 r1 = texture2D( tDetail, p * 0.21 * s - adv * 0.21 + vec2( uTime * 0.013, uTime * 0.017 ) ).rgb;
    vec3 r2 = texture2D( tDetail, p * 0.55 * s + adv * 0.11 - vec2( uTime * 0.021, -uTime * 0.011 ) ).rgb;
    vec2 ripple = ( vec2( r1.r, r1.g ) - 0.5 ) * 0.9 + ( vec2( r2.g, r2.b ) - 0.5 ) * 0.55;
    float rippleAmp = 0.55 + speed * 1.6;
    vec3 N = normalize( vNormalW + vec3( ripple.x, 0.0, ripple.y ) * rippleAmp );
    if ( dot( N, V ) < 0.0 ) N = -N;

    float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
    fres = 0.035 + fres * 0.95;

    vec3 R = reflect( -V, N );
    vec3 sky = mix( uHorizonColor, uZenithColor, clamp( R.y * 1.25, 0.0, 1.0 ) );

    float deepK = clamp( vDepth / 24.0, 0.0, 1.0 );
    deepK = deepK * ( 2.0 - deepK );
    vec3 body = mix( uShallow, uDeep, deepK );

    vec3 col = mix( body, sky, fres );

    // Sun glitter.
    vec3 H = normalize( uSunDir + V );
    float spec = pow( max( dot( N, H ), 0.0 ), 420.0 );
    float glint = pow( max( dot( N, H ), 0.0 ), 42.0 ) * 0.12;
    col += uSunColor * ( spec * 2.6 + glint );

    // Foam at the shoreline and where the river runs fast.
    float shoreFoam = smoothstep( 2.4, 0.04, vDepth );
    float churn = smoothstep( 0.55, 1.5, speed );
    float fn = texture2D( tDetail, p * 0.9 - adv * 0.8 + vec2( uTime * 0.04, 0.0 ) ).r;
    float fn2 = texture2D( tDetail, p * 2.1 + adv * 0.3 ).g;
    float foam = shoreFoam * smoothstep( 0.35, 0.75, fn ) + churn * smoothstep( 0.45, 0.85, fn2 ) * 0.85;
    col = mix( col, vec3( 0.93, 0.96, 0.97 ), clamp( foam, 0.0, 0.9 ) );

    float alpha = mix( 0.42, 0.94, clamp( vDepth / 1.6, 0.0, 1.0 ) );
    alpha = clamp( alpha + fres * 0.35 + foam * 0.6, 0.0, 1.0 );

    if ( uUnderwater > 0.5 ) {
      // Seen from below the surface is a shifting mirror.
      col = mix( uWaterFog * 1.6, sky, 0.35 );
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
      uDeep: { value: new THREE.Color(0.008, 0.045, 0.075) },
      uShallow: { value: new THREE.Color(0.055, 0.215, 0.235) },
      uOpacity: { value: 1 },
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
 * Vegetation: standard lighting plus wind, with a hook for per-instance tint
 * and for the seasonal / burnt colour shifts the simulation applies.
 */
export function makeFoliageMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: opts.alphaTest || 0,
    map: opts.map || null,
    transparent: false,
  });
  injectAtmosphere(mat, {
    key: 'foliage' + (opts.key || ''),
    vertexPars: WIND_PARS + `\nvarying float vWind;\n`,
    vertexBody: /* glsl */ `
      {
        vec3 origin = vec3( 0.0 );
        #ifdef USE_INSTANCING
          origin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
        #endif
        origin += vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
        transformed = windSway( transformed, origin, ${(opts.stiffness || 0.22).toFixed(3)}, ${(opts.sway || 1.0).toFixed(3)} );
        vWind = 1.0;
      }
    `,
    fragmentPars: `varying float vWind;\nuniform float uSnowAmount;`,
    colorFragment: /* glsl */ `
      {
        // Snow settles on upward-facing leaves and branches.
        float up = clamp( vNormal.y, 0.0, 1.0 );
        float snow = uSnowAmount * pow( up, 1.6 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.90, 0.93, 0.98 ), snow );
      }
    `,
  });
  return mat;
}

/** Flat-shaded solid material for rocks, buildings, vehicles and props. */
export function makeSolidMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: opts.vertexColors !== false,
    color: opts.color !== undefined ? opts.color : 0xffffff,
    roughness: opts.roughness !== undefined ? opts.roughness : 0.85,
    metalness: opts.metalness !== undefined ? opts.metalness : 0.0,
    flatShading: !!opts.flat,
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

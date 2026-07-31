// Shared aerial perspective.
//
// Every solid object in the world runs the same fog function, so the terrain,
// the trees, the animals and the buildings all sit in the same air. It is
// height-based and sun-aware: looking toward a low sun through distance gives
// you the warm haze that makes a landscape feel enormous. The fog colours are
// the same gradient stops the sky dome draws, so the horizon never splits.

import * as THREE from 'three';

export const atmo = {
  uSunDir: { value: new THREE.Vector3(0.3, 0.7, 0.4) },
  uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
  uHorizonColor: { value: new THREE.Color(0.68, 0.76, 0.86) },
  uZenithColor: { value: new THREE.Color(0.30, 0.48, 0.78) },
  uFogDensity: { value: 0.00017 },
  uFogFalloff: { value: 0.0017 },
  uFogBase: { value: 0.0 },
  uUnderwater: { value: 0.0 },
  uWaterFog: { value: new THREE.Color(0.06, 0.20, 0.26) },
  uWaterDensity: { value: 0.045 },
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(1, 0) },
  uWindStrength: { value: 0.4 },
  uWetness: { value: 0 },
  // Fresh snowfall lying on top of everything, 0..1, from the weather.
  uSnowAmount: { value: 0 },
  // Sea-level air temperature of the region you are standing in. Everything
  // that can hold snow works out its own permanent cover from this plus its
  // own altitude, using the identical rule the terrain worker bakes into the
  // ground colour - which is what stops a snowfield growing green trees.
  uClimateTemp: { value: 18 },
  uPlayerPos: { value: new THREE.Vector3() },
};

export const ATMO_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform float uUnderwater;
uniform vec3 uWaterFog;
uniform float uWaterDensity;
varying vec3 vWorldPos;

vec3 atmoApply( vec3 color, vec3 wp, vec3 cam ) {
  vec3 v = wp - cam;
  float dist = length( v );
  vec3 dir = v / max( dist, 1e-4 );

  if ( uUnderwater > 0.5 ) {
    float f = 1.0 - exp( -dist * uWaterDensity );
    float depthK = clamp( ( -wp.y ) * 0.010, 0.0, 1.0 );
    vec3 wf = mix( uWaterFog, uWaterFog * 0.12, depthK );
    return mix( color, wf, clamp( f, 0.0, 1.0 ) );
  }

  float b = uFogFalloff;
  float dy = dir.y;
  float amount;
  float baseline = exp( -( cam.y - uFogBase ) * b );
  if ( abs( dy ) < 1e-3 ) {
    amount = uFogDensity * dist * baseline;
  } else {
    amount = ( uFogDensity / b ) * baseline * ( 1.0 - exp( -dist * dy * b ) ) / dy;
  }
  amount = 1.0 - exp( -max( amount, 0.0 ) );

  float sunAmt = pow( max( dot( dir, uSunDir ), 0.0 ), 6.0 );
  vec3 fogCol = mix( uHorizonColor, uZenithColor, clamp( dir.y * 1.3, 0.0, 1.0 ) );
  fogCol = mix( fogCol, uSunColor, sunAmt * 0.5 );
  return mix( color, fogCol, clamp( amount, 0.0, 1.0 ) );
}
`;

const WORLDPOS_VERTEX = /* glsl */ `
#include <project_vertex>
#ifdef USE_INSTANCING
  vWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

// Snow lies on whatever faces the sky, so every surface needs to know which
// way up it is *in the world*. Flat shading throws vNormal away and instanced
// rocks are rotated arbitrarily, so this is computed here rather than reused.
const SNOW_VERTEX = /* glsl */ `
{
  vec3 wn = normal;
  #ifdef USE_INSTANCING
    wn = mat3( instanceMatrix ) * wn;
  #endif
  vUpY = normalize( mat3( modelMatrix ) * wn ).y;
}
`;

const SNOW_PARS_FRAG = /* glsl */ `
uniform float uSnowAmount;
uniform float uClimateTemp;
varying float vUpY;

/**
 * Permanent snow cover at a world point, 0..1. Deliberately the same
 * expression the terrain worker evaluates on the CPU - the same lapse rate,
 * the same two thresholds - so ground, trees, rocks and roofs all cross the
 * snow line at the same height on the same hillside.
 */
float snowCover( vec3 wp ) {
  float t = uClimateTemp - max( wp.y, 0.0 ) * 0.0068;
  float climate = smoothstep( 4.0, -3.0, t );
  float up = pow( clamp( vUpY, 0.0, 1.0 ), 1.4 );
  return clamp( max( climate, uSnowAmount ) * up, 0.0, 1.0 );
}
`;

// Snow's albedo really is about 0.8, and this is the linear reflectance the
// terrain's own SNOW_COL converts to. Matching it exactly is the point.
const SNOW_FRAGMENT = /* glsl */ `
  {
    float snow = snowCover( vWorldPos );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.85, 0.89, 0.93 ), snow );
  }
`;

/**
 * Patch a built-in three material so it participates in the shared
 * atmosphere. Optionally inject extra vertex/fragment code (used by foliage
 * for wind, and by terrain for its palette tweaks).
 */
export function injectAtmosphere(material, opts = {}) {
  // The terrain bakes its snow per vertex on the CPU (it knows the real local
  // temperature, not just the player's) and clouds have no up-facing side, so
  // both opt out.
  const wantSnow = opts.snow !== false;
  const prevCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    Object.assign(shader.uniforms, atmo, opts.uniforms || {});

    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>',
        `varying vec3 vWorldPos;\n${wantSnow ? 'varying float vUpY;\n' : ''}${opts.vertexPars || ''}`)
      .replace('#include <project_vertex>',
        (opts.vertexBody || '') + WORLDPOS_VERTEX + (wantSnow ? SNOW_VERTEX : ''));

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>',
        ATMO_PARS + (wantSnow ? SNOW_PARS_FRAG : '') + (opts.fragmentPars || ''))
      .replace(
        '#include <fog_fragment>',
        `${opts.fragmentBody || ''}\n  gl_FragColor.rgb = atmoApply( gl_FragColor.rgb, vWorldPos, cameraPosition );`
      );
    const colorFrag = (wantSnow ? SNOW_FRAGMENT : '') + (opts.colorFragment || '');
    if (colorFrag) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' + colorFrag
      );
    }
    if (opts.emissiveFragment) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' + opts.emissiveFragment
      );
    }
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => (opts.key || 'atmo') + (material.userData.cacheKey || '');
  return material;
}

/** Wind sway applied to grass, leaves and small props. */
export const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;

vec3 windSway( vec3 pos, vec3 worldOrigin, float stiffness, float amount ) {
  float t = uTime;
  float phase = worldOrigin.x * 0.09 + worldOrigin.z * 0.11;
  float gust = 0.6 + 0.4 * sin( t * 0.31 + phase * 0.2 );
  float s = sin( t * 1.9 + phase ) * 0.55 + sin( t * 3.7 + phase * 1.7 ) * 0.25 + sin( t * 0.9 + phase * 0.5 ) * 0.4;
  float k = pow( max( pos.y, 0.0 ) * stiffness, 1.4 ) * amount * uWindStrength * gust;
  pos.x += uWind.x * s * k;
  pos.z += uWind.y * s * k;
  return pos;
}
`;

// Volumetric clouds.
//
// A real cloud layer between uBase and uTop metres, raymarched per pixel
// against the scene's depth buffer - so you can watch a cumulus build from
// the ground, then press F and fly straight through it. Coverage and drift
// come from the same weather the old flat slab used; the slab turns itself
// off while this pass owns the sky.
//
// Cost control: the march runs at half resolution (1/4 the rays) with a
// jittered start, 26 steps, cheap two-tap pseudo-3D density and an analytic
// vertical light approximation instead of secondary light marches.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { atmo } from './atmosphere.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const MARCH_FRAG = /* glsl */ `
  #include <common>
  #include <packing>
  uniform sampler2D tDepth;
  uniform sampler2D tNoise;
  uniform mat4 uProjInv;
  uniform mat4 uCamMat;
  uniform vec3 uCamPos;
  uniform float uNear, uFar;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform float uCover;
  uniform float uDark;
  uniform vec2 uDriftM;
  uniform float uTime;
  uniform float uBase, uTop;
  varying vec2 vUv;

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  // Coverage field: two octaves of the shared noise texture, forced down the
  // mip chain (rays cover big distances per step).
  // All noise reads use EXPLICIT lods derived from march distance. Hardware
  // mip selection uses screen-space derivatives, and inside a divergent
  // raymarch loop those are garbage - neighbouring pixels picked different
  // mips and the whole sky dissolved into pixel dust.
  float coverage( vec2 xz, float lod ) {
    vec2 uv = ( xz + uDriftM ) * 0.00016;
    float c = textureLod( tNoise, uv, lod ).g * 0.62 + textureLod( tNoise, uv * 3.7, lod ).r * 0.38;
    // The source octaves are mid-biased; stretched, they can actually reach
    // the gap threshold - otherwise moderate cover renders one grey sheet.
    return ( c - 0.5 ) * 1.8 + 0.5;
  }

  float density( vec3 p, float t, out float covOut, out float lodOut ) {
    covOut = 0.0;
    lodOut = 4.0;
    float hN = ( p.y - uBase ) / ( uTop - uBase );
    if ( hN < 0.0 || hN > 1.0 ) return 0.0;
    float prof = smoothstep( 0.0, 0.16, hN ) * smoothstep( 1.0, 0.52, hN );
    float lod = clamp( log2( 1.0 + t * 0.02 ), 2.6, 6.5 );
    float cov = coverage( p.xz, lod );
    covOut = cov;
    lodOut = lod;
    float lo = 0.92 - uCover * 1.05;
    float d = smoothstep( lo, lo + 0.11, cov + 0.20 ) * prof;
    if ( d <= 0.002 ) return 0.0;
    // Erosion detail, fading with distance where it can no longer resolve.
    float ero = exp( -t * 0.00022 );
    if ( ero > 0.05 ) {
      float lodE = clamp( log2( 1.0 + t * 0.15 ), 0.0, 6.0 );
      float det = textureLod( tNoise, ( p.xz + vec2( p.y * 4.7, p.y * 3.1 ) ) * 0.00135, lodE ).b;
      d = max( 0.0, d - ( 1.0 - det ) * 0.40 * ero * ( 1.0 - d ) );
    }
    // Feather marginal densities away rather than letting single-step wisps
    // survive as dots.
    return d * smoothstep( 0.04, 0.18, d );
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 rv = uProjInv * vec4( ndc, 1.0, 1.0 );
    vec3 vDir = normalize( rv.xyz / rv.w );
    vec3 ray = normalize( ( uCamMat * vec4( vDir, 0.0 ) ).xyz );

    float depth = texture2D( tDepth, vUv ).x;
    float sceneDist = 1e7;
    if ( depth < 0.9999 ) {
      float viewZ = perspectiveDepthToViewZ( depth, uNear, uFar );
      sceneDist = viewZ / vDir.z; // both negative: positive distance
    }

    // Slab entry/exit along the ray.
    float t0, t1;
    if ( abs( ray.y ) < 1e-4 ) {
      bool inside = uCamPos.y > uBase && uCamPos.y < uTop;
      t0 = inside ? 0.0 : 1e8;
      t1 = inside ? 20000.0 : -1.0;
    } else {
      float ta = ( uBase - uCamPos.y ) / ray.y;
      float tb = ( uTop - uCamPos.y ) / ray.y;
      t0 = max( min( ta, tb ), 0.0 );
      t1 = max( ta, tb );
    }
    t1 = min( t1, sceneDist );
    t1 = min( t1, t0 + 14000.0 );
    if ( t1 <= t0 ) {
      gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
      return;
    }

    // Steps grow with distance: fine where a cloud edge can fill the screen,
    // coarse in the far field where the lod blur has smoothed everything.
    const int STEPS = 34;
    float jitter = hash12( vUv * 731.0 + fract( uTime * 0.37 ) * 291.0 );
    float t = t0 + 45.0 * jitter * 0.5;

    // Lighting model: sun attenuated by an analytic "cloud above me" term
    // with a multiple-scatter floor (single scattering alone turns every
    // base charcoal), a forward-scatter boost looking sunward, sky ambient.
    float mu = dot( ray, uSunDir );
    float phase = 0.50 + 1.1 * pow( max( mu, 0.0 ), 6.0 );
    vec3 ambient = mix( uHorizonColor, uZenithColor, 0.45 );

    vec3 acc = vec3( 0.0 );
    float T = 1.0;
    for ( int i = 0; i < STEPS; i++ ) {
      if ( t > t1 ) break;
      float stepLen = clamp( t * 0.06, 45.0, 720.0 );
      vec3 p = uCamPos + ray * t;
      float cov, lod;
      float d = density( p, t, cov, lod );
      if ( d > 0.003 ) {
        float hN = clamp( ( p.y - uBase ) / ( uTop - uBase ), 0.0, 1.0 );
        // Deeper in the slab = darker; thin tops glow through.
        float sunT = max( exp( -( 1.0 - hN ) * ( 1.6 + uCover * 1.2 ) * ( 0.25 + d * 2.0 ) ), 0.16 );
        float powder = 1.0 - exp( -d * 9.0 );
        vec3 lit = uSunColor * sunT * phase * 2.6 + ambient * ( 0.55 + 0.65 * hN );
        // Emboss: coverage rising toward the sun means this flank faces away.
        // It is what gives tops their cauliflower and bases their mottle.
        float c2 = coverage( p.xz + uSunDir.xz * 320.0, lod );
        lit *= clamp( 0.66 + ( cov - c2 ) * 2.8, 0.34, 1.4 );
        lit *= mix( 1.0, 0.42, uDark );
        float a = 1.0 - exp( -d * stepLen * 0.013 );
        acc += T * a * lit * powder;
        T *= 1.0 - a;
        if ( T < 0.015 ) break;
      }
      t += stepLen;
    }

    // Distant clouds sink into the haze like everything else does.
    float fogK = 1.0 - exp( -t0 * 0.00008 );
    acc = mix( acc, uHorizonColor * ( 1.0 - T ), fogK );

    gl_FragColor = vec4( acc, T );
  }
`;

const COMP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tClouds;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 base = texture2D( tDiffuse, vUv ).rgb;
    // Small tent filter over the half-res march hides the jitter dither at
    // soft cloud edges.
    vec4 c = texture2D( tClouds, vUv ) * 0.4
           + texture2D( tClouds, vUv + vec2( uTexel.x, 0.0 ) ) * 0.15
           + texture2D( tClouds, vUv - vec2( uTexel.x, 0.0 ) ) * 0.15
           + texture2D( tClouds, vUv + vec2( 0.0, uTexel.y ) ) * 0.15
           + texture2D( tClouds, vUv - vec2( 0.0, uTexel.y ) ) * 0.15;
    gl_FragColor = vec4( base * c.a + c.rgb, 1.0 );
  }
`;

export class VolCloudsPass extends Pass {
  constructor(camera, noiseTex) {
    super();
    this.camera = camera;
    this.depthTexture = null; // engine attaches this
    this.cover = 0.35;
    this.dark = 0;
    this.driftM = new THREE.Vector2();

    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;

    this.marchMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tNoise: { value: noiseTex },
        uProjInv: { value: new THREE.Matrix4() },
        uCamMat: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uNear: { value: 0.3 },
        uFar: { value: 30000 },
        uSunDir: atmo.uSunDir,
        uSunColor: atmo.uSunColor,
        uHorizonColor: atmo.uHorizonColor,
        uZenithColor: atmo.uZenithColor,
        uCover: { value: 0.35 },
        uDark: { value: 0 },
        uDriftM: { value: this.driftM },
        uTime: { value: 0 },
        uBase: { value: 950 },
        uTop: { value: 2500 },
      },
      vertexShader: VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tClouds: { value: this.rt.texture },
        uTexel: { value: new THREE.Vector2(1 / 2, 1 / 2) },
      },
      vertexShader: VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.marchMat);
  }

  setSize(w, h) {
    const hw = Math.max(2, w >> 1);
    const hh = Math.max(2, h >> 1);
    this.rt.setSize(hw, hh);
    this.compMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.marchMat.uniforms;
    u.tDepth.value = this.depthTexture;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamMat.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uCover.value = this.cover;
    u.uDark.value = this.dark;
    u.uTime.value += deltaTime || 0.016;

    const prev = renderer.getRenderTarget();
    this.quad.material = this.marchMat;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);

    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.rt.dispose();
    this.marchMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

// Screen-space light shafts.
//
// The classic bright-pass radial blur: take everything brighter than white in
// the HDR frame near the sun, smear it toward the sun's screen position, and
// add it back. Low sun through a forest canopy or a cloud edge produces the
// volume shafts that sell the air as a medium. Underwater it picks up the
// bright surface instead, which is exactly what shafts under water look like.
//
// All the marching happens in two quarter-resolution passes, so the whole
// effect costs about four full-resolution texture reads per frame.

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

// Isolate what should cast shafts: HDR brightness near the sun. The falloff
// around the sun's screen position keeps a bright snowfield at the bottom of
// the frame from smearing streaks across the whole sky.
const THRESH_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uSunScreen;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D( tDiffuse, vUv ).rgb;
    float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    float k = clamp( ( lum - 1.6 ) * 0.9, 0.0, 3.0 );
    vec2 d = ( vUv - uSunScreen ) * vec2( uAspect, 1.0 );
    float near = exp( -dot( d, d ) * 14.0 );
    gl_FragColor = vec4( c * ( k / max( lum, 1e-3 ) ) * near, 1.0 );
  }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uSunScreen;
  uniform float uDensity;
  varying vec2 vUv;
  void main() {
    vec2 step = ( uSunScreen - vUv ) * uDensity / 12.0;
    vec2 uv = vUv;
    vec3 acc = vec3( 0.0 );
    float w = 1.0;
    float wsum = 0.0;
    for ( int i = 0; i < 12; i++ ) {
      acc += texture2D( tInput, uv ).rgb * w;
      wsum += w;
      w *= 0.92;
      uv += step;
    }
    gl_FragColor = vec4( acc / wsum, 1.0 );
  }
`;

const COMP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tShafts;
  uniform vec3 uTint;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    vec3 base = texture2D( tDiffuse, vUv ).rgb;
    vec3 s = texture2D( tShafts, vUv ).rgb;
    gl_FragColor = vec4( base + s * uTint * uIntensity, 1.0 );
  }
`;

const V3 = new THREE.Vector3();
const FWD = new THREE.Vector3();

export class GodRaysPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.strength = 0.42;

    const opts = { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace };
    this.rtA = new THREE.WebGLRenderTarget(2, 2, opts);
    this.rtB = new THREE.WebGLRenderTarget(2, 2, opts);

    this.threshMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: THRESH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: 0.32 },
      },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tShafts: { value: null },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uIntensity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.threshMat);
  }

  setSize(w, h) {
    // Quarter resolution: shafts are soft by construction, and 1/16 of the
    // pixels is what makes the two marching passes nearly free.
    this.rtA.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.rtB.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.threshMat.uniforms.uAspect.value = w / Math.max(1, h);
  }

  /** Screen-space sun position and how strongly shafts should show. */
  _updateSun() {
    const sun = atmo.uSunDir.value;
    this.camera.getWorldDirection(FWD);
    const facing = FWD.dot(sun);
    if (facing <= 0.0) return 0;

    V3.copy(sun).multiplyScalar(5000).add(this.camera.position).project(this.camera);
    const sx = V3.x * 0.5 + 0.5;
    const sy = V3.y * 0.5 + 0.5;
    this.threshMat.uniforms.uSunScreen.value.set(sx, sy);
    this.blurMat.uniforms.uSunScreen.value.set(sx, sy);

    // Fade as the sun leaves the frame, is below the horizon, or is high in a
    // clear noon sky where shafts would read as haze smeared on the lens.
    const edge = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(V3.x), Math.abs(V3.y)), 0.7, 1.35);
    const up = THREE.MathUtils.smoothstep(sun.y, -0.08, 0.02);
    // Shafts belong to a low sun cutting through things. A high clear sun
    // gets almost nothing, or the whole sky turns into one washed-out halo.
    const lowSun = 1 + 1.6 * (1 - THREE.MathUtils.smoothstep(sun.y, 0.04, 0.35));
    const noonCut = 1 - 0.8 * THREE.MathUtils.smoothstep(sun.y, 0.18, 0.6);
    return this.strength * edge * up * lowSun * noonCut * Math.min(1, facing * 2.2);
  }

  render(renderer, writeBuffer, readBuffer) {
    const intensity = this._updateSun();
    const prevTarget = renderer.getRenderTarget();

    if (intensity > 0.003) {
      this.threshMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.quad.material = this.threshMat;
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);

      this.quad.material = this.blurMat;
      this.blurMat.uniforms.tInput.value = this.rtA.texture;
      this.blurMat.uniforms.uDensity.value = 0.34;
      renderer.setRenderTarget(this.rtB);
      this.quad.render(renderer);

      this.blurMat.uniforms.tInput.value = this.rtB.texture;
      this.blurMat.uniforms.uDensity.value = 0.62;
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);
    }

    // Warm shafts in air, water-coloured shafts below the surface.
    const tint = this.compMat.uniforms.uTint.value;
    if (atmo.uUnderwater.value > 0.5) {
      tint.copy(atmo.uWaterFog.value).multiplyScalar(3.0).addScalar(0.25);
    } else {
      const s = atmo.uSunColor.value;
      const m = Math.max(s.r, s.g, s.b, 1e-4);
      tint.setRGB(s.r / m, s.g / m, s.b / m);
    }
    this.compMat.uniforms.uIntensity.value = intensity > 0.003 ? intensity : 0;
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tShafts.value = this.rtA.texture;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);

    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.threshMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

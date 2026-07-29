// Renderer, camera and the post-processing chain.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Final look: vignette, grain, subtle aberration, underwater tint, fade. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.40 },
    uGrain: { value: 0.020 },
    uAberration: { value: 0.0008 },
    uSaturation: { value: 1.14 },
    uLift: { value: new THREE.Color(0.006, 0.008, 0.014) },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uUnderwater: { value: 0 },
    uFade: { value: 0 },
    uFadeColor: { value: new THREE.Color(0, 0, 0) },
    uDamage: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uSaturation, uUnderwater, uFade, uDamage;
    uniform vec3 uLift, uTint, uFadeColor;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot( c, c );

      // Underwater: a slow lens wobble.
      if ( uUnderwater > 0.5 ) {
        uv += vec2(
          sin( uv.y * 22.0 + uTime * 1.3 ) * 0.0016,
          cos( uv.x * 18.0 + uTime * 1.1 ) * 0.0016
        );
      }

      float ab = uAberration * ( 0.25 + r2 * 2.0 );
      vec3 col;
      col.r = texture2D( tDiffuse, uv + c * ab ).r;
      col.g = texture2D( tDiffuse, uv ).g;
      col.b = texture2D( tDiffuse, uv - c * ab ).b;

      // Saturation and a gentle filmic lift.
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l ), col, uSaturation );
      col = col * uTint + uLift * ( 1.0 - col );

      // Vignette.
      float vig = 1.0 - uVignette * smoothstep( 0.18, 0.95, r2 * 1.9 );
      col *= vig;

      // Film grain, animated.
      float g = hash( uv * uResolution + fract( uTime ) * 137.0 ) - 0.5;
      col += g * uGrain * ( 1.0 - l * 0.6 );

      if ( uDamage > 0.001 ) {
        col = mix( col, vec3( 0.55, 0.05, 0.04 ), uDamage * smoothstep( 0.05, 0.55, r2 ) );
      }

      col = mix( col, uFadeColor, clamp( uFade, 0.0, 1.0 ) );
      gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
    }
  `,
};

export class Engine {
  constructor(canvas, quality = {}) {
    this.canvas = canvas;
    this.quality = Object.assign(
      { shadows: true, bloom: true, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), shadowSize: 1536 },
      quality
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x87a7c4, 1);
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.fog = null; // we do our own aerial perspective

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.12, 42000);
    this.camera.rotation.order = 'YXZ';

    // A single shadow-casting sun that follows the player. Its frustum is
    // deliberately small: crisp contact shadows near you, none in the far
    // distance where the atmosphere hides them anyway.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = this.quality.shadows;
    const S = 108;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x8fb6de, 0x4a4433, 1.1);
    this.scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(0x93a9d6, 0.0);
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    this._setupComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _setupComposer() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), {
      type: THREE.HalfFloatType,
      samples: 4,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.72, 0.86);
    this.bloom.enabled = this.quality.bloom;
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr);
  }

  setQuality(q) {
    Object.assign(this.quality, q);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.sun.castShadow = this.quality.shadows;
    this.bloom.enabled = this.quality.bloom;
    this.resize();
  }

  render(dt) {
    this.grade.uniforms.uTime.value += dt;
    this.renderer.info.reset();
    this.composer.render(dt);
  }
}

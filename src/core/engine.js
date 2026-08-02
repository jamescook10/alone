// Renderer, camera and lights.
//
// There is no post-processing chain any more. The flat-shaded restyle renders
// straight to the canvas at native resolution with hardware MSAA, which is
// both the cheapest and the crispest way to draw hard-edged geometry. The few
// screen effects that survived (vignette, screen fade, the damage flush) are
// CSS overlays - free on the GPU and composited by the browser.

import * as THREE from 'three';

/**
 * Native resolution. Flat shading barely aliases and MSAA handles the edges,
 * so there is no supersampling and no sub-native-plus-sharpen. Capped at 2 so
 * a 3x phone screen does not pay nine times the pixels of a laptop.
 */
export function defaultPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/** A fullscreen, pointer-transparent overlay layer driven by a value 0..1. */
function overlayLayer(background) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:40;' +
    `background:${background};`;
  document.body.appendChild(el);
  return el;
}

export class Engine {
  constructor(canvas, quality = {}) {
    this.canvas = canvas;
    this.quality = Object.assign(
      { shadows: true, pixelRatio: defaultPixelRatio(), shadowSize: 1024, farK: 1 },
      quality
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA on the default framebuffer: near-free edge quality now that the
      // scene renders directly to the canvas instead of into a post chain.
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // Deliberately NOT a logarithmic depth buffer. It writes gl_FragDepth in
      // every fragment shader, which switches off early-Z rejection on every
      // GPU - very expensive in a forest, where overdraw is the whole problem.
      // A 0.3 m near plane gives enough precision without it.
      logarithmicDepthBuffer: false,
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    // r185 folded the old PCFSoft path into plain PCF (PCFSoftShadowMap is
    // deprecated and just logs a warning), so PCF is the soft option now.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x9db9d8, 1);
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.fog = null; // we do our own aerial perspective

    // Far enough to hold the horizon silhouette ring. Perspective depth
    // precision is set almost entirely by the near plane, so doubling this
    // costs nothing there.
    this.baseFar = 60000;
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, this.baseFar);
    this.camera.rotation.order = 'YXZ';

    // A single shadow-casting sun that follows the player. Its frustum is
    // deliberately small: crisp contact shadows near you, none in the far
    // distance where the atmosphere hides them anyway.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = this.quality.shadows;
    const S = 110;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
    // 1024 over 110 m is a coarser texel than the old 2048 map, so the soft
    // radius and biases are retuned to keep edges dappled rather than jagged.
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 1.0;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9db9d8, 0x6a6656, 1.1);
    this.scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(0x93a9d6, 0.0);
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    // The old post-chain grade pass kept these uniforms; the rest of the game
    // still writes to them, so the same object shape survives - it just feeds
    // CSS overlays now instead of a shader.
    this.grade = {
      uniforms: {
        uVignette: { value: 0.4 },
        uFade: { value: 0 },
        uFadeColor: { value: new THREE.Color(0, 0, 0) },
        uDamage: { value: 0 },
        uUnderwater: { value: 0 },
        uSaturation: { value: 1 },
      },
    };
    this._vignetteEl = overlayLayer(
      'radial-gradient(ellipse at center, rgba(0,0,8,0) 42%, rgba(0,0,8,0.62) 100%)'
    );
    this._damageEl = overlayLayer(
      'radial-gradient(ellipse at center, rgba(140,13,10,0) 30%, rgba(140,13,10,0.85) 100%)'
    );
    this._fadeEl = overlayLayer('#000');
    this._fadeEl.style.zIndex = '60';
    this._overlayState = { vignette: -1, damage: -1, fade: -1, fadeColor: '' };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Pixels actually shaded per frame, for the on-screen readout. */
  get shadedPixels() {
    const pr = this.renderer.getPixelRatio();
    return Math.round(window.innerWidth * pr * window.innerHeight * pr);
  }

  setQuality(q) {
    Object.assign(this.quality, q);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.sun.castShadow = this.quality.shadows;
    // Draw distance: the streamed world is hidden by fog long before the far
    // plane at full quality; the reduced setting pulls the plane in and lets
    // frustum culling drop the far chunks entirely.
    this.camera.far = this.baseFar * this.quality.farK;
    this.resize();
  }

  _syncOverlays() {
    const u = this.grade.uniforms;
    const s = this._overlayState;
    const vig = Math.round(u.uVignette.value * 100) / 100;
    if (vig !== s.vignette) {
      s.vignette = vig;
      this._vignetteEl.style.opacity = String(Math.min(1, vig * 1.9));
    }
    const dmg = Math.round(u.uDamage.value * 100) / 100;
    if (dmg !== s.damage) {
      s.damage = dmg;
      this._damageEl.style.opacity = String(Math.min(1, dmg));
    }
    const fade = Math.round(u.uFade.value * 200) / 200;
    if (fade !== s.fade) {
      s.fade = fade;
      this._fadeEl.style.opacity = String(Math.min(1, fade));
    }
    const fc = u.uFadeColor.value.getStyle();
    if (fc !== s.fadeColor) {
      s.fadeColor = fc;
      this._fadeEl.style.background = fc;
    }
    // Cold drains the colour from the world; values at or above 1 mean no
    // filter at all, so the common case costs nothing.
    const sat = Math.round(u.uSaturation.value * 50) / 50;
    if (sat !== s.saturation) {
      s.saturation = sat;
      this.canvas.style.filter = sat < 0.99 ? `saturate(${sat})` : '';
    }
  }

  render() {
    this._syncOverlays();
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
  }
}

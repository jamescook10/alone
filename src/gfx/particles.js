// One particle system for the whole world: fire, smoke, steam, spray, sparks,
// dust, falling leaves and explosions. Two instanced quad pools - one additive
// for anything that glows, one alpha-blended for anything that does not.

import * as THREE from 'three';
import { blobTexture } from './materials.js';
import { atmo } from './atmosphere.js';
import { clamp, lerp } from '../core/noise.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec2 aSizeAlpha;
attribute float aRot;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vColor = aColor;
  vAlpha = aSizeAlpha.y;
  vUv = uv;
  float s = aSizeAlpha.x;
  vec3 toCam = normalize( cameraPosition - aPos );
  vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) );
  vec3 up = cross( toCam, right );
  float c = cos( aRot ), sn = sin( aRot );
  vec2 p = vec2( position.x * c - position.y * sn, position.x * sn + position.y * c );
  vec3 world = aPos + ( right * p.x + up * p.y ) * s;
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
precision mediump float;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tMap;
uniform float uUnderwater;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D( tMap, vUv );
  float a = t.a * vAlpha;
  if ( a < 0.005 ) discard;
  gl_FragColor = vec4( vColor, a );
}
`;

class Pool {
  constructor(cap, mat, scene) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.sa = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    for (const a of [this.pos, this.col, this.sa, this.rot]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.pos);
    geo.setAttribute('aColor', this.col);
    geo.setAttribute('aSizeAlpha', this.sa);
    geo.setAttribute('aRot', this.rot);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    scene.add(this.mesh);
    this.cap = cap;
    this.items = [];
  }
  spawn(p) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push(p);
    return p;
  }
  commit() {
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const p = this.items[i];
      this.pos.array[i * 3] = p.x;
      this.pos.array[i * 3 + 1] = p.y;
      this.pos.array[i * 3 + 2] = p.z;
      this.col.array[i * 3] = p.r;
      this.col.array[i * 3 + 1] = p.g;
      this.col.array[i * 3 + 2] = p.b;
      this.sa.array[i * 2] = p.size;
      this.sa.array[i * 2 + 1] = p.alpha;
      this.rot.array[i] = p.rot;
    }
    this.mesh.geometry.instanceCount = n;
    this.pos.needsUpdate = this.col.needsUpdate = this.sa.needsUpdate = this.rot.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}

export class Particles {
  constructor(world) {
    this.world = world;
    const tex = blobTexture(0.42);
    const soft = blobTexture(0.14);
    this.addMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: tex }, uUnderwater: atmo.uUnderwater },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.alphaMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: soft }, uUnderwater: atmo.uUnderwater },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.glow = new Pool(1400, this.addMat, world.engine.scene);
    this.soft = new Pool(2200, this.alphaMat, world.engine.scene);
  }

  _p(pool, x, y, z, opts) {
    return pool.spawn({
      x, y, z,
      vx: opts.vx || 0, vy: opts.vy || 0, vz: opts.vz || 0,
      r: opts.r, g: opts.g, b: opts.b,
      size: opts.size, size0: opts.size, grow: opts.grow || 0,
      alpha: opts.alpha, alpha0: opts.alpha,
      rot: Math.random() * 6.283, spin: (Math.random() - 0.5) * 2.4,
      life: opts.life, life0: opts.life,
      drag: opts.drag !== undefined ? opts.drag : 1.2,
      grav: opts.grav !== undefined ? opts.grav : 0,
      wind: opts.wind !== undefined ? opts.wind : 0.3,
      flick: opts.flick || 0,
      kind: opts.kind || 0,
    });
  }

  /* -------------------------------------------------------------- emitters */

  fire(x, y, z, scale = 1, n = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const r = Math.random() * 0.35 * scale;
      this._p(this.glow, x + Math.cos(a) * r, y + Math.random() * 0.2 * scale, z + Math.sin(a) * r, {
        vy: (1.6 + Math.random() * 1.9) * scale,
        vx: (Math.random() - 0.5) * 0.5, vz: (Math.random() - 0.5) * 0.5,
        r: 2.6, g: 1.05, b: 0.24,
        size: (0.42 + Math.random() * 0.5) * scale,
        grow: -0.30 * scale,
        alpha: 0.85, life: 0.42 + Math.random() * 0.42,
        drag: 1.1, wind: 0.5, flick: 1,
      });
    }
  }

  smoke(x, y, z, scale = 1, dark = 0.5, n = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const r = Math.random() * 0.4 * scale;
      const v = lerp(0.42, 0.10, dark);
      this._p(this.soft, x + Math.cos(a) * r, y + 0.5 * scale, z + Math.sin(a) * r, {
        vy: (1.1 + Math.random() * 1.1) * scale,
        vx: (Math.random() - 0.5) * 0.4, vz: (Math.random() - 0.5) * 0.4,
        r: v, g: v * 0.98, b: v * 0.96,
        size: (0.7 + Math.random() * 0.7) * scale,
        grow: 1.5 * scale,
        alpha: 0.30, life: 2.6 + Math.random() * 3.4,
        drag: 0.55, wind: 1.6,
      });
    }
  }

  steam(x, y, z, scale = 1, n = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const r = Math.random() * 0.2 * scale;
      this._p(this.soft, x + Math.cos(a) * r, y, z + Math.sin(a) * r, {
        vy: (1.4 + Math.random() * 1.2) * scale,
        r: 1.0, g: 1.0, b: 1.02,
        size: (0.24 + Math.random() * 0.28) * scale,
        grow: 1.05 * scale,
        alpha: 0.40, life: 1.1 + Math.random() * 1.3,
        drag: 1.0, wind: 1.3,
      });
    }
  }

  splash(x, y, z, power = 1, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const s = (0.6 + Math.random()) * power;
      this._p(this.soft, x, y, z, {
        vx: Math.cos(a) * s * 1.7, vz: Math.sin(a) * s * 1.7,
        vy: (1.6 + Math.random() * 2.6) * power,
        r: 0.82, g: 0.92, b: 0.98,
        size: 0.10 + Math.random() * 0.16 * power,
        grow: 0.05,
        alpha: 0.75, life: 0.5 + Math.random() * 0.5,
        drag: 0.3, grav: -13, wind: 0.1,
      });
    }
  }

  sparks(x, y, z, n = 12, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const e = Math.random() * 1.3;
      const s = (2.5 + Math.random() * 6) * power;
      this._p(this.glow, x, y, z, {
        vx: Math.cos(a) * Math.cos(e) * s, vz: Math.sin(a) * Math.cos(e) * s,
        vy: Math.sin(e) * s + 1.5,
        r: 3.2, g: 1.5, b: 0.4,
        size: 0.045 + Math.random() * 0.05,
        alpha: 1, life: 0.5 + Math.random() * 0.9,
        drag: 0.35, grav: -12, wind: 0.2, flick: 1,
      });
    }
  }

  dust(x, y, z, n = 6, scale = 1, col = [0.30, 0.26, 0.20]) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      this._p(this.soft, x, y, z, {
        vx: Math.cos(a) * 1.4 * scale, vz: Math.sin(a) * 1.4 * scale,
        vy: 0.7 + Math.random() * 1.1,
        r: col[0], g: col[1], b: col[2],
        size: (0.5 + Math.random() * 0.8) * scale, grow: 1.3 * scale,
        alpha: 0.36, life: 1.4 + Math.random() * 2.2,
        drag: 0.7, wind: 1.4,
      });
    }
  }

  leaf(x, y, z, col) {
    this._p(this.soft, x, y, z, {
      vy: -0.5 - Math.random() * 0.4,
      r: col[0] * 3, g: col[1] * 3, b: col[2] * 3,
      size: 0.12 + Math.random() * 0.1,
      alpha: 0.9, life: 6 + Math.random() * 6,
      drag: 1.6, wind: 2.2, grav: -0.4, kind: 1,
    });
  }

  explosion(x, y, z, power = 1) {
    const s = 0.9 + power * 0.9;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.283;
      const e = (Math.random() - 0.25) * 2;
      const sp = (3 + Math.random() * 11) * s;
      this._p(this.glow, x, y, z, {
        vx: Math.cos(a) * Math.cos(e) * sp, vz: Math.sin(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp * 0.8 + 3,
        r: 3.4, g: 1.5, b: 0.35,
        size: (0.9 + Math.random() * 1.4) * s, grow: 1.6 * s,
        alpha: 1, life: 0.42 + Math.random() * 0.5,
        drag: 1.9, wind: 0.4, flick: 1,
      });
    }
    this.smoke(x, y + 0.6, z, s * 2.4, 0.75, 22);
    this.sparks(x, y, z, 30, power);
    this.dust(x, y, z, 12, s * 1.5);
  }

  /** A short-lived point of light for fire and explosions. */
  update(dt) {
    if (dt <= 0) {
      this.glow.commit();
      this.soft.commit();
      return;
    }
    const wind = atmo.uWind.value;
    const ws = atmo.uWindStrength.value;
    for (const pool of [this.glow, this.soft]) {
      const items = pool.items;
      for (let i = items.length - 1; i >= 0; i--) {
        const p = items[i];
        p.life -= dt;
        if (p.life <= 0) {
          items.splice(i, 1);
          continue;
        }
        const k = 1 - p.life / p.life0;
        const drag = Math.exp(-dt * p.drag);
        p.vx = p.vx * drag + wind.x * ws * p.wind * dt * 2.2;
        p.vz = p.vz * drag + wind.y * ws * p.wind * dt * 2.2;
        p.vy = p.vy * drag + p.grav * dt;
        if (p.kind === 1) {
          // leaves flutter
          p.vx += Math.sin(p.rot * 3 + p.life * 6) * dt * 1.2;
          p.vz += Math.cos(p.rot * 2 + p.life * 5) * dt * 1.2;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rot += p.spin * dt;
        p.size = Math.max(0.01, p.size0 + p.grow * k);
        p.alpha = p.alpha0 * (p.flick
          ? (1 - k) * (1 - k) * (0.7 + 0.3 * Math.sin(p.life * 42 + p.rot * 9))
          : Math.sin(Math.min(1, k * 3.2) * 1.5708) * (1 - k * k));
      }
      pool.commit();
    }
  }
}

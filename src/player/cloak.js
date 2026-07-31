// The cloak.
//
// A sheet of verlet cloth pinned across the shoulders. Nothing about it is
// animated: it falls under gravity, it is pushed by the same wind the trees
// and the rain use, and it drags behind because its pins move and its
// particles do not know that yet. That last part is free - it is the whole
// reason to simulate cloth rather than skin it - and it is what makes
// walking into a headwind look like walking into a headwind.
//
// It also does the job the hood does: a long garment hides the parts of a
// human walk that are hardest to fake, and the silhouette carries the
// character instead of the anatomy.

import * as THREE from 'three';
import { makeSolidMaterial } from '../gfx/materials.js';

const COLS = 9;
const ROWS = 13;
const STEP = 1 / 60; // fixed, so the cloth behaves the same at 3 fps and 300
const MAX_SUB = 3;
const GRAVITY = -7.4; // under-gravity: cloth reads better a little floaty
const DAMP = 0.984;
const ITERS = 3;
const MAX_STEP2 = (9 * STEP) * (9 * STEP); // 9 m/s, as a squared per-step distance

// Reflectance, like everything else. A shade warmer and lighter than the
// coat so the two garments separate instead of reading as one dark mass.
const COL_TOP = [0.150, 0.143, 0.116];
const COL_HEM = [0.104, 0.098, 0.080]; // years of being dragged through wet grass

// The body, as a stack of radii measured up from the feet. The cloak has to
// hang off something or it passes straight through the coat it is worn over.
const PROFILE = [
  [0.00, 0.170], [0.40, 0.205], [0.62, 0.262], [0.75, 0.255],
  [0.95, 0.200], [1.10, 0.185], [1.30, 0.205], [1.50, 0.160], [1.80, 0.090],
];

function profileAt(h) {
  if (h <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 1; i < PROFILE.length; i++) {
    if (h <= PROFILE[i][0]) {
      const [h0, r0] = PROFILE[i - 1];
      const [h1, r1] = PROFILE[i];
      return r0 + (r1 - r0) * ((h - h0) / (h1 - h0));
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

const V = new THREE.Vector3();
const M = new THREE.Matrix4();

export class Cloak {
  /** @param chestBone the bone the shoulders belong to, already in bind pose */
  constructor(chestBone) {
    this.n = COLS * ROWS;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.local = new Float32Array(this.n * 3); // the rest sheet, in chest space
    this.pinFrom = new Float32Array(COLS * 3); // where the fastening was
    this.pinTo = new Float32Array(COLS * 3); // and where it is now
    this.cons = [];
    this.seeded = false;
    this.t = 0;
    this._acc = 0;

    // Lay the rest sheet out in bind space, then keep it in the chest's own
    // frame so the pins can be found again from one matrix multiply.
    chestBone.updateMatrixWorld(true);
    M.copy(chestBone.matrixWorld).invert();
    const bind = [];
    for (let r = 0; r < ROWS; r++) {
      const t = r / (ROWS - 1);
      for (let c = 0; c < COLS; c++) {
        const s = (c / (COLS - 1)) * 2 - 1;
        // The top edge follows the shoulder line: to just inside the joints
        // at the ends, tucked back behind the neck in the middle. Any wider
        // and the corners sit on top of the deltoid instead of behind it,
        // and the first gust flips one up over the shoulder.
        const x = (0.178 + 0.282 * t) * s;
        const y = 1.462 - 0.045 * Math.abs(s) - 0.080 * r;
        const z = -0.055 - 0.062 * (1 - s * s) - 0.020 * t;
        bind.push(new THREE.Vector3(x, y, z));
        V.set(x, y, z).applyMatrix4(M);
        const i = (r * COLS + c) * 3;
        this.local[i] = V.x; this.local[i + 1] = V.y; this.local[i + 2] = V.z;
      }
    }

    // Structural, shear and a vertical bend. The bend is what stops it
    // behaving like a bead curtain; without it the hem folds up on itself
    // the first time you stop walking.
    const at = (r, c) => r * COLS + c;
    const link = (a, b, stiff) => this.cons.push({ a, b, d: bind[a].distanceTo(bind[b]), k: stiff });
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c + 1 < COLS) link(at(r, c), at(r, c + 1), 1);
        if (r + 1 < ROWS) link(at(r, c), at(r + 1, c), 1);
        if (c + 1 < COLS && r + 1 < ROWS) {
          link(at(r, c), at(r + 1, c + 1), 0.4);
          link(at(r, c + 1), at(r + 1, c), 0.4);
        }
        if (r + 2 < ROWS) link(at(r, c), at(r + 2, c), 0.25);
      }
    }

    /* --- the mesh -------------------------------------------------- */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const col = new Float32Array(this.n * 3);
    for (let r = 0; r < ROWS; r++) {
      const t = r / (ROWS - 1);
      for (let c = 0; c < COLS; c++) {
        const i = (r * COLS + c) * 3;
        for (let k = 0; k < 3; k++) col[i + k] = COL_TOP[k] + (COL_HEM[k] - COL_TOP[k]) * t;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // Flat shading takes its normals from screen-space derivatives, so these
    // are never read - but a missing attribute reads as zero, and that trap
    // has cost this project a day before.
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    const idx = [];
    for (let r = 0; r + 1 < ROWS; r++) {
      for (let c = 0; c + 1 < COLS; c++) {
        const a = at(r, c), b = at(r, c + 1), d = at(r + 1, c + 1), e = at(r + 1, c);
        idx.push(a, b, d, a, d, e);
      }
    }
    geo.setIndex(idx);

    this.material = makeSolidMaterial({ key: 'cloak', roughness: 0.95, doubleSide: true });
    this.material.transparent = true;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // it is always next to the camera anyway
    this.geo = geo;
  }

  /** Hang it straight off the shoulders again - on waking, or on reappearing. */
  reseed(chestBone) {
    const m = chestBone.matrixWorld;
    for (let i = 0; i < this.n; i++) {
      V.set(this.local[i * 3], this.local[i * 3 + 1], this.local[i * 3 + 2]).applyMatrix4(m);
      this.pos[i * 3] = this.prev[i * 3] = V.x;
      this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = V.y;
      this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = V.z;
    }
    this.seeded = true;
    this.pinTo.set(this.pos.subarray(0, COLS * 3));
    this.pinFrom.set(this.pinTo);
    this.geo.attributes.position.needsUpdate = true;
  }

  update(dt, ctx) {
    const chest = ctx.chest;
    if (!this.seeded) this.reseed(chest);

    // Where the shoulders have got to this frame.
    this.pinFrom.set(this.pinTo);
    for (let c = 0; c < COLS; c++) {
      const i = c * 3;
      V.set(this.local[i], this.local[i + 1], this.local[i + 2]).applyMatrix4(chest.matrixWorld);
      this.pinTo[i] = V.x; this.pinTo[i + 1] = V.y; this.pinTo[i + 2] = V.z;
    }

    this._acc = Math.min(this._acc + dt, STEP * MAX_SUB);
    const subs = Math.floor(this._acc / STEP);
    for (let i = 0; i < subs; i++) {
      this._acc -= STEP;
      this.t += STEP;
      // Walk the fastening from where it was to where it is across the
      // substeps instead of teleporting it on the first one. At the frame
      // rates this thing has to survive, a whole frame of travel arriving in
      // one step is an impulse the solver turns into velocity, and the cloak
      // ends up thrown over the wearer's head.
      this._step(ctx, subs > 1 ? (i + 1) / subs : 1);
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  _step(ctx, f) {
    const p = this.pos, q = this.prev;

    // Wind, plus a flutter that runs across the cloth. The flutter is what
    // sells it - a sheet pushed by a single uniform force just hangs at an
    // angle, which reads as cardboard.
    const w = ctx.wind;
    const gust = 0.55 + 0.45 * Math.sin(this.t * 1.7);
    const fx = w.x * w.strength * 2.6 * gust;
    const fz = w.z * w.strength * 2.6 * gust;
    const flut = w.strength * 1.9;

    const h2 = STEP * STEP;
    for (let r = 1; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = (r * COLS + c) * 3;
        const ripple = Math.sin(this.t * 8.5 + r * 0.8 + c * 1.7) * flut * (r / ROWS);
        const ax = fx + ripple * 0.6;
        const az = fz + ripple * 0.6;
        // Verlet turns any positional correction into velocity next step,
        // and a collider arguing with a constraint can hand the cloth more
        // of it every step. The speed limit is the backstop: cloth this
        // light never legitimately moves faster than a thrown stone.
        let vx = (p[i] - q[i]) * DAMP;
        let vy = (p[i + 1] - q[i + 1]) * DAMP;
        let vz = (p[i + 2] - q[i + 2]) * DAMP;
        const v2 = vx * vx + vy * vy + vz * vz;
        if (v2 > MAX_STEP2) {
          const k = Math.sqrt(MAX_STEP2 / v2);
          vx *= k; vy *= k; vz *= k;
        }
        q[i] = p[i]; q[i + 1] = p[i + 1]; q[i + 2] = p[i + 2];
        p[i] += vx + ax * h2;
        p[i + 1] += vy + (GRAVITY + ripple * 0.35) * h2;
        p[i + 2] += vz + az * h2;
      }
    }

    // Pins last: they are authoritative, and writing them before the
    // integrator would let one frame of gravity move them.
    for (let i = 0; i < COLS * 3; i++) {
      q[i] = p[i];
      p[i] = this.pinFrom[i] + (this.pinTo[i] - this.pinFrom[i]) * f;
    }

    for (let it = 0; it < ITERS; it++) {
      for (const con of this.cons) {
        const ia = con.a * 3, ib = con.b * 3;
        const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const diff = ((d - con.d) / d) * con.k * 0.5;
        const mxa = con.a < COLS ? 0 : 1; // the top row does not move
        const mxb = con.b < COLS ? 0 : 1;
        const tot = mxa + mxb;
        if (!tot) continue;
        const sa = (mxa / tot) * 2 * diff, sb = (mxb / tot) * 2 * diff;
        p[ia] += dx * sa; p[ia + 1] += dy * sa; p[ia + 2] += dz * sa;
        p[ib] -= dx * sb; p[ib + 1] -= dy * sb; p[ib + 2] -= dz * sb;
      }
    }
    // Once, after the solver has settled - collide inside the iteration and
    // the two of them push against each other three times a step.
    this._collide(ctx);
  }

  /** Keep it outside the body, and off the floor. */
  _collide(ctx) {
    const p = this.pos;
    const cs = Math.cos(-ctx.facing), sn = Math.sin(-ctx.facing);
    const floor = ctx.feetY + 0.03;

    // Cloth wants to lift, and a corner that lifts here ends up draped over
    // the shoulder from in front. The rows nearest the fastening cannot rise
    // above it; below that it is free to fly.
    let pinTop = -Infinity;
    for (let c = 0; c < COLS; c++) pinTop = Math.max(pinTop, p[c * 3 + 1]);
    const capped = COLS * 3; // the two rows under the fastening

    for (let i = COLS; i < this.n; i++) {
      const j = i * 3;
      if (p[j + 1] < floor) p[j + 1] = floor;
      if (i < capped && p[j + 1] > pinTop) p[j + 1] = pinTop;

      // Into the body's own frame, where the collider is an axis-aligned
      // ellipse: a person is half again as wide as they are deep, and a
      // circle fat enough not to let the cloak through the back would stand
      // it a hand's width off the hips.
      const dx = p[j] - ctx.bodyX, dz = p[j + 2] - ctx.bodyZ;
      let lx = dx * cs - dz * sn;
      let lz = dx * sn + dz * cs;
      const h = p[j + 1] - ctx.feetY;
      const r = profileAt(h);
      const ax = r * 1.22, az = r * 0.95;
      const ex = lx / ax, ez = lz / az;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d < 1 && d > 1e-5) {
        lx = (ex / d) * ax;
        lz = (ez / d) * az;
      }
      // Nothing above the chest may come forward of the shoulders. The cloak
      // is fastened there; without this a gust walks a top corner round the
      // outside of the arm and drapes it down the front, which looks less
      // like cloth than like a mistake.
      if (h > 1.10 && lz > -0.02) lz = -0.02;
      p[j] = ctx.bodyX + lx * cs + lz * sn;
      p[j + 2] = ctx.bodyZ - lx * sn + lz * cs;
    }
  }

  setOpacity(o) {
    this.mesh.visible = o > 0.015;
    this.material.opacity = o;
    this.material.transparent = o < 0.995;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}

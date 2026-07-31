// Animal bodies.
//
// Everything here feeds the same GPU rig wildlife.js has always used: every
// vertex carries a limb id and a pivot, and the vertex shader swings whole
// limbs. What changed is the flesh - smooth tapered spines instead of boxes,
// countershaded bellies, two-segment legs (the shader bends the lower half at
// the knee via a second pivot), ears, antlers, eyes. Still a few hundred
// triangles per animal, still one instanced draw per species.

import * as THREE from 'three';

const UP = [0, 1, 0];

export class SmoothLimbs {
  constructor() {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.limb = [];
    this.pivot = [];
    this.pivot2 = [];
    this.idx = [];
  }

  _vert(p, n, c, limb, pivot, pivot2) {
    this.pos.push(p[0], p[1], p[2]);
    this.norm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.limb.push(limb);
    const pv = pivot || [0, 0, 0];
    const pv2 = pivot2 || pv;
    this.pivot.push(pv[0], pv[1], pv[2]);
    this.pivot2.push(pv2[0], pv2[1], pv2[2]);
    return this.pos.length / 3 - 1;
  }

  /**
   * A smooth tube along a polyline with per-point radii; rounded closed ends.
   * The workhorse: torsos, necks, heads, legs, tails, horns are all spines.
   *
   * opts: seg, col, colBelly, limb, pivot, pivot2, sx (width squash),
   *       sy (height squash), dark tip fraction, shade
   */
  spine(pts, radii, opts = {}) {
    const seg = opts.seg || 8;
    const col = opts.col || [0.5, 0.5, 0.5];
    const belly = opts.colBelly || null;
    const sx = opts.sx !== undefined ? opts.sx : 1;
    const sy = opts.sy !== undefined ? opts.sy : 1;
    const limb = opts.limb || 0;
    const n = pts.length;

    // Tangents.
    const tans = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(t[0], t[1], t[2]) || 1;
      tans.push([t[0] / l, t[1] / l, t[2] / l]);
    }

    const rings = [];
    for (let i = 0; i < n; i++) {
      const t = tans[i];
      const ref = Math.abs(t[1]) > 0.92 ? [0, 0, 1] : UP;
      let side = [
        ref[1] * t[2] - ref[2] * t[1],
        ref[2] * t[0] - ref[0] * t[2],
        ref[0] * t[1] - ref[1] * t[0],
      ];
      let sl = Math.hypot(side[0], side[1], side[2]) || 1;
      side = [side[0] / sl, side[1] / sl, side[2] / sl];
      const up2 = [
        t[1] * side[2] - t[2] * side[1],
        t[2] * side[0] - t[0] * side[2],
        t[0] * side[1] - t[1] * side[0],
      ];
      const ring = [];
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const ca = Math.cos(a) * sx;
        const sa = Math.sin(a) * sy;
        const r = radii[i];
        const p = [
          pts[i][0] + (side[0] * ca + up2[0] * sa) * r,
          pts[i][1] + (side[1] * ca + up2[1] * sa) * r,
          pts[i][2] + (side[2] * ca + up2[2] * sa) * r,
        ];
        let nx = side[0] * Math.cos(a) + up2[0] * Math.sin(a);
        let ny = side[1] * Math.cos(a) + up2[1] * Math.sin(a);
        let nz = side[2] * Math.cos(a) + up2[2] * Math.sin(a);
        const nl = Math.hypot(nx, ny, nz) || 1;
        const nrm = [nx / nl, ny / nl, nz / nl];
        // Countershading: faces pointing down blend toward the belly colour.
        let c = col;
        if (belly) {
          const down = Math.max(0, -nrm[1]);
          const m = Math.min(1, down * 1.4);
          c = [col[0] + (belly[0] - col[0]) * m, col[1] + (belly[1] - col[1]) * m, col[2] + (belly[2] - col[2]) * m];
        }
        ring.push(this._vert(p, nrm, c, limb, opts.pivot, opts.pivot2));
      }
      rings.push(ring);
    }

    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < seg; k++) {
        const a = rings[i][k];
        const b = rings[i][(k + 1) % seg];
        const c = rings[i + 1][(k + 1) % seg];
        const d = rings[i + 1][k];
        this.idx.push(a, b, c, a, c, d);
      }
    }

    // Rounded caps: an apex vertex just beyond each end.
    const cap = (i, dir) => {
      const t = tans[i];
      const r = radii[i] * 0.55;
      const p = [pts[i][0] + t[0] * r * dir, pts[i][1] + t[1] * r * dir, pts[i][2] + t[2] * r * dir];
      const nrm = [t[0] * dir, t[1] * dir, t[2] * dir];
      const apex = this._vert(p, nrm, col, limb, opts.pivot, opts.pivot2);
      for (let k = 0; k < seg; k++) {
        const a = rings[i][k];
        const b = rings[i][(k + 1) % seg];
        if (dir > 0) this.idx.push(a, b, apex);
        else this.idx.push(b, a, apex);
      }
    };
    if (opts.capStart !== false) cap(0, -1);
    if (opts.capEnd !== false) cap(n - 1, 1);
  }

  /** Small shaded ball - eyes, noses, fruit-sized details. */
  ball(cx, cy, cz, r, col, opts = {}) {
    const seg = opts.seg || 6;
    this.spine(
      [[cx, cy - r * 0.7, cz], [cx, cy, cz], [cx, cy + r * 0.7, cz]],
      [r * 0.55, r, r * 0.55],
      { seg, col, limb: opts.limb || 0, pivot: opts.pivot, pivot2: opts.pivot2 }
    );
  }

  /** A thin flat blade with thickness - ears, fins, wings, flukes. */
  blade(pts, widths, opts = {}) {
    this.spine(pts, widths, Object.assign({ seg: 6, sy: 0.22 }, opts));
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aLimb', new THREE.Float32BufferAttribute(this.limb, 1));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.pivot, 3));
    g.setAttribute('aPivot2', new THREE.Float32BufferAttribute(this.pivot2, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const mul = (c, k, add = 0) => [Math.min(1, c[0] * k + add), Math.min(1, c[1] * k + add), Math.min(1, c[2] * k + add)];

function quadruped(L, sp) {
  const [bx, by, bz] = sp.body;
  const legY = sp.legs;
  const c = sp.col;
  const dark = mul(c, 0.55);
  const pale = sp.belly || mul(c, 1.5, 0.06);
  const yB = legY + by;

  // Torso: deep chest, tucked waist, round rump. A camel gets its hump from
  // the same profile.
  const prof = sp.hump ? [0.62, 0.95, 1.3, 0.95, 0.8] : [0.66, 1.0, 0.96, 0.9, 0.72];
  const lift = sp.hump ? [0, 0.1, 0.5, 0.15, 0.05] : [0.05, 0, 0, 0.02, 0.08];
  const zs = [-1.05, -0.55, 0, 0.55, 1.0];
  L.spine(
    zs.map((z, i) => [0, yB + lift[i] * by, z * bz]),
    prof.map((p) => p * by),
    { col: c, colBelly: pale, sx: bx / by, seg: 10 }
  );

  // A mane along the crest of the neck and shoulders. Cheap, and it is the
  // whole difference between a horse and a donkey - or a lion and a big cat.
  if (sp.mane) {
    L.blade(
      [[0, yB + by * 0.9, bz * 0.7], [0, yB + by * 1.0, bz * 0.1], [0, yB + by * 0.85, -bz * 0.3]],
      [by * 0.5, by * 0.55, by * 0.3],
      { col: mul(c, 0.55), sx: 0.16, sy: 1.0, seg: 5 }
    );
  }
  // A shaggy fleece: a second, lumpier skin over the torso.
  if (sp.fleece) {
    L.spine(
      [[0, yB + by * 0.1, -bz * 0.85], [0, yB + by * 0.16, 0], [0, yB + by * 0.1, bz * 0.8]],
      [by * 1.12, by * 1.22, by * 1.02],
      { col: mul(c, 1.15, 0.03), sx: bx / by, seg: 7 }
    );
  }

  // Neck and head, one limb so the graze/alert dip moves them together. A
  // giraffe is the same rig with the neck turned up to two metres.
  const headPivot = [0, yB, bz * 0.7];
  const nTop = [0, yB + sp.neck, bz * 0.95 + sp.neck * 0.22];
  const longNeck = sp.neck > by * 2.2;
  L.spine(
    longNeck
      ? [[0, yB + by * 0.1, bz * 0.62], [0, yB + sp.neck * 0.35, bz * 0.74],
         [0, yB + sp.neck * 0.7, bz * 0.86], nTop]
      : [[0, yB + by * 0.1, bz * 0.62], [0, yB + sp.neck * 0.55, bz * 0.8], nTop],
    longNeck ? [by * 0.52, by * 0.36, by * 0.30, by * 0.26] : [by * 0.52, by * 0.4, by * 0.36],
    { col: c, colBelly: pale, limb: 5, pivot: headPivot, seg: 8 }
  );
  const hz = nTop[2];
  const hy = nTop[1] + by * 0.12;
  L.spine(
    [[0, hy, hz - by * 0.1], [0, hy + by * 0.04, hz + bz * 0.28], [0, hy - by * 0.06, hz + bz * 0.5]],
    [by * 0.42, by * 0.34, by * 0.18],
    { col: c, limb: 5, pivot: headPivot, seg: 8 }
  );
  // Nose and eyes.
  L.ball(0, hy - by * 0.05, hz + bz * 0.54, by * 0.1, mul(c, 0.3), { limb: 5, pivot: headPivot });
  for (const s of [-1, 1]) {
    L.ball(s * bx * 0.3, hy + by * 0.16, hz + bz * 0.2, by * 0.09, [0.02, 0.02, 0.025], { limb: 5, pivot: headPivot });
  }

  // A trunk hangs from the head and swings with it.
  if (sp.trunk) {
    L.spine(
      [[0, hy - by * 0.1, hz + bz * 0.5], [0, hy - by * 0.7, hz + bz * 0.62],
       [0, hy - by * 1.5, hz + bz * 0.5], [0, hy - by * 2.0, hz + bz * 0.66]],
      [by * 0.20, by * 0.16, by * 0.11, by * 0.07],
      { col: c, limb: 5, pivot: headPivot, seg: 7 }
    );
  }
  // A long soft snout - tapir, hippo, crocodile.
  if (sp.snout) {
    L.spine(
      [[0, hy - by * 0.05, hz + bz * 0.45], [0, hy - by * 0.14, hz + bz * 0.95]],
      [by * 0.30, by * 0.20],
      { col: c, colBelly: pale, limb: 5, pivot: headPivot, seg: 7 }
    );
  }
  if (sp.bigEars) {
    for (const s of [-1, 1]) {
      L.blade(
        [[s * bx * 0.34, hy + by * 0.15, hz - by * 0.05], [s * bx * 1.15, hy + by * 0.05, hz - by * 0.75]],
        [by * 0.45, by * 0.62],
        { col: mul(c, 0.85), limb: 5, pivot: headPivot, sy: 0.10, seg: 5 }
      );
    }
  }
  if (sp.shell) {
    L.spine(
      [[0, yB + by * 0.2, -bz * 0.7], [0, yB + by * 0.55, 0], [0, yB + by * 0.2, bz * 0.6]],
      [bz * 0.72, bz * 0.95, bz * 0.7],
      { col: mul(c, 0.7), sx: 1.15, sy: 0.55, seg: 8 }
    );
  }
  if (!sp.trunk && !sp.bigEars) {
    // Almost everything has ears; rabbits get tall ones.
    const eh = sp.ears ? by * 1.5 : by * 0.55;
    for (const s of [-1, 1]) {
      L.blade(
        [[s * bx * 0.35, hy + by * 0.3, hz], [s * bx * (0.45 + (sp.ears ? 0.1 : 0.12)), hy + by * 0.3 + eh, hz - by * 0.1]],
        [by * 0.16, by * (sp.ears ? 0.22 : 0.13)],
        { col: c, limb: 5, pivot: headPivot, sy: 0.3 }
      );
    }
  }
  if (sp.antlers) {
    for (const s of [-1, 1]) {
      const ax = s * bx * 0.3;
      const beam = [
        [ax, hy + by * 0.35, hz],
        [ax + s * bx * 0.45, hy + by * 1.1, hz - by * 0.25],
        [ax + s * bx * 0.8, hy + by * 1.8, hz - by * 0.1],
      ];
      L.spine(beam, [by * 0.09, by * 0.075, by * 0.05], { col: pale, limb: 5, pivot: headPivot, seg: 5 });
      L.spine(
        [beam[1], [beam[1][0] + s * bx * 0.1, beam[1][1] + by * 0.6, beam[1][2] + by * 0.45]],
        [by * 0.06, by * 0.035],
        { col: pale, limb: 5, pivot: headPivot, seg: 5 }
      );
    }
  }
  if (sp.horns) {
    for (const s of [-1, 1]) {
      L.spine(
        [[s * bx * 0.32, hy + by * 0.3, hz], [s * bx * 0.5, hy + by * 0.85, hz - by * 0.35], [s * bx * 0.55, hy + by * 1.0, hz - by * 0.7]],
        [by * 0.12, by * 0.08, by * 0.03],
        { col: mul(pale, 0.9), limb: 5, pivot: headPivot, seg: 5 }
      );
    }
  }
  if (sp.tusks) {
    for (const s of [-1, 1]) {
      L.spine(
        [[s * bx * 0.26, hy - by * 0.22, hz + bz * 0.34], [s * bx * 0.36, hy + by * 0.05, hz + bz * 0.44]],
        [by * 0.06, by * 0.025],
        { col: [0.85, 0.83, 0.76], limb: 5, pivot: headPivot, seg: 4 }
      );
    }
  }

  // Tail.
  const tailPivot = [0, yB, -bz];
  if (sp.longTail) {
    L.spine(
      [[0, yB + by * 0.35, -bz * 0.95], [0, yB + by * 0.3, -bz * 1.9],
       [0, yB + by * 0.15, -bz * 2.7], [0, yB + by * 0.05, -bz * 3.2]],
      [by * 0.26, by * 0.19, by * 0.12, by * 0.05],
      { col: c, colBelly: pale, limb: 6, pivot: tailPivot, seg: 6 }
    );
  } else if (sp.bushyTail) {
    L.spine(
      [[0, yB + by * 0.3, -bz * 0.95], [0, yB + by * 0.34, -bz * 1.5], [0, yB + by * 0.16, -bz * 1.95]],
      [by * 0.22, by * 0.38, by * 0.16],
      { col: c, colBelly: pale, limb: 6, pivot: tailPivot, seg: 7 }
    );
    L.ball(0, yB + by * 0.1, -bz * 2.05, by * 0.17, pale, { limb: 6, pivot: tailPivot });
  } else {
    L.spine(
      [[0, yB + by * 0.42, -bz * 0.95], [0, yB + by * 0.25, -bz * 1.3]],
      [by * 0.14, by * 0.06],
      { col: dark, limb: 6, pivot: tailPivot, seg: 5 }
    );
  }

  // Flippered species have no legs to speak of: four short paddles instead.
  if (sp.flippers) {
    let fid = 1;
    for (const sz of [1, -1]) {
      for (const sx2 of [-1, 1]) {
        const hip = [sx2 * bx * 0.7, legY + by * 0.2, sz * bz * 0.5];
        L.blade(
          [hip, [sx2 * bx * 1.7, legY * 0.4, sz * bz * 0.5 - bz * 0.15]],
          [by * 0.3, by * 0.14],
          { col: mul(c, 0.85), limb: fid, pivot: hip, sy: 0.22, seg: 5 }
        );
        fid++;
      }
    }
    return;
  }

  // Legs: two segments; the shader swings 1-4 from the hip and folds 9-12 at
  // the knee. Hooves darker.
  const lx = bx * 0.62;
  const lz = bz * 0.58;
  let id = 1;
  for (const sz of [1, -1]) {
    for (const sx2 of [-1, 1]) {
      const hip = [sx2 * lx, legY + by * 0.25, sz * lz];
      const knee = [sx2 * lx, legY * 0.48, sz * lz * 1.02];
      L.spine(
        [[hip[0], legY + by * 0.3, hip[2]], [knee[0], knee[1], knee[2]]],
        [bx * 0.3, bx * 0.16],
        { col: c, limb: id, pivot: hip, seg: 6, capStart: false }
      );
      L.spine(
        [[knee[0], knee[1] + 0.01, knee[2]], [knee[0], legY * 0.08, knee[2] - lz * 0.04]],
        [bx * 0.15, bx * 0.11],
        { col: mul(c, 0.8), limb: id + 8, pivot: hip, pivot2: knee, seg: 5, capStart: false }
      );
      L.spine(
        [[knee[0], legY * 0.09, knee[2] - lz * 0.04], [knee[0], 0.005, knee[2] + lz * 0.02]],
        [bx * 0.13, bx * 0.12],
        { col: mul(c, 0.35), limb: id + 8, pivot: hip, pivot2: knee, seg: 5, capStart: false }
      );
      id++;
    }
  }
}

function bird(L, sp) {
  const [bx, by, bz] = sp.body;
  const c = sp.col;
  const pale = mul(c, 1.6, 0.08);
  const dark = mul(c, 0.5);

  L.spine(
    [[0, -by * 0.1, -bz * 0.9], [0, 0, -bz * 0.2], [0, by * 0.08, bz * 0.55], [0, by * 0.05, bz * 0.95]],
    [by * 0.35, by * 0.95, by * 0.75, by * 0.4],
    { col: c, colBelly: pale, sx: bx / by, seg: 8 }
  );
  // Head + beak.
  const hp = [0, 0, bz];
  L.ball(0, by * 0.35, bz * 1.15, by * 0.55, c, { limb: 5, pivot: hp, seg: 7 });
  L.spine(
    [[0, by * 0.3, bz * 1.5], [0, by * 0.22, bz * 1.9]],
    [by * 0.18, by * 0.03],
    { col: sp.key === 'raptor' ? [0.2, 0.16, 0.08] : [0.75, 0.55, 0.18], limb: 5, pivot: hp, seg: 5 }
  );
  for (const s of [-1, 1]) {
    L.ball(s * bx * 0.5, by * 0.5, bz * 1.15, by * 0.11, [0.02, 0.02, 0.025], { limb: 5, pivot: hp });
  }
  // Tail fan.
  L.blade(
    [[0, 0, -bz * 0.9], [0, by * 0.1, -bz * 1.6]],
    [by * 0.3, bx * 1.1],
    { col: dark, limb: 6, pivot: [0, 0, -bz], sy: 0.16 }
  );
  // Wings: long tapered blades with a gentle back-sweep.
  const w = sp.wings;
  for (const s of [-1, 1]) {
    const wp = [0, by * 0.35, 0];
    L.blade(
      [
        [s * bx * 0.4, by * 0.35, bz * 0.15],
        [s * w * 0.55, by * 0.45, -bz * 0.05],
        [s * w * 1.1, by * 0.4, -bz * 0.38],
      ],
      [bz * 0.42, bz * 0.5, bz * 0.16],
      { col: sp.key === 'butterfly' ? pale : dark, colBelly: sp.key === 'butterfly' ? pale : mul(c, 1.2, 0.04), limb: s < 0 ? 8 : 7, pivot: wp, sy: 0.12, seg: 6 }
    );
  }
}

function swimmer(L, sp) {
  const [bx, by, bz] = sp.body;
  const c = sp.col;
  const pale = mul(c, 1.7, 0.09);
  const dark = mul(c, 0.6);

  L.spine(
    [[0, 0, -bz * 0.95], [0, by * 0.05, -bz * 0.35], [0, by * 0.08, bz * 0.25], [0, 0, bz * 0.8], [0, -by * 0.05, bz * 1.0]],
    [by * 0.3, by * 0.85, by * 1.0, by * 0.6, by * 0.28],
    { col: c, colBelly: pale, sx: bx / by, seg: 8 }
  );
  // Tail fluke: whales horizontal, fish vertical.
  const tp = [0, 0, -bz];
  const horizontal = sp.key === 'whale';
  L.blade(
    [[0, 0, -bz * 1.0], [0, by * 0.1, -bz * 1.5]],
    [by * 0.25, by * 1.1],
    { col: dark, limb: 6, pivot: tp, sy: horizontal ? 0.18 : 1.6, sx: horizontal ? 1.6 : 0.18, seg: 6 }
  );
  if (sp.fins) {
    for (const s of [-1, 1]) {
      L.blade(
        [[s * bx * 0.8, -by * 0.15, bz * 0.25], [s * bx * 2.0, -by * 0.45, bz * 0.05]],
        [by * 0.3, by * 0.12],
        { col: dark, limb: s < 0 ? 8 : 7, pivot: [0, 0, 0], sy: 0.2, seg: 5 }
      );
    }
    L.blade(
      [[0, by * 0.8, -bz * 0.1], [0, by * 1.35, -bz * 0.45]],
      [bz * 0.28, bz * 0.1],
      { col: dark, limb: 0, sy: 0.16, seg: 5 }
    );
  }
  if (sp.key === 'fish') {
    for (const s of [-1, 1]) {
      L.ball(s * bx * 0.72, by * 0.28, bz * 0.62, by * 0.13, [0.03, 0.03, 0.04], {});
    }
  }
}

/**
 * A two-legged standing body: penguin, ostrich, kangaroo. Same rig, but the
 * torso is vertical and only limbs 1 and 3 exist, which the shader already
 * swings in antiphase - so it walks without a single line of new shader.
 */
function biped(L, sp) {
  const [bx, by, bz] = sp.body;
  const legY = sp.legs;
  const c = sp.col;
  const pale = sp.belly || mul(c, 1.6, 0.08);
  const yB = legY;

  // Upright torso: tall, egg-shaped, pale down the front.
  L.spine(
    [[0, yB, 0], [0, yB + by * 0.9, 0], [0, yB + by * 1.7, 0]],
    [by * 0.72, by * 1.0, by * 0.62],
    { col: c, colBelly: pale, sx: bx / by, seg: 9 }
  );
  // Countershading runs down the front of a standing bird, not underneath it,
  // so the belly panel is a separate slab rather than a normal-driven blend.
  L.spine(
    [[0, yB + by * 0.2, bz * 0.42], [0, yB + by * 1.3, bz * 0.36]],
    [by * 0.5, by * 0.34],
    { col: pale, sx: (bx / by) * 0.8, sy: 0.34, seg: 7 }
  );

  const headPivot = [0, yB + by * 1.7, 0];
  const nTop = [0, yB + by * 1.7 + sp.neck, bz * 0.12];
  L.spine(
    [[0, yB + by * 1.6, 0], [0, yB + by * 1.7 + sp.neck * 0.55, bz * 0.06], nTop],
    [by * 0.38, by * 0.26, by * 0.24],
    { col: c, limb: 5, pivot: headPivot, seg: 7 }
  );
  L.ball(0, nTop[1] + by * 0.18, nTop[2], by * 0.34, c, { limb: 5, pivot: headPivot, seg: 7 });
  L.spine(
    [[0, nTop[1] + by * 0.14, nTop[2] + by * 0.3], [0, nTop[1] + by * 0.08, nTop[2] + by * 0.8]],
    [by * 0.14, by * 0.03],
    { col: [0.72, 0.56, 0.20], limb: 5, pivot: headPivot, seg: 5 }
  );
  for (const s of [-1, 1]) {
    L.ball(s * bx * 0.4, nTop[1] + by * 0.26, nTop[2] + by * 0.18, by * 0.09, [0.02, 0.02, 0.025],
      { limb: 5, pivot: headPivot });
  }

  // Stubby arms or flippers, hung off the wing limbs so they beat gently.
  for (const s of [-1, 1]) {
    const wp = [s * bx * 0.7, yB + by * 1.2, 0];
    L.blade(
      [wp, [s * bx * 1.05, yB + by * 0.35, -bz * 0.1]],
      [by * 0.34, by * 0.14],
      { col: mul(c, 0.8), limb: s < 0 ? 8 : 7, pivot: wp, sy: 0.16, seg: 5 }
    );
  }

  if (sp.longTail) {
    const tp = [0, yB, -bz * 0.3];
    L.spine(
      [[0, yB + by * 0.1, -bz * 0.4], [0, yB * 0.5, -bz * 1.6], [0, yB * 0.15, -bz * 2.6]],
      [by * 0.34, by * 0.22, by * 0.08],
      { col: c, colBelly: pale, limb: 6, pivot: tp, seg: 6 }
    );
  }

  // Two legs, ids 1 and 3 so the shader swings them in antiphase.
  for (const [id, sx2] of [[1, -1], [3, 1]]) {
    const hip = [sx2 * bx * 0.5, legY, 0];
    const knee = [sx2 * bx * 0.5, legY * 0.45, 0];
    L.spine([hip, knee], [bx * 0.26, bx * 0.15],
      { col: c, limb: id, pivot: hip, seg: 6, capStart: false });
    L.spine([[knee[0], knee[1], knee[2]], [knee[0], legY * 0.06, knee[2] + bz * 0.05]],
      [bx * 0.14, bx * 0.11],
      { col: mul(c, 0.7), limb: id + 8, pivot: hip, pivot2: knee, seg: 5, capStart: false });
    L.spine([[knee[0], legY * 0.07, knee[2] + bz * 0.05], [knee[0], 0.005, knee[2] + bz * 0.3]],
      [bx * 0.12, bx * 0.10],
      { col: mul(c, 0.5), limb: id + 8, pivot: hip, pivot2: knee, seg: 4, capStart: false });
  }
}

export function buildAnimal(sp) {
  const L = new SmoothLimbs();
  if (sp.gait === 2) swimmer(L, sp); // GAIT.SWIM
  else if (sp.gait === 1) bird(L, sp); // GAIT.FLY
  else if (sp.upright) biped(L, sp);
  else quadruped(L, sp);
  return L.geometry();
}

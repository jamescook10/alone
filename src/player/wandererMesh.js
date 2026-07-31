// The wanderer's body, built here rather than imported.
//
// The baked GLB is now animation data and nothing else: a skeleton and seven
// clips. Everything you can see is generated from the same swept spines the
// animals are made of, in the same flat-shaded solid colours, so the one
// person in this world is made of the world's own material language. Before
// this, the player was the only textured, smooth-shaded, four-heads-tall
// object left after the low-poly restyle, and it showed.
//
// Two things happen in here:
//
//   reproportion()  moves every joint to where it belongs on a 1.80 m adult
//                   and remaps the clips to match.
//   buildBody()     grows a hooded traveller around the result and skins it.

import * as THREE from 'three';
import { SmoothLimbs } from '../world/animalMeshes.js';

/* ============================================================ proportions */

// Where each joint belongs on a 1.80 m adult, in metres, in the bind pose.
// The source rig is KayKit's Rogue: its hips sit at 36% of its height where
// a human's sit at 52%, and that single number - with head size, which is
// ours to choose now - is the whole "chibi" read. Its arms were already very
// nearly human and barely move here.
//
// This is safe to do because a rotation track does not care where its joint
// is: the pose survives being moved. Only the handful of position tracks
// need remapping, which is what retargetClips does.
const CENTRE = {
  hips: [0, 0.955, 0],
  spine: [0, 1.108, 0],
  chest: [0, 1.296, 0],
  head: [0, 1.548, 0], // the atlas joint, 86% of height; the crown lands at 1.80
};
// Left side; the right is mirrored. Thigh 0.42 m, shin 0.44 m, upper arm
// 0.30 m, forearm 0.27 m - and a 1.86 m fingertip span, which is what a
// 1.80 m human actually has.
const SIDE = {
  upperleg: [0.090, 0.936, 0],
  lowerleg: [0.090, 0.513, 0.010],
  foot: [0.090, 0.078, -0.024],
  toes: [0.090, 0.032, 0.143],
  upperarm: [0.190, 1.452, 0],
  lowerarm: [0.490, 1.452, -0.017],
  wrist: [0.755, 1.452, 0],
  hand: [0.840, 1.452, 0],
};

// The rig names its bones "upperleg.l", but three.js strips dots, brackets
// and colons out of node names as it loads them, because those are the
// separators its own animation-track paths are built from. Everything in
// here is keyed through norm() so both spellings land in the same place -
// silently missing the limb bones leaves the legs at their original length
// and nothing anywhere reports a problem.
export const norm = (n) => n.replace(/[[\].:/\s]/g, '');

export const BIND = (() => {
  const b = {};
  for (const [n, v] of Object.entries(CENTRE)) b[norm(n)] = v;
  for (const [n, v] of Object.entries(SIDE)) {
    b[norm(n + '.l')] = v;
    b[norm(n + '.r')] = [-v[0], v[1], v[2]];
  }
  return b;
})();

const V = new THREE.Vector3();
const M = new THREE.Matrix4();

/**
 * Rewrite the rest pose to BIND. Returns what retargetClips needs to move
 * the position tracks with it.
 */
export function reproportion(root) {
  root.updateMatrixWorld(true);

  const oldRest = new Map();
  const oldWorld = new Map();
  root.traverse((o) => {
    if (!o.isBone) return;
    oldRest.set(norm(o.name), o.position.clone());
    oldWorld.set(norm(o.name), new THREE.Vector3().setFromMatrixPosition(o.matrixWorld));
  });

  // The source rig is authored in its own units. Derive the conversion from
  // the head joint rather than hard-coding it, so this keeps working if the
  // pack is ever re-baked at a different scale.
  const oldHead = oldWorld.get('head');
  const scale = oldHead && oldHead.y > 1e-4 ? BIND.head[1] / oldHead.y : 1;

  // How much longer the legs got. The hips' own position track has to move
  // by the same factor or the feet stop reaching the floor the clips were
  // authored against - the leg triangle only stays consistent if the joint
  // it hangs from scales with it.
  const oHip = oldWorld.get(norm('upperleg.l'));
  const oFoot = oldWorld.get(norm('foot.l'));
  const legOld = oHip && oFoot ? (oHip.y - oFoot.y) * scale : 0;
  const legNew = BIND[norm('upperleg.l')][1] - BIND[norm('foot.l')][1];
  const legK = legOld > 1e-4 ? legNew / legOld : 1;

  // Parent first, so each joint is placed against a parent already moved.
  const visit = (o) => {
    const t = BIND[norm(o.name)];
    if (t && o.parent) {
      M.copy(o.parent.matrixWorld).invert();
      o.position.copy(V.set(t[0], t[1], t[2]).applyMatrix4(M));
      o.updateMatrixWorld(true);
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  root.updateMatrixWorld(true);

  return { oldRest, scale, legK };
}

/**
 * Move the position tracks onto the new skeleton. A track's deviation from
 * its own rest value is the animation; the rest value itself has changed
 * underneath it, so replay the deviation from the new rest instead.
 */
export function retargetClips(clips, root, fit) {
  const bones = new Map();
  root.traverse((o) => {
    if (o.isBone) bones.set(norm(o.name), o);
  });

  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position')) continue;
      const name = norm(track.name.slice(0, -'.position'.length));
      const bone = bones.get(name);
      const rest = fit.oldRest.get(name);
      if (!bone || !rest) continue;

      // Only the vertical carriers stretch with the legs. A joint offset
      // that wobbles - a hip rolling forward, a shoulder shrugging - is a
      // distance in its own right and is only converted to metres, or the
      // sit clips throw the hips a quarter of a metre sideways.
      const k = fit.scale * (name === 'hips' || name === 'root' ? fit.legK : 1);
      const o = [rest.x, rest.y, rest.z];
      const n = [bone.position.x, bone.position.y, bone.position.z];
      const v = track.values;
      for (let i = 0; i < v.length; i += 3) {
        for (let c = 0; c < 3; c++) v[i + c] = n[c] + (v[i + c] - o[c]) * k;
      }
    }
  }
}

/* ================================================================ skinning */

// Which two joints each bone's flesh lies between. Leaves get a stub in the
// direction their limb continues, so a hand or the top of the skull still
// has something to be near.
const SEGMENTS = {};
const seg = (name, from, to, stub) => {
  SEGMENTS[norm(name)] = [norm(from), to ? norm(to) : null, stub];
};
seg('hips', 'hips', 'spine');
seg('spine', 'spine', 'chest');
seg('chest', 'chest', 'head');
seg('head', 'head', null, [0, 0.26, 0]);
for (const s of ['l', 'r']) {
  const x = s === 'l' ? 1 : -1;
  seg(`upperleg.${s}`, `upperleg.${s}`, `lowerleg.${s}`);
  seg(`lowerleg.${s}`, `lowerleg.${s}`, `foot.${s}`);
  seg(`foot.${s}`, `foot.${s}`, `toes.${s}`);
  seg(`toes.${s}`, `toes.${s}`, null, [0, -0.01, 0.07]);
  seg(`upperarm.${s}`, `upperarm.${s}`, `lowerarm.${s}`);
  seg(`lowerarm.${s}`, `lowerarm.${s}`, `wrist.${s}`);
  seg(`wrist.${s}`, `wrist.${s}`, `hand.${s}`);
  seg(`hand.${s}`, `hand.${s}`, null, [x * 0.09, 0, 0]);
}

function distToSegment(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Builds one merged skinned geometry out of parts, each part weighted only
 * against the bones it is allowed to follow.
 *
 * The mask is the whole trick. Weighting by proximity alone is what makes a
 * coat hem tear itself in half between two swinging legs; telling the skirt
 * it belongs to the pelvis and nothing else costs one array per part and
 * removes the problem entirely.
 */
class Skinner {
  constructor(boneIndex, joints) {
    this.boneIndex = boneIndex; // name -> index into skeleton.bones
    this.joints = joints; // name -> Vector3, bind pose
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
  }

  _segment(name) {
    const key = norm(name);
    const s = SEGMENTS[key];
    const a = s && this.joints.get(s[0]);
    const i = this.boneIndex.get(key);
    if (!a || i === undefined) throw new Error('wanderer: no bone named ' + name);
    const b = s[1] ? this.joints.get(s[1]) : new THREE.Vector3(a.x + s[2][0], a.y + s[2][1], a.z + s[2][2]);
    return { a, b: b || a, i };
  }

  /** Append a part. `bones` is the mask; `sharp` how tightly it clings. */
  part(bones, build, sharp = 3) {
    const L = new SmoothLimbs();
    build(L);
    const base = this.pos.length / 3;
    const segs = bones.map((n) => this._segment(n));
    const n = L.pos.length / 3;
    const w = [];

    for (let v = 0; v < n; v++) {
      const px = L.pos[v * 3], py = L.pos[v * 3 + 1], pz = L.pos[v * 3 + 2];
      w.length = 0;
      for (const s of segs) {
        // The 35 mm floor stops a vertex sitting exactly on a joint from
        // taking all of the weight and shearing away from its neighbours.
        const d = distToSegment(px, py, pz, s.a, s.b) + 0.035;
        w.push({ i: s.i, v: 1 / Math.pow(d, sharp) });
      }
      w.sort((a, b) => b.v - a.v);
      let total = 0;
      for (let k = 0; k < 4; k++) total += k < w.length ? w[k].v : 0;
      for (let k = 0; k < 4; k++) {
        this.si.push(k < w.length ? w[k].i : 0);
        this.sw.push(k < w.length ? w[k].v / total : 0);
      }
    }

    for (let i = 0; i < L.pos.length; i++) this.pos.push(L.pos[i]);
    for (let i = 0; i < L.norm.length; i++) this.norm.push(L.norm[i]);
    for (let i = 0; i < L.col.length; i++) this.col.push(L.col[i]);
    for (let i = 0; i < L.idx.length; i++) this.idx.push(L.idx[i] + base);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ================================================================= the body */

// Reflectances, not display colours - the same scale the animals and the
// ground use. A traveller who lives outside: waxed cloth gone grey-green,
// leather that has been wet a hundred times.
const COAT = [0.128, 0.140, 0.116];
const COAT_DARK = [0.098, 0.108, 0.090];
const BELT = [0.062, 0.050, 0.040];
const TROUSER = [0.100, 0.093, 0.080];
const BOOT = [0.055, 0.046, 0.038];
const SKIN = [0.300, 0.215, 0.155];
const SHADOW = [0.022, 0.021, 0.020]; // inside the hood
const SATCHEL = [0.150, 0.115, 0.078];

export function buildBody(skeleton) {
  const boneIndex = new Map();
  const joints = new Map();
  skeleton.bones.forEach((b, i) => {
    boneIndex.set(norm(b.name), i);
    joints.set(norm(b.name), new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
  });

  const S = new Skinner(boneIndex, joints);

  /* --- the trunk ---------------------------------------------------- */

  // Pelvis and torso in one sweep: narrow waist, deep chest, shoulders wide
  // enough that the sleeves emerge from something. sy squashes it front to
  // back, because a person seen from the side is not a cylinder.
  S.part(['hips', 'spine', 'chest'], (L) => {
    L.spine(
      [[0, 0.885, 0], [0, 1.010, 0.012], [0, 1.150, 0.016], [0, 1.300, 0.008], [0, 1.448, -0.010]],
      [0.128, 0.126, 0.132, 0.152, 0.150],
      { col: COAT, sx: 1.30, sy: 0.85, seg: 10 }
    );
  });

  // The belt: one short band of darker, slightly fatter spine at the waist.
  S.part(['hips', 'spine'], (L) => {
    L.spine([[0, 1.020, 0.012], [0, 1.060, 0.014]], [0.134, 0.134], { col: BELT, sx: 1.30, sy: 0.86, seg: 10 });
  });

  // The coat skirt, flaring to just above the knee. Masked to the pelvis and
  // lower spine so it swings as one piece; a hem that follows the legs is a
  // hem that tears open at every stride.
  S.part(['hips', 'spine'], (L) => {
    L.spine(
      [[0, 1.055, 0.010], [0, 0.900, 0.006], [0, 0.760, 0.002], [0, 0.655, 0]],
      [0.148, 0.196, 0.232, 0.246],
      { col: COAT, colBelly: COAT_DARK, sx: 1.22, sy: 0.98, seg: 12, capEnd: false }
    );
  });

  // A satchel on the right hip, tucked under the cloak's open side. Squashed
  // against the body rather than flattened into a blade - a hard sx on a
  // seven-sided ring reads as a shard, not a bag.
  S.part(['hips'], (L) => {
    L.spine([[-0.185, 0.965, -0.055], [-0.208, 0.900, -0.048]], [0.070, 0.078], { col: SATCHEL, sx: 0.80, sy: 1.05, seg: 9 });
    L.spine([[-0.150, 1.050, -0.030], [-0.196, 0.945, -0.048]], [0.018, 0.016], { col: BELT, seg: 5 });
  });

  /* --- the hood ------------------------------------------------------ */

  // The cowl belongs to the chest, the hood to the head. Splitting them
  // there is what lets the hood turn to follow the eyes without the collar
  // peeling off the shoulders with it.
  S.part(['chest'], (L) => {
    L.spine([[0, 1.398, -0.006], [0, 1.492, -0.004]], [0.140, 0.118], { col: COAT_DARK, sx: 1.18, sy: 1.0, seg: 10 });
  });

  S.part(['head'], (L) => {
    // The skull under the cloth, and then the cloth over it.
    L.spine([[0, 1.520, 0], [0, 1.610, 0.006], [0, 1.700, 0]], [0.078, 0.090, 0.078], { col: SHADOW, seg: 8 });
    L.spine(
      [[0, 1.505, -0.010], [0, 1.605, 0.002], [0, 1.705, -0.004], [0, 1.785, -0.030]],
      [0.132, 0.148, 0.138, 0.088],
      { col: COAT, colBelly: COAT_DARK, sx: 1.0, sy: 1.0, seg: 10 }
    );
    // The point of the hood, hanging back off the crown.
    L.spine([[0, 1.740, -0.090], [0, 1.660, -0.170], [0, 1.590, -0.205]], [0.062, 0.040, 0.022], { col: COAT_DARK, seg: 7 });
    // The opening, and the dark inside it. The face is a suggestion: a jaw
    // and the bridge of a nose catching light, nothing more. At four metres
    // - which is as close as the camera ever gets - anything more detailed
    // is noise, and this world is not one you look someone in the eye in.
    L.spine([[0, 1.560, 0.092], [0, 1.600, 0.106], [0, 1.648, 0.096]], [0.086, 0.092, 0.082], { col: SHADOW, sx: 0.92, seg: 9 });
    L.spine([[0, 1.545, 0.070], [0, 1.575, 0.092]], [0.044, 0.036], { col: SKIN, sx: 1.05, seg: 7 });
  });

  /* --- limbs ---------------------------------------------------------- */

  for (const s of ['l', 'r']) {
    const x = s === 'l' ? 1 : -1;

    // Sleeve. The mask keeps it off the torso, which is 0.19 m away at the
    // shoulder and would otherwise drag the armpit out sideways.
    S.part(['upperarm.' + s, 'lowerarm.' + s, 'wrist.' + s], (L) => {
      L.spine(
        [[x * 0.175, 1.452, 0], [x * 0.340, 1.452, -0.006], [x * 0.490, 1.452, -0.017], [x * 0.640, 1.452, -0.010], [x * 0.760, 1.452, 0]],
        [0.072, 0.060, 0.055, 0.047, 0.042],
        { col: COAT, colBelly: COAT_DARK, seg: 8 }
      );
    });

    S.part(['hand.' + s, 'wrist.' + s], (L) => {
      L.spine([[x * 0.790, 1.452, 0], [x * 0.860, 1.450, 0.004]], [0.044, 0.038], { col: SKIN, sx: 1.0, sy: 1.25, seg: 7 });
    });

    // Trousers. Thigh into calf into ankle; the coat covers the top third,
    // so the profile only has to be right from the knee down.
    S.part(['upperleg.' + s, 'lowerleg.' + s], (L) => {
      L.spine(
        [[x * 0.090, 0.940, 0], [x * 0.090, 0.720, 0.004], [x * 0.090, 0.513, 0.010], [x * 0.088, 0.290, 0.002], [x * 0.086, 0.115, -0.008]],
        [0.088, 0.078, 0.068, 0.062, 0.053],
        { col: TROUSER, colBelly: COAT_DARK, seg: 8 }
      );
    });

    S.part(['foot.' + s, 'toes.' + s], (L) => {
      L.spine(
        [[x * 0.086, 0.150, -0.020], [x * 0.088, 0.062, -0.028], [x * 0.090, 0.036, 0.040], [x * 0.090, 0.030, 0.140]],
        [0.062, 0.062, 0.058, 0.044],
        { col: BOOT, seg: 7 }
      );
    });
  }

  return S.geometry();
}

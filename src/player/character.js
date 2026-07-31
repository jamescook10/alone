// The body you are.
//
// The baked KayKit pack (CC0, see public/assets/character/LICENSE.md) is now
// animation data and nothing else - a skeleton and seven clips. The body
// hung on it is grown in code from the same swept spines as the animals, in
// the same flat-shaded solid colours as everything else, because after the
// low-poly restyle the player was the only textured, smooth-shaded,
// four-heads-tall object left in the world and it read as a sticker.
//
// See wandererMesh.js for the skeleton surgery and the body, cloak.js for
// the cloth. If the baked asset fails to load, the older hand-posed body
// below steps in, so the game still runs offline exactly like the trees do.
//
// Both bodies speak the same small interface the camera rig relies on:
// update(dt, player) · setOpacity(o) · facing · dispose().

import * as THREE from 'three';
import { clamp, lerp } from '../core/noise.js';
import { SmoothLimbs } from '../world/animalMeshes.js';
import { makeSolidMaterial } from '../gfx/materials.js';
import { assets } from '../gfx/assets.js';
import { reproportion, retargetClips, buildBody, norm } from './wandererMesh.js';
import { Cloak } from './cloak.js';

const HEIGHT = 1.80; // the procedural fallback is normalised to this
const E_LOOK = new THREE.Euler();
const Q_LOOK = new THREE.Quaternion();
const Q_ROOT = new THREE.Quaternion();
const Q_PAR = new THREE.Quaternion();
const Q_INV = new THREE.Quaternion();
const Q_AX = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// The clips came off a combat character. Its idle holds the arms out from
// the body with the elbows up, ready to draw a knife, and it stands with its
// feet half a metre apart - which reads as a stance on a body four heads
// tall and as carrying two invisible buckets on one that is seven and a
// half. A rotation track transfers exactly, so this is not something the
// re-proportioning could have fixed: the pose is faithful, it is just the
// wrong pose for someone out here to walk nowhere in particular.
//
// Bias the shoulders down and the stance in, about the body's own front-to-
// back axis, after the mixer has posed everything. The swing in the clips
// survives; only where it swings from moves.
const POSE_BIAS = [['upperarm.l', -0.74], ['upperarm.r', 0.74], ['upperleg.l', -0.12], ['upperleg.r', 0.12]];

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function createCharacter(scene) {
  if (assets.character) {
    try {
      return new WandererCharacter(scene);
    } catch (e) {
      // The body is built against bones it expects by name. If a re-bake
      // ever renames or drops one, say so and stand up the hand-posed body
      // rather than leaving the player with no body at all.
      console.warn('wanderer body failed, using the hand-posed one:', e.message, e.stack);
    }
  }
  return new ProceduralCharacter(scene);
}

/**
 * Which way is the body pointing? Toward travel when moving, toward the
 * chosen view when sitting, toward the gaze while the camera is inside the
 * head - and otherwise it just stays where it was left.
 */
function easeFacing(self, dt, p) {
  let target = self.facing;
  const hs = Math.hypot(p.velocity.x, p.velocity.z);
  if (p.sitting && p.sitYaw !== null) target = p.sitYaw;
  else if (hs > 0.55 && !p.swimming && !p.drifting) target = Math.atan2(-p.velocity.x, -p.velocity.z);
  else if (p.rig && (p.rig.blend > 0.02 || p.rig.mode === 'in')) target = p.yaw;
  self.facing += wrapAngle(target - self.facing) * (1 - Math.exp(-dt * (hs > 0.55 ? 8 : 4)));
}

/* ===================================================== the wanderer's body */

class WandererCharacter {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.model = assets.character.scene;
    this.opacity = 1;
    this.facing = 0;
    this.state = 'loco';
    this._airT = 0;
    this._wasVisible = false;

    // The rig arrives at its own scale and its own proportions; put every
    // joint where it belongs on a 1.80 m adult and carry the clips across.
    // Do this before anything reads a bone matrix.
    this.model.position.set(0, 0, 0);
    this.model.scale.setScalar(1);
    this.model.quaternion.identity();
    const fit = reproportion(this.model);
    retargetClips(assets.character.clips, this.model, fit);

    // The source mesh is dropped on the floor here as well as at bake time,
    // so this works against an un-stripped pack too.
    const dead = [];
    const bones = [];
    this.model.traverse((o) => {
      if (o.isBone) bones.push(o);
      else if (o.isMesh) dead.push(o);
    });
    for (const o of dead) {
      o.removeFromParent();
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
    this.headBone = this.model.getObjectByName('head') || bones.find((b) => /^head/i.test(b.name)) || null;
    const byName = new Map(bones.map((b) => [norm(b.name), b]));
    this.bias = POSE_BIAS
      .map(([n, angle]) => ({ bone: byName.get(norm(n)), angle, clean: new THREE.Quaternion(), has: false }))
      .filter((b) => b.bone);

    this.root.add(this.model);
    this.root.updateMatrixWorld(true);

    const skeleton = new THREE.Skeleton(bones);
    this.material = makeSolidMaterial({ key: 'char', roughness: 0.9 });
    this.material.transparent = true;
    this.body = new THREE.SkinnedMesh(buildBody(skeleton), this.material);
    this.body.castShadow = true;
    // Skinned bounds do not follow the pose; the body is one object and
    // always near the camera, so culling it buys nothing and can pop.
    this.body.frustumCulled = false;
    this.root.add(this.body);
    // Bound at the origin, so the bind matrix is identity and the group is
    // free to be moved and turned underneath it.
    this.body.bind(skeleton, new THREE.Matrix4());

    // The cloak is simulated in world space - that is where its inertia
    // lives - so it hangs off the scene, not off the group that moves.
    this.chestBone = this.model.getObjectByName('chest') || this.headBone;
    this.cloak = new Cloak(this.chestBone);
    scene.add(this.cloak.mesh);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of assets.character.clips) this.actions[clip.name] = this.mixer.clipAction(clip);
    this.current = null;
    this._headClean = new THREE.Quaternion();
    this._headHasClean = false;
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._play('Idle');
    scene.add(this.root);
  }

  _play(name, opts = {}) {
    const a = this.actions[name];
    if (!a || this.current === a) return;
    if (this.current) this.current.fadeOut(opts.fade !== undefined ? opts.fade : 0.25);
    a.reset();
    a.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, opts.once ? 1 : Infinity);
    a.clampWhenFinished = !!opts.once;
    a.fadeIn(opts.fade !== undefined ? opts.fade : 0.25).play();
    this.current = a;
  }

  setOpacity(o) {
    this.opacity = o;
    this.root.visible = o > 0.015;
    this.material.opacity = o;
    // Only actually transparent while fading: a permanently transparent
    // skinned mesh sorts against itself and the cloak shimmers.
    this.material.transparent = o < 0.995;
    this.cloak.setOpacity(o);
  }

  update(dt, p) {
    if (!this.root.visible && p.rig && p.rig.blend > 0.999) {
      // Inside the head: nothing to pose, and nothing to simulate. The cloth
      // is re-hung on the way back out rather than left to catch up from
      // wherever it was when the camera went in.
      this._wasVisible = false;
      return;
    }
    easeFacing(this, dt, p);
    this.root.position.copy(p.position);
    this.root.rotation.y = this.facing + Math.PI;

    const speed = p.speed;
    this._airT = p.onGround ? 0 : this._airT + dt;

    /* --- state ------------------------------------------------------- */
    if (p.sitting) {
      if (this.state !== 'sit-down' && this.state !== 'sit') {
        this._play('Sit_Floor_Down', { once: true, fade: 0.18 });
        this.state = 'sit-down';
      } else if (this.state === 'sit-down' && !this.current.isRunning()) {
        this._play('Sit_Floor_Idle', { fade: 0.3 });
        this.state = 'sit';
      }
    } else if (this.state === 'sit-down' || this.state === 'sit') {
      this._play('Sit_Floor_StandUp', { once: true, fade: 0.15 });
      this.state = 'stand-up';
    } else if (this.state === 'stand-up') {
      // Movement input resumes control instantly; the clip yields to the
      // stride rather than root the feet in place.
      if (!this.current.isRunning() || speed > 1.6) this.state = 'loco';
    }

    if (this.state === 'loco') {
      if (this._airT > 0.22) {
        this._play('Jump_Idle', { fade: 0.2 });
      } else if (speed < 0.3) {
        this._play('Idle', { fade: 0.35 });
      } else if (speed < 5.2) {
        this._play('Walking_A');
        // Feet roughly tracking the ground; the cap hides the cartoon blur
        // a literal match to sprint speed would need.
        this.current.timeScale = clamp(speed / 2.6, 0.7, 1.9);
      } else {
        this._play('Running_A');
        this.current.timeScale = clamp(speed / 6.0, 0.8, 1.6);
      }
    }

    // Undo last frame's head-look BEFORE the mixer runs. The bake strips
    // animation channels that never move, so a clip is not guaranteed to
    // rewrite the head bone each frame - and adding an offset onto a bone
    // nothing resets winds the head round and round on the body.
    if (this.headBone && this._headHasClean) this.headBone.quaternion.copy(this._headClean);
    for (const b of this.bias) if (b.has) b.bone.quaternion.copy(b.clean);

    this.mixer.update(dt);

    // The head follows the eyes, gently: a smoothed offset applied on top
    // of whatever the animation posed, and removed again next frame.
    if (this.headBone) {
      this._headClean.copy(this.headBone.quaternion);
      this._headHasClean = true;
      const k = 1 - Math.exp(-dt * 6);
      this._lookYaw += (clamp(wrapAngle(p.yaw - this.facing), -0.9, 0.9) * 0.45 - this._lookYaw) * k;
      this._lookPitch += (-p.pitch * 0.3 - this._lookPitch) * k;
      E_LOOK.set(this._lookPitch, this._lookYaw, 0, 'YXZ');
      this.headBone.quaternion.multiply(Q_LOOK.setFromEuler(E_LOOK));
    }

    /* --- the cloak ---------------------------------------------------- */

    // The bones have only just been posed and the group has only just been
    // moved; the renderer will not flush either until after this. Do it here
    // or the cloth hangs off where the shoulders were last frame, which at
    // running speed is most of a metre.
    this.root.updateMatrixWorld(true);

    // Shoulders and hips, biased in the body's own frame. Conjugating by the
    // parent's rotation is what makes "down" mean down rather than down the
    // arm, whatever the chest happens to be doing at the time.
    this.root.getWorldQuaternion(Q_ROOT).invert();
    for (const b of this.bias) {
      b.bone.parent.getWorldQuaternion(Q_PAR).premultiply(Q_ROOT);
      Q_INV.copy(Q_PAR).invert();
      Q_AX.setFromAxisAngle(AXIS_Z, b.angle);
      b.clean.copy(b.bone.quaternion);
      b.has = true;
      b.bone.quaternion.premultiply(Q_PAR).premultiply(Q_AX).premultiply(Q_INV);
      b.bone.updateMatrixWorld(true);
    }
    const w = p.world && p.world.weather;
    CLOAK_CTX.chest = this.chestBone;
    CLOAK_CTX.feetY = p.position.y;
    CLOAK_CTX.bodyX = p.position.x;
    CLOAK_CTX.bodyZ = p.position.z;
    CLOAK_CTX.facing = this.facing + Math.PI;
    CLOAK_CTX.wind.x = w ? w.windDir.x : 0;
    CLOAK_CTX.wind.z = w ? w.windDir.y : 0;
    CLOAK_CTX.wind.strength = w ? w.wind : 0;
    if (!this._wasVisible) this.cloak.reseed(this.chestBone);
    this._wasVisible = true;
    this.cloak.update(dt, CLOAK_CTX);
  }

  dispose() {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.body.geometry.dispose();
    this.material.dispose();
    this.cloak.dispose();
  }
}

const CLOAK_CTX = { chest: null, feetY: 0, bodyX: 0, bodyZ: 0, facing: 0, wind: { x: 0, z: 0, strength: 0 } };

/* =============================================== the procedural fallback */

// Albedos, not display colours - same scale the animals use.
const COL_JACKET = [0.155, 0.175, 0.165];
const COL_SLEEVE = [0.135, 0.152, 0.145];
const COL_TROUSER = [0.115, 0.105, 0.092];
const COL_BOOT = [0.055, 0.045, 0.038];
const COL_SKIN = [0.30, 0.215, 0.155];
const COL_HAIR = [0.055, 0.042, 0.034];
const COL_PACK = [0.16, 0.125, 0.085];
const COL_ROLL = [0.19, 0.115, 0.088];

const HIP_Y = 0.96;
const THIGH = 0.45;
const CALF = 0.47;

function part(build) {
  const L = new SmoothLimbs();
  build(L);
  return L.geometry();
}

class ProceduralCharacter {
  constructor(scene) {
    this.mat = makeSolidMaterial({ key: 'char', roughness: 0.88 });
    this.mat.transparent = true;
    this.opacity = 1;

    this.root = new THREE.Group();
    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.06;
    this.hips.add(this.torso);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.50, 0.01);
    this.torso.add(this.head);

    const mk = (geo) => {
      const m = new THREE.Mesh(geo, this.mat);
      m.castShadow = true;
      return m;
    };
    this._meshes = [];
    const add = (parent, geo) => {
      const m = mk(geo);
      parent.add(m);
      this._meshes.push(m);
      return m;
    };

    // Pelvis.
    add(this.hips, part((L) => {
      L.spine([[0, -0.10, 0], [0, 0.04, 0]], [0.145, 0.155], { col: COL_TROUSER, sx: 1.25, seg: 8 });
    }));

    // Torso, with the pack and bedroll of someone who lives outside.
    add(this.torso, part((L) => {
      L.spine(
        [[0, 0.0, 0], [0, 0.18, 0.012], [0, 0.35, 0.016], [0, 0.47, 0.004]],
        [0.145, 0.138, 0.158, 0.148],
        { col: COL_JACKET, sx: 1.3, seg: 10 }
      );
      L.spine([[0, 0.12, -0.155], [0, 0.36, -0.165]], [0.105, 0.095], { col: COL_PACK, sx: 1.15, seg: 7 });
      L.spine([[-0.15, 0.44, -0.155], [0.15, 0.44, -0.155]], [0.052, 0.052], { col: COL_ROLL, seg: 6 });
    }));

    // Head: skin, a mop of hair, a nose. Eyes would be noise at this size.
    add(this.head, part((L) => {
      L.spine([[0, -0.02, 0], [0, 0.075, 0.005]], [0.052, 0.058], { col: COL_SKIN, seg: 7 });
      L.spine(
        [[0, 0.10, 0.005], [0, 0.17, 0.012], [0, 0.235, 0.002]],
        [0.072, 0.090, 0.070],
        { col: COL_SKIN, sx: 0.94, seg: 9 }
      );
      L.spine(
        [[0, 0.125, -0.045], [0, 0.21, -0.028], [0, 0.252, 0.01]],
        [0.082, 0.094, 0.062],
        { col: COL_HAIR, sx: 0.96, seg: 8 }
      );
      L.ball(0, 0.155, 0.098, 0.020, COL_SKIN, {});
    }));

    // Arms: shoulder pivot, elbow pivot.
    this.arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.205, 0.435, 0);
      this.torso.add(shoulder);
      add(shoulder, part((L) => {
        L.spine([[s * 0.01, 0.02, 0], [s * 0.018, -0.28, 0]], [0.056, 0.047], { col: COL_SLEEVE, seg: 7 });
      }));
      const elbow = new THREE.Group();
      elbow.position.set(s * 0.02, -0.30, 0);
      shoulder.add(elbow);
      add(elbow, part((L) => {
        L.spine([[0, 0.01, 0], [0, -0.235, 0]], [0.044, 0.037], { col: COL_SLEEVE, seg: 7 });
        L.ball(0, -0.265, 0.005, 0.040, COL_SKIN, {});
      }));
      this.arms.push({ shoulder, elbow });
    }

    // Legs: hip pivot, knee pivot; the foot rides with the calf.
    this.legs = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.095, -0.02, 0);
      this.hips.add(hip);
      add(hip, part((L) => {
        L.spine([[0, 0.02, 0], [0, -THIGH, 0]], [0.083, 0.060], { col: COL_TROUSER, seg: 8 });
      }));
      const knee = new THREE.Group();
      knee.position.set(0, -THIGH - 0.005, 0);
      hip.add(knee);
      add(knee, part((L) => {
        L.spine([[0, 0.01, 0], [0, -CALF * 0.6, 0], [0, -CALF, 0]], [0.056, 0.048, 0.043], { col: COL_TROUSER, seg: 8 });
        L.spine([[0, -CALF - 0.005, -0.02], [0, -CALF - 0.02, 0.115]], [0.044, 0.032], { col: COL_BOOT, seg: 6 });
      }));
      this.legs.push({ hip, knee });
    }

    this.facing = 0;
    this.phase = 0;
    this._t = Math.random() * 10;
    scene.add(this.root);
  }

  setOpacity(o) {
    this.opacity = o;
    this.root.visible = o > 0.015;
    this.mat.opacity = o;
  }

  /** Pose the body from the player's state. Runs once per frame, ~free. */
  update(dt, p) {
    if (!this.root.visible && p.rig && p.rig.blend > 0.999) {
      // Fully first-person: nothing to pose.
      return;
    }
    this._t += dt;
    const sit = p.sit01 || 0;
    const crouch = p.crouch * (1 - sit);
    const speed = p.speed;
    const air = p.onGround ? 0 : 1;

    easeFacing(this, dt, p);
    this.root.position.copy(p.position);
    this.root.rotation.y = this.facing + Math.PI;

    /* --- gait --------------------------------------------------------- */
    this.phase += speed * dt * 1.9;
    const stride = clamp(speed / 2.4, 0, 1) * (1 - air * 0.85) * (1 - sit);
    const runK = clamp((speed - 4.3) / 4.0, 0, 1);
    const ampLeg = stride * (0.52 + runK * 0.32);
    const swing = Math.sin(this.phase);
    const swingB = Math.sin(this.phase + Math.PI);

    // Walk targets. Forward swing is negative rotation.x (body faces +Z).
    let thighA = [-swing * ampLeg, -swingB * ampLeg];
    // The knee folds as its leg comes forward and lifts.
    let kneeA = [
      (0.12 + 0.55 * Math.max(0, Math.sin(this.phase + 1.9))) * ampLeg * 1.35,
      (0.12 + 0.55 * Math.max(0, Math.sin(this.phase + Math.PI + 1.9))) * ampLeg * 1.35,
    ];
    let armA = [swing * ampLeg * 0.55, swingB * ampLeg * 0.55];
    let elbowA = [-0.25 - ampLeg * 0.2, -0.25 - ampLeg * 0.2];
    let lean = -clamp(speed / 8.4, 0, 1) * 0.22 - crouch * 0.38;
    let hipDrop = crouch * 0.40 + p.landDip * 0.30 + stride * 0.02 * (1 - Math.abs(Math.cos(this.phase)));

    // Airborne: legs trail, arms lift a touch.
    if (air > 0.2) {
      thighA = [lerp(thighA[0], 0.28, air), lerp(thighA[1], -0.15, air)];
      kneeA = [lerp(kneeA[0], 0.75, air), lerp(kneeA[1], 0.45, air)];
      armA = [lerp(armA[0], 0.35, air), lerp(armA[1], 0.35, air)];
    }

    // Idle breathing and a slow shift of weight, so standing never freezes.
    const breathe = Math.sin(this._t * 0.9) * 0.014 * (1 - stride);
    lean += breathe;
    const shift = Math.sin(this._t * 0.21) * (1 - stride) * (1 - sit) * 0.03;

    /* --- sitting: knees up, arms resting on them ----------------------- */
    const sitHip = 0.27;
    const standHip = HIP_Y - hipDrop;
    this.hips.position.y = lerp(standHip, sitHip, sit);
    this.hips.position.x = shift;

    const spread = sit * 0.15;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      this.legs[i].hip.rotation.x = lerp(thighA[i], -1.68, sit);
      this.legs[i].hip.rotation.z = -s * spread;
      this.legs[i].knee.rotation.x = lerp(kneeA[i], 1.86, sit);
      this.arms[i].shoulder.rotation.x = lerp(armA[i], -1.05, sit);
      this.arms[i].shoulder.rotation.z = -s * (0.06 + air * 0.25 + sit * 0.12);
      this.arms[i].elbow.rotation.x = lerp(elbowA[i], -0.85, sit);
    }
    this.torso.rotation.x = lerp(lean, -0.14 + breathe, sit);

    /* --- the head follows the eyes ------------------------------------ */
    const lookYaw = clamp(wrapAngle(p.yaw - this.facing), -0.85, 0.85);
    this.head.rotation.y = lerp(this.head.rotation.y, lookYaw * 0.7, 1 - Math.exp(-dt * 6));
    this.head.rotation.x = lerp(this.head.rotation.x, -p.pitch * 0.45 - this.torso.rotation.x * 0.7, 1 - Math.exp(-dt * 6));
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this._meshes) m.geometry.dispose();
    this.mat.dispose();
  }
}

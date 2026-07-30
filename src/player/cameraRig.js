// The camera as a character of its own.
//
// Third person while you move: a lagged boom behind and a little above, so the
// camera drifts after you rather than being bolted to your spine. First person
// when you sit down (immediately) or stand still for a while (ten seconds).
// The move between the two is a two-second eased dolly along a gentle arc into
// the head, with input locked so it cannot be interrupted halfway; any
// movement input afterwards eases it back out as the body fades back in.
//
// Swimming, diving, flying and driving force first person - the body has no
// poses for them, and those modes always read best from inside the head.
//
// The mouse wheel sets the boom length. Scrolling all the way in dollies into
// the head; scrolling out from inside eases back onto the boom.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/noise.js';

const DIST = 3.9; // boom length at rest
const ZOOM_MIN = 1.6; // scrolling in past this dollies into the head
const ZOOM_MAX = 8.5;
const BOOM_UP = 0.34; // "slightly above": the boom pivots from over the head
const IDLE_DELAY = 10; // seconds of no movement input before easing in
const IN_TIME = 2.0; // the locked, deliberate transition
const IN_TIME_FORCED = 0.9; // water/flight/vehicle: quick, unlocked
const OUT_TIME = 1.3; // movement resumes control instantly; camera catches up
const CLEAR_GROUND = 0.32;
const CLEAR_WATER = 0.30;

const V_DIR = new THREE.Vector3();
const V_ORIGIN = new THREE.Vector3();
const V_THIRD = new THREE.Vector3();
const V_P1 = new THREE.Vector3();
const V_SAMPLE = new THREE.Vector3();
const V_A = new THREE.Vector3();
const V_B = new THREE.Vector3();
const L_BOX = [0, 0, 0];
const SCRATCH_BOXES = [];

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class CameraRig {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.camera = world.engine.camera;

    this.mode = 'third'; // 'third' | 'in' | 'first' | 'out'
    this.blend = 0; // 0 = third person, 1 = first person
    this.t = 0;
    this.dur = IN_TIME;
    this.lock = false; // input frozen during the deliberate ease-in
    this.idle = 0;

    this.follow = new THREE.Vector3(); // lagged head anchor
    this.dist = DIST; // where the player wants the boom (mouse wheel)
    this.boomLen = DIST; // collision-clamped, smoothed
    this._followInit = false;
    this._trees = [];
    this._treeTimer = 0;
    this._sitYawFrom = 0;
    this._sitPitchFrom = 0;
  }

  get inputLocked() {
    return this.lock && this.mode === 'in';
  }

  get isFirst() {
    return this.blend > 0.98;
  }

  /* --------------------------------------------------------------- update */

  /**
   * @param fpEye  the fully-detailed first-person eye position (bob, breath,
   *               land dip, swim roll all included - the camera the game has
   *               always had)
   * @param roll   first-person camera roll
   * @param sx,sy  shake offsets, applied in both modes
   */
  update(dt, fpEye, roll, sx, sy) {
    const p = this.player;
    const cam = this.camera;
    const forced = !!(p.swimming || p.drifting || p.vehicle || p.underwater);

    // The wheel is the zoom. Scrolling in past the shortest boom dollies into
    // the head; scrolling out from first person eases back onto the boom.
    const inp = this.world.input;
    if (inp && inp.wheel && !this.world.paused) {
      if (this.mode === 'third' || this.mode === 'out') {
        const atMin = this.dist <= ZOOM_MIN + 0.01;
        this.dist = clamp(this.dist * Math.pow(1.13, inp.wheel), ZOOM_MIN, ZOOM_MAX);
        if (atMin && inp.wheel < 0 && this.mode === 'third') this._startIn(true);
      } else if (this.mode === 'first' && inp.wheel > 0 && !forced && !p.sitting) {
        this._startOut();
      }
    }

    // Movement input is what resets the idle clock and breaks first person.
    // Raw intent, read before the lock zeroes it - but the lock means the
    // locked transition itself ignores it entirely.
    const moving = p.rawMove && !this.inputLocked;
    if (moving || forced || !p.onGround) this.idle = 0;
    else this.idle += dt;
    this._treeTimer -= dt;

    /* --- state machine ---------------------------------------------- */
    if (this.mode === 'third') {
      if (p.sitting || forced || this.idle > IDLE_DELAY) this._startIn(forced);
    } else if (this.mode === 'in') {
      this.t += dt / this.dur;
      if (this.t >= 1) {
        this.t = 1;
        this.mode = 'first';
        this.lock = false;
      }
      this.blend = smoothstep(0, 1, this.t);
      if (this.lock && p.sitting) this._steerSitView();
    } else if (this.mode === 'first') {
      this.blend = 1;
      if (!forced && !p.sitting && (moving || p.speed > 1.8)) this._startOut();
    } else {
      // 'out'
      this.t += dt / this.dur;
      if (this.t >= 1) {
        this.t = 1;
        this.mode = 'third';
      }
      this.blend = 1 - smoothstep(0, 1, this.t);
      // Sat down or hit the water mid-ease: turn around without a cut.
      if (p.sitting || forced) this._startIn(forced, this.blend);
    }

    /* --- the two ends of the dolly ----------------------------------- */
    // Third person anchors on the body, not the bobbing eye.
    V_A.set(p.position.x, p.position.y + p.eye + BOOM_UP - p.landDip * 0.3, p.position.z);
    if (!this._followInit) {
      this.follow.copy(V_A);
      this._followInit = true;
    }
    // The drift: the boom chases a lagged copy of the head. Never while
    // paused (dt 0 leaves it be) and never so slack the player leaves frame.
    this.follow.lerp(V_A, 1 - Math.exp(-dt * 6.5));
    // Keep the lag horizontal-only in feel: catch up faster vertically so
    // jumps and drops do not leave the camera under the ground.
    this.follow.y = lerp(this.follow.y, V_A.y, 1 - Math.exp(-dt * 10));

    const cp = Math.cos(p.pitch);
    V_DIR.set(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
    V_ORIGIN.copy(this.follow);

    if (this.blend < 0.999) {
      const maxLen = this._clampBoom(V_ORIGIN, V_DIR, this.dist);
      // Snap shorter instantly (never clip), relax back out gently.
      this.boomLen = maxLen < this.boomLen ? maxLen : lerp(this.boomLen, maxLen, 1 - Math.exp(-dt * 3));
      V_THIRD.copy(V_ORIGIN).addScaledVector(V_DIR, -this.boomLen);
    } else {
      this.boomLen = this.dist;
    }

    /* --- place the camera -------------------------------------------- */
    if (this.blend >= 0.999) {
      cam.position.copy(fpEye);
    } else if (this.blend <= 0.001) {
      cam.position.copy(V_THIRD);
      this._keepClear(cam.position, V_ORIGIN);
    } else {
      // A quadratic arc between the boom and the head: lifted and pushed a
      // little to the side so the dolly reads as a curve, not a zoom.
      V_P1.copy(V_THIRD).add(fpEye).multiplyScalar(0.5);
      V_P1.y += 0.42;
      V_P1.x += Math.cos(p.yaw) * 0.30;
      V_P1.z += -Math.sin(p.yaw) * 0.30;
      const b = this.blend;
      const u = 1 - b;
      cam.position.set(
        u * u * V_THIRD.x + 2 * u * b * V_P1.x + b * b * fpEye.x,
        u * u * V_THIRD.y + 2 * u * b * V_P1.y + b * b * fpEye.y,
        u * u * V_THIRD.z + 2 * u * b * V_P1.z + b * b * fpEye.z
      );
      this._keepClear(cam.position, fpEye);
    }

    cam.rotation.set(p.pitch + sy, p.yaw + sx, roll * this.blend);

    /* --- fade the body as the camera enters it ------------------------ */
    const ch = p.character;
    if (ch) {
      V_B.set(p.position.x, p.position.y + p.eye, p.position.z);
      const d = cam.position.distanceTo(V_B);
      // Hidden outright in a vehicle: the body has no driving pose and the
      // seat camera is far enough from the head that it would never fade.
      ch.setOpacity(p.vehicle ? 0 : smoothstep(0.4, 1.5, d));
    }
  }

  _startIn(forced, fromBlend = 0) {
    this.mode = 'in';
    this.dur = forced ? IN_TIME_FORCED : IN_TIME;
    this.lock = !forced;
    this.t = fromBlend; // resuming mid-arc keeps the position continuous
    const p = this.player;
    if (p.sitting && this.lock) {
      this._sitYawFrom = p.yaw;
      this._sitPitchFrom = p.pitch;
    }
  }

  _startOut() {
    this.mode = 'out';
    this.dur = OUT_TIME;
    this.lock = false;
    this.t = 0;
    // The boom starts from wherever the head is now and eases back.
    this.boomLen = 0.4;
  }

  /** While the locked sit transition runs, carry the gaze to the chosen view. */
  _steerSitView() {
    const p = this.player;
    if (p.sitYaw === null) return;
    const k = smoothstep(0, 1, this.t);
    p.yaw = this._sitYawFrom + wrapAngle(p.sitYaw - this._sitYawFrom) * k;
    // Settle the gaze near the horizon, where the view is.
    p.pitch = lerp(this._sitPitchFrom, clamp(this._sitPitchFrom, -0.22, 0.10) * 0.3 - 0.03, k);
  }

  /* ---------------------------------------------------- boom collision */

  /**
   * March the boom from the head outward and stop before anything solid:
   * terrain, the water surface, building boxes, tree trunks. Returns the
   * usable length.
   */
  _clampBoom(origin, dir, want) {
    const w = this.world;
    const terrain = w.terrain;

    if (this._treeTimer <= 0) {
      // Trunks do not move; refreshing the set a few times a second is plenty,
      // and flora.within walks every plant in every visible chunk.
      this._trees.length = 0;
      w.flora.within(origin.x, origin.z, this.dist + 1.5, this._trees);
      this._treeTimer = 0.4;
    }

    w.physics.query(origin.x, origin.z, want + 1, SCRATCH_BOXES);

    const N = 10;
    let ok = want;
    for (let i = 1; i <= N; i++) {
      const t = (i / N) * want;
      V_SAMPLE.copy(origin).addScaledVector(dir, -t);
      if (this._blockedAt(V_SAMPLE, terrain)) {
        ok = Math.max(0.4, ((i - 1) / N) * want - 0.15);
        break;
      }
    }
    return ok;
  }

  _blockedAt(pt, terrain) {
    const gh = terrain.heightAt(pt.x, pt.z);
    if (pt.y < gh + CLEAR_GROUND) return true;
    const wl = terrain.waterAt(pt.x, pt.z);
    if (wl > -Infinity && wl > gh && pt.y < wl + CLEAR_WATER) return true;
    for (const c of SCRATCH_BOXES) {
      c.toLocal(pt.x, pt.y, pt.z, L_BOX);
      if (
        Math.abs(L_BOX[0]) < c.hx + 0.26 &&
        Math.abs(L_BOX[1]) < c.hy + 0.26 &&
        Math.abs(L_BOX[2]) < c.hz + 0.26
      ) return true;
    }
    for (const e of this._trees) {
      const p = e.plant;
      const h = this.world.flora.height(p);
      if (h < 1.6) continue; // shrubs and grass are soft
      const r = clamp(0.05 + h * 0.02, 0.07, 0.45) + 0.22;
      const dx = p.x - pt.x, dz = p.z - pt.z;
      if (dx * dx + dz * dz < r * r && pt.y > p.y - 0.5 && pt.y < p.y + h * 0.8) return true;
    }
    return false;
  }

  /**
   * Point fix-up for the transition arc and the resting boom: if the eased
   * position ended up inside something, slide it toward the head until clear.
   */
  _keepClear(pos, toward) {
    const terrain = this.world.terrain;
    const gh = terrain.heightAt(pos.x, pos.z);
    if (pos.y < gh + CLEAR_GROUND) pos.y = gh + CLEAR_GROUND;
    const wl = terrain.waterAt(pos.x, pos.z);
    if (wl > -Infinity && wl > gh && pos.y < wl + CLEAR_WATER && toward.y > wl) {
      pos.y = wl + CLEAR_WATER;
    }
    for (let i = 0; i < 5; i++) {
      if (!this._pointInBox(pos)) return;
      pos.lerp(toward, 0.28);
    }
  }

  _pointInBox(pt) {
    for (const c of SCRATCH_BOXES) {
      c.toLocal(pt.x, pt.y, pt.z, L_BOX);
      if (
        Math.abs(L_BOX[0]) < c.hx + 0.20 &&
        Math.abs(L_BOX[1]) < c.hy + 0.20 &&
        Math.abs(L_BOX[2]) < c.hz + 0.20
      ) return true;
    }
    return false;
  }

  /* -------------------------------------------------------- sit view */

  /**
   * Where should a person sitting here look? Score a ring of directions for
   * open sky, falling ground and visible water; keep the current view unless
   * it is genuinely facing into a wall, a slope or a trunk.
   */
  chooseSitYaw() {
    const p = this.player;
    const w = this.world;
    const terrain = w.terrain;
    const px = p.position.x, pz = p.position.z;
    const eyeY = p.position.y + 1.0;

    const trees = [];
    w.flora.within(px, pz, 14, trees);
    w.physics.query(px, pz, 10, SCRATCH_BOXES);

    const DIRS = 24;
    const DEPTHS = [3, 6, 10, 16, 26, 40];
    let bestYaw = p.yaw;
    let bestScore = -Infinity;
    let curScore = 0;

    for (let i = 0; i < DIRS; i++) {
      const yaw = (i / DIRS) * Math.PI * 2 - Math.PI;
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      let score = 0;
      for (const d of DEPTHS) {
        const x = px + dx * d, z = pz + dz * d;
        const h = terrain.heightAt(x, z);
        const rise = h - eyeY;
        if (rise > d * 0.16) score -= 2.2 * clamp(rise / d, 0, 1.4); // hillside in the face
        else score += clamp(-rise / d, -0.3, 0.5); // falling ground opens the view
        const wl = terrain.waterAt(x, z);
        if (wl > h) score += d > 8 ? 0.9 : 0.35; // water is the best company
      }
      // A wall within a few strides kills a view completely.
      for (const dNear of [1.6, 3.2, 5.0]) {
        V_SAMPLE.set(px + dx * dNear, eyeY, pz + dz * dNear);
        if (this._pointInBox(V_SAMPLE)) score -= 4;
      }
      // A trunk dead ahead is nearly as bad.
      for (const e of trees) {
        const pl = e.plant;
        const h = w.flora.height(pl);
        if (h < 2) continue;
        const tx = pl.x - px, tz = pl.z - pz;
        const dist = Math.hypot(tx, tz);
        if (dist > 9 || dist < 0.01) continue;
        const ang = Math.abs(wrapAngle(Math.atan2(-tx, -tz) - yaw));
        if (ang < 0.30) score -= 2.6 * (1 - dist / 9);
      }
      // Mild loyalty to where you were already looking.
      const align = Math.cos(wrapAngle(yaw - p.yaw));
      score += align * 0.7;

      if (score > bestScore) {
        bestScore = score;
        bestYaw = yaw;
      }
      if (Math.abs(wrapAngle(yaw - p.yaw)) < (Math.PI / DIRS) + 0.01) curScore = score;
    }

    // Only steal the gaze when the current one is meaningfully worse.
    return bestScore - curScore > 1.4 ? bestYaw : p.yaw;
  }
}

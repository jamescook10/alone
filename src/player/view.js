// Where the camera is, and where it looks.
//
// First person, always. The game had a third-person boom for a while, with a
// visible body on the end of it and an eased dolly between the two; it was
// taken out again because it did not earn its keep. Almost everything that
// made this world worth walking through - the sky, the weather, the water,
// the distance - is better with nothing between you and it, and a body is
// the one object in a procedural world that a player can tell is wrong.
//
// What survived from the rig is the part that was never about the camera
// being outside your head: choosing what to look at when you sit down.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/noise.js';

const SIT_TURN = 1.1; // seconds; the gaze settles, and the look is locked for it
const V_SAMPLE = new THREE.Vector3();
const L_BOX = [0, 0, 0];
const SCRATCH_BOXES = [];

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class View {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.camera = world.engine.camera;
    this.turning = false;
    this.t = 0;
    this._fromYaw = 0;
    this._fromPitch = 0;
  }

  /** The settling turn owns the view while it runs, and nothing else does. */
  get inputLocked() {
    return this.turning;
  }

  /**
   * @param fpEye  the eye position, with bob, breath, land dip and swim roll
   *               already in it - or the seat, in a vehicle
   * @param roll   camera roll
   * @param sx,sy  shake offsets
   */
  update(dt, fpEye, roll, sx, sy) {
    const p = this.player;
    if (this.turning) {
      if (!p.sitting) this.turning = false;
      else this._settle(dt);
    }
    this.camera.position.copy(fpEye);
    this.camera.rotation.set(p.pitch + sy, p.yaw + sx, roll);
  }

  /* -------------------------------------------------------- sitting down */

  /** Start easing the gaze onto whatever sitDown picked. */
  beginSitTurn() {
    this.turning = true;
    this.t = 0;
    this._fromYaw = this.player.yaw;
    this._fromPitch = this.player.pitch;
  }

  _settle(dt) {
    const p = this.player;
    this.t = Math.min(1, this.t + dt / SIT_TURN);
    if (p.sitYaw !== null) {
      const k = smoothstep(0, 1, this.t);
      p.yaw = this._fromYaw + wrapAngle(p.sitYaw - this._fromYaw) * k;
      // And bring the gaze near the horizon, which is where the view is.
      p.pitch = lerp(this._fromPitch, clamp(this._fromPitch, -0.22, 0.10) * 0.3 - 0.03, k);
    }
    if (this.t >= 1) this.turning = false;
  }

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
}

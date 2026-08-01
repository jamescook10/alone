// The one person left.
//
// Walking, running, wading, swimming, diving, climbing, falling, driving and -
// once you find your feet - drifting. Plus the small set of things a body has
// to worry about out here: breath, warmth and how tired you are.

import * as THREE from 'three';
import { clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { atmo } from '../gfx/atmosphere.js';
import { BIOME } from '../world/worldgen.js';
import { ambientAt } from '../sim/chemistry.js';
import { View } from './view.js';

const EYE = 1.66;
const EYE_CROUCH = 1.02;
const EYE_SIT = 0.98;
const RADIUS = 0.34;
const GRAVITY = -19.0;
const FP_EYE = new THREE.Vector3();

export class Player {
  constructor(world, spawn) {
    this.world = world;
    this.camera = world.engine.camera;
    this.position = new THREE.Vector3(spawn.x, spawn.y + 1.2, spawn.z);
    this.velocity = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = -0.05;

    this.onGround = false;
    this.crouch = 0;
    this.eye = EYE;
    this.waterLevel = -Infinity;
    this.submersion = 0; // 0 dry, 1 fully under
    this.underwater = false;
    this.swimming = false;
    this.drifting = false;
    this.vehicle = null;
    this.sprint = 0;
    this.boost = 0;
    this.speed = 0;

    this.breath = 1;
    this.warmth = 1;
    this.energy = 1;
    this.temperature = 15;

    this.sitting = false;
    this.sit01 = 0;
    this.sitYaw = null;
    this.rawMove = false;
    this._satBefore = false;
    this.view = new View(world, this);

    this.bob = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.shakeAmount = 0;
    this.stepDist = 0;
    this._stride = 1;
    this.footMaterial = 'grass';
    this.lookTarget = null;
    this.sheltered = 0;

    this._res = { groundY: -Infinity, hitWall: false };
    this._tmpV = new THREE.Vector3();
    this._axes = { x: 0, y: 0 };
    this._noiseT = Math.random() * 100;
    this._blackout = 0;
    this.distanceWalked = 0;
    this.highestPoint = this.position.y;
    this.deepestPoint = this.position.y;
  }

  get input() {
    return this.world.input;
  }

  shove(x, y, z) {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
    this.onGround = false;
  }

  shake(a) {
    this.shakeAmount = Math.min(2.5, this.shakeAmount + a);
  }

  /* ----------------------------------------------------------------- look */

  _look(dt) {
    const inp = this.input;
    if (!inp) return;
    // The settling turn after you sit down owns the view while it runs.
    if (this.view.inputLocked) return;
    const s = inp.sensitivity;
    this.yaw -= inp.mouseDX * s;
    this.pitch -= inp.mouseDY * s * (inp.invertY ? -1 : 1);
    const gp = inp._gamepad && inp._gamepad();
    if (gp && gp.axes.length > 3) {
      if (Math.abs(gp.axes[2]) > 0.15) this.yaw -= gp.axes[2] * dt * 2.4;
      if (Math.abs(gp.axes[3]) > 0.15) this.pitch -= gp.axes[3] * dt * 1.9;
    }
    this.pitch = clamp(this.pitch, -1.53, 1.53);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /* --------------------------------------------------------------- update */

  update(dt) {
    if (dt <= 0) {
      this._applyCamera(0);
      return;
    }
    this._look(dt);
    this._noiseT += dt;

    if (this.vehicle) {
      if (this.sitting) this.standUp();
      this.sit01 = lerp(this.sit01, 0, 1 - Math.exp(-dt * 5));
      this._updateDriving(dt);
      this._applyCamera(dt);
      return;
    }

    const inp = this.input;
    const terrain = this.world.terrain;
    const pos = this.position;
    const vel = this.velocity;

    const ground = terrain.heightAt(pos.x, pos.z);
    let water = terrain.waterAt(pos.x, pos.z);
    // The surface you float on is the swell, not the flat datum.
    if (water > -Infinity) water += this.world.waveHeightAt(pos.x, pos.z);
    this.waterLevel = water;
    const bodyTop = pos.y + this.eye;
    this.submersion = water > -Infinity ? saturate((water - pos.y) / 1.75) : 0;
    const eyeUnder = water > -Infinity && water > pos.y + this.eye - 0.06;
    this.swimming = this.submersion > 0.72;
    this.underwater = eyeUnder;

    /* --- intent -------------------------------------------------------- */
    const ax = inp ? inp.axes(this._axes) : this._axes;
    let wantSprint = inp && (inp.down('ShiftLeft') || inp.down('ShiftRight'));
    let wantCrouch = inp && (inp.down('ControlLeft') || inp.down('KeyC'));
    let wantUp = inp && inp.down('Space');
    let wantDown = inp && (inp.down('ShiftLeft') || inp.down('KeyZ'));

    // Raw intent, before the settling turn swallows it: standing up again
    // has to be able to see that you pushed forward during it.
    this.rawMove = Math.hypot(ax.x, ax.y) > 0.06 || !!wantUp;
    if (this.view.inputLocked) {
      ax.x = 0;
      ax.y = 0;
      wantSprint = wantCrouch = wantUp = wantDown = false;
    }
    // Drifting keeps shift for the speed boost, so descending moves to crouch.
    const wantSink = inp && (wantCrouch || inp.down('KeyZ'));

    /* --- sitting ------------------------------------------------------- */
    if (inp && inp.hit('KeyX') && !this.view.inputLocked && !this.drifting && !this.swimming) {
      if (this.sitting) this.standUp();
      else if (this.onGround) this.sitDown();
    }
    if (this.sitting && !this.view.inputLocked && this.rawMove) this.standUp();
    if (this.sitting && (this.swimming || this.drifting)) this.standUp();
    this.sit01 = lerp(this.sit01, this.sitting ? 1 : 0, 1 - Math.exp(-dt * 5));

    this.crouch = lerp(this.crouch, wantCrouch && !this.swimming && !this.drifting && !this.sitting ? 1 : 0, 1 - Math.exp(-dt * 11));
    this.eye = lerp(lerp(EYE, EYE_CROUCH, this.crouch), EYE_SIT, this.sit01);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward is -Z in view space
    let fx = -sin, fz = -cos;
    let rx = cos, rz = -sin;
    let wishX = fx * ax.y + rx * ax.x;
    let wishZ = fz * ax.y + rz * ax.x;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-4) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    // Sprint is a body thing: it costs energy and it does not apply in flight.
    this.sprint = lerp(this.sprint, wantSprint && !this.drifting && wishLen > 0.2 && this.energy > 0.05 ? 1 : 0, 1 - Math.exp(-dt * 6));

    if (this.drifting) {
      this._updateDrift(dt, wishX, wishZ, wishLen, wantUp, wantSink, wantSprint);
    } else if (this.swimming) {
      this._updateSwim(dt, wishX, wishZ, wishLen, wantUp, wantDown, water, ground);
      // Rivers carry you: the same flow field that advects the ripples.
      const s = this.world.wg.sample(pos.x, pos.z, this._flowSample || (this._flowSample = {}));
      if (s.riverStrength > 0.05) {
        const fd = this.world.wg.flowDir(pos.x, pos.z, this._flowDir || (this._flowDir = [0, 0]));
        const push = s.riverStrength * 2.1 * dt;
        vel.x += fd[0] * push;
        vel.z += fd[1] * push;
      }
    } else {
      // Rising out of the sit pose damps the first strides, so standing up
      // reads as a motion instead of a snap.
      this._updateWalk(dt, wishX, wishZ, wishLen * (1 - this.sit01), wantUp && this.sit01 < 0.3, ground, water);
    }

    /* --- collisions with the built world -------------------------------- */
    this.world.physics.resolveCapsule(pos, RADIUS, this.eye + 0.1, this._res);
    if (this._res.groundY > -Infinity && !this.drifting) {
      if (pos.y < this._res.groundY && pos.y > this._res.groundY - 0.8) {
        pos.y = this._res.groundY;
        if (vel.y < 0) {
          this._land(-vel.y);
          vel.y = 0;
        }
        this.onGround = true;
      }
    }

    /* --- vitals --------------------------------------------------------- */
    this._vitals(dt, ground, water);
    this._applyCamera(dt);

    // Records worth remembering.
    if (pos.y > this.highestPoint) this.highestPoint = pos.y;
    if (pos.y < this.deepestPoint) this.deepestPoint = pos.y;
  }

  _updateWalk(dt, wishX, wishZ, wishLen, wantUp, ground, water) {
    const pos = this.position;
    const vel = this.velocity;
    const terrain = this.world.terrain;

    const wading = this.submersion > 0.05;
    const base = lerp(4.1, 8.4, this.sprint) * lerp(1, 0.42, this.crouch);
    const slopeN = terrain.normalAt(pos.x, pos.z, this._tmpV);
    const steep = 1 - slopeN.y;
    const uphill = wishLen > 0.01 ? -(slopeN.x * wishX + slopeN.z * wishZ) : 0;
    // Climbing costs speed; descending is a little faster.
    const slopeFactor = clamp(1 - uphill * 1.5 - steep * 0.5, 0.28, 1.22);
    const target = base * slopeFactor * lerp(1, 0.42, this.submersion) * wishLen;

    const accel = this.onGround ? 46 : 9;
    const cx = wishX * target - vel.x;
    const cz = wishZ * target - vel.z;
    const cl = Math.hypot(cx, cz);
    if (cl > 1e-5) {
      const k = Math.min(cl, accel * dt) / cl;
      vel.x += cx * k;
      vel.z += cz * k;
    }
    if (wishLen < 0.01 && this.onGround) {
      const f = Math.exp(-dt * 12);
      vel.x *= f;
      vel.z *= f;
    }

    vel.y += GRAVITY * dt * (wading ? 0.35 : 1);
    if (wading) {
      vel.y += -GRAVITY * dt * this.submersion * 0.55;
      vel.y *= Math.exp(-dt * 2.4 * this.submersion);
    }

    if (wantUp && this.onGround) {
      vel.y = 6.6;
      this.onGround = false;
      if (this.world.audio) this.world.audio.jump();
    }

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    const gh = terrain.heightAt(pos.x, pos.z);
    if (pos.y <= gh) {
      // Very steep ground makes you slide instead of stand.
      const n = terrain.normalAt(pos.x, pos.z, this._tmpV);
      const slope = 1 - n.y;
      pos.y = gh;
      if (vel.y < -0.5) this._land(-vel.y);
      vel.y = 0;
      this.onGround = true;
      if (slope > 0.58 && !wading) {
        const sl = (slope - 0.58) * 26;
        vel.x += n.x * sl * dt * 9;
        vel.z += n.z * sl * dt * 9;
      }
    } else if (pos.y > gh + 0.06) {
      this.onGround = false;
    }

    this.speed = Math.hypot(vel.x, vel.z);
    this._footsteps(dt, gh, water);
  }

  _updateSwim(dt, wishX, wishZ, wishLen, wantUp, wantDown, water, ground) {
    const pos = this.position;
    const vel = this.velocity;
    const pitch = this.pitch;
    // Swimming follows where you look, which is what makes diving feel good.
    const horiz = Math.cos(pitch);
    let dx = wishX * horiz;
    let dz = wishZ * horiz;
    let dy = wishLen > 0.01 ? Math.sin(pitch) : 0;
    if (wantUp) dy += 0.9;
    if (wantDown) dy -= 0.9;

    const target = lerp(2.5, 4.3, this.sprint) * clamp(wishLen + (wantUp || wantDown ? 0.6 : 0), 0, 1);
    const tx = dx * target, ty = dy * target, tz = dz * target;
    const k = 1 - Math.exp(-dt * 3.4);
    vel.x += (tx - vel.x) * k;
    vel.y += (ty - vel.y) * k;
    vel.z += (tz - vel.z) * k;

    // Float toward the surface when you stop swimming down.
    const depth = water - pos.y;
    if (!wantDown && depth > 0.4) vel.y += clamp(depth * 0.16, 0, 1.1) * dt * 2.2;
    if (pos.y > water - 0.5 && !wantUp) vel.y -= dt * 1.2;

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    const gh = this.world.terrain.heightAt(pos.x, pos.z);
    if (pos.y < gh) {
      pos.y = gh;
      vel.y = Math.max(0, vel.y);
    }
    if (pos.y > water) pos.y = Math.min(pos.y, water + 0.02);
    this.onGround = false;
    this.speed = Math.hypot(vel.x, vel.z);

    this.stepDist += this.speed * dt;
    if (this.stepDist > 2.6) {
      this.stepDist = 0;
      if (this.world.audio) this.world.audio.swimStroke(this.underwater);
    }
  }

  _updateDrift(dt, wishX, wishZ, wishLen, wantUp, wantDown, wantBoost) {
    const pos = this.position;
    const vel = this.velocity;
    // Flight is for reading the land, not for strolling: cruising is eight
    // times walking pace and the boost is thirty, so a biome you can see on
    // the horizon is under a minute away rather than ten.
    this.boost = lerp(this.boost, wantBoost ? 1 : 0, 1 - Math.exp(-dt * 2.6));
    const cruise = lerp(34, 128, this.boost);
    // Space and crouch climb at a fixed rate; diving with the mouse is what
    // gets you down fast, and that scales with cruise below.
    const climb = lerp(16, 44, this.boost);

    const horiz = Math.cos(this.pitch);
    const drive = clamp(wishLen, 0, 1);
    const dx = wishX * horiz;
    const dz = wishZ * horiz;
    const dy = wishLen > 0.01 ? Math.sin(this.pitch) : 0;
    const lift = (wantUp ? 1 : 0) - (wantDown ? 1 : 0);

    const tx = dx * cruise * drive;
    const tz = dz * cruise * drive;
    const ty = dy * cruise * drive + lift * climb;

    // Momentum going up, a firmer hand coming off the throttle, so stopping
    // over the thing you flew to look at does not take a hundred metres.
    const moving = drive > 0.01 || lift !== 0;
    const k = 1 - Math.exp(-dt * (moving ? 2.4 : 4.2));
    vel.x += (tx - vel.x) * k;
    vel.y += (ty - vel.y) * k;
    vel.z += (tz - vel.z) * k;
    pos.addScaledVector(vel, dt);
    const gh = this.world.terrain.heightAt(pos.x, pos.z);
    if (pos.y < gh + 0.4) {
      pos.y = gh + 0.4;
      vel.y = Math.max(vel.y, 0);
    }
    this.onGround = false;
    this.speed = Math.hypot(vel.x, vel.z);
  }

  _updateDriving(dt) {
    const v = this.vehicle;
    if (!v || !v.alive) {
      this.vehicle = null;
      return;
    }
    v.driveInput(this.input, dt);
    // Sit in the driver's seat.
    this.position.set(v.position.x, v.position.y + 0.35, v.position.z);
    this.velocity.set(0, 0, 0);
    this.speed = v.speed;
    this.onGround = true;
    this.submersion = 0;
    this.underwater = false;
    this.swimming = false;
    this._vitals(dt, v.position.y, -Infinity);
  }

  _land(impact) {
    if (impact > 2.6) {
      this.landDip = Math.min(1, impact * 0.09);
      if (this.world.audio) this.world.audio.land(Math.min(1, impact * 0.08), this.footMaterial);
      if (impact > 17) {
        // A very long fall hurts; the screen flashes and you stagger.
        this.shake(0.9);
        this.world.engine.grade.uniforms.uDamage.value = 0.7;
        this.energy = Math.max(0, this.energy - 0.35);
      }
    }
  }

  _footsteps(dt, gh, water) {
    if (!this.onGround) return;
    this.stepDist += this.speed * dt;
    this.distanceWalked += this.speed * dt;
    // Walking at a constant speed on flat ground otherwise puts a footfall on
    // an exact metronome, which the ear locks onto and cannot let go of.
    const stride = lerp(1.85, 2.5, this.sprint) * lerp(1, 0.7, this.crouch) * this._stride;
    if (this.stepDist < stride || this.speed < 0.4) return;
    this.stepDist = 0;
    this._stride = 0.90 + Math.random() * 0.20;
    const s = this.world.terrain.sampleAt(this.position.x, this.position.z);
    let mat = 'grass';
    if (this.submersion > 0.08) mat = 'water';
    else if (s.road > 0.2 || s.townInfluence > 0.4) mat = 'stone';
    else {
      switch (s.biome) {
        case BIOME.BEACH: case BIOME.DESERT: mat = 'sand'; break;
        case BIOME.SNOW: mat = 'snow'; break;
        case BIOME.SCREE: case BIOME.ALPINE: mat = 'gravel'; break;
        case BIOME.FOREST: case BIOME.TAIGA: case BIOME.RAINFOREST: mat = 'leaves'; break;
        case BIOME.SWAMP: mat = 'mud'; break;
        default: mat = 'grass';
      }
    }
    if (this.world.weather && this.world.weather.snowCover > 0.4 && s.temperature < 1) mat = 'snow';
    this.footMaterial = mat;
    if (this.world.audio) {
      this.world.audio.footstep(mat, lerp(0.5, 1, this.sprint) * lerp(1, 0.4, this.crouch));
    }
    if (mat === 'water') this.world.particles.splash(this.position.x, this.waterLevel, this.position.z, 0.35, 4);
    else if (mat === 'sand' || mat === 'gravel') {
      this.world.particles.dust(this.position.x, gh + 0.05, this.position.z, 2, 0.35);
    }
  }

  _vitals(dt, ground, water) {
    const w = this.world;
    this.temperature = ambientAt(w, this.position.x, this.position.y + 1, this.position.z);

    // Breath.
    if (this.underwater) {
      this.breath = Math.max(0, this.breath - dt / 46);
      if (this.breath <= 0) {
        this._blackout += dt;
        if (this._blackout > 1.2) this._surface();
      }
    } else {
      this.breath = Math.min(1, this.breath + dt / 5);
      this._blackout = 0;
    }

    // Warmth: cold air, wind and wet clothes cool you; fire and sun warm you.
    const fireHeat = w.fire.heatAt(this.position.x, this.position.y + 0.8, this.position.z);
    const wet = clamp(this.submersion + (w.weather ? w.weather.wetness * 0.6 * (1 - this.sheltered) : 0), 0, 1);
    const comfort = this.temperature + fireHeat * 0.5 + (w.sky.sunIntensity * (1 - (w.weather ? w.weather.overcast : 0)) * 5);
    const cooling = clamp((11 - comfort) / 26, -0.6, 1) + wet * 0.35;
    this.warmth = clamp(this.warmth - cooling * dt * 0.016 + 0.010 * dt, 0, 1);

    // Energy.
    const drain = this.sprint * 0.055 + (this.swimming ? 0.020 : 0) + (1 - this.warmth) * 0.012;
    this.energy = clamp(this.energy - drain * dt + (this.speed < 1.2 ? 0.05 : 0.018) * dt, 0, 1);

    // Shelter: is something solid over your head?
    const roof = w.physics.roofAbove(this.position.x, this.position.y + this.eye, this.position.z);
    let canopy = 0;
    const near = w.flora.nearest(this.position.x, this.position.y, this.position.z, 3.2);
    if (near) {
      const h = w.flora.height(near.plant);
      if (h > 3.4) canopy = 0.45;
    }
    this.sheltered = lerp(this.sheltered, Math.max(roof, canopy), 1 - Math.exp(-dt * 3));
    if (w.weather) w.weather.setShelter(this.sheltered);

    // Post effects driven by the body.
    const g = w.engine.grade.uniforms;
    const dmg = Math.max(0, (1 - this.breath / 0.28) * 0.55, (1 - this.warmth / 0.3) * 0.35);
    g.uDamage.value = lerp(g.uDamage.value, dmg, 1 - Math.exp(-dt * 2.5));
    g.uSaturation.value = lerp(1.14, 0.55, saturate((0.35 - this.warmth) * 3));
  }

  /** Gently move the player back to the surface after passing out underwater. */
  _surface() {
    const w = this.world;
    const pos = this.position;
    for (let i = 0; i < 220; i++) {
      const a = i * 2.399963;
      const r = 3 + 2.6 * Math.sqrt(i);
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      const h = w.terrain.heightAt(x, z);
      const wl = w.terrain.waterAt(x, z);
      if (h > (wl === -Infinity ? -999 : wl) + 0.4) {
        pos.set(x, h + 0.2, z);
        this.velocity.set(0, 0, 0);
        this.breath = 0.55;
        this._blackout = 0;
        w.note('You woke on the shore, coughing salt water.', 'event');
        if (w.ui) w.ui.fade(1.0, 1.4);
        return;
      }
    }
    this.breath = 0.4;
  }

  /* --------------------------------------------------------------- camera */

  _applyCamera(dt) {
    const cam = this.camera;
    const speedN = clamp(this.speed / 7, 0, 1.4);
    this.bobAmount = lerp(this.bobAmount, this.onGround && !this.vehicle ? speedN : 0, 1 - Math.exp(-dt * 7));
    this.bob += this.speed * dt * 2.05;
    this.landDip = lerp(this.landDip, 0, 1 - Math.exp(-dt * 6));
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 1.6);

    const bobY = Math.sin(this.bob * 2) * 0.036 * this.bobAmount;
    const bobX = Math.sin(this.bob) * 0.030 * this.bobAmount;
    // Idle breathing so the world never feels frozen.
    const breathe = Math.sin(this._noiseT * 0.9) * 0.010 * (1 - this.bobAmount);
    const swim = this.swimming ? Math.sin(this._noiseT * 1.4) * 0.05 : 0;

    let sx = 0, sy = 0;
    if (this.shakeAmount > 0.001) {
      const s = this.shakeAmount * this.shakeAmount * 0.16;
      sx = (Math.sin(this._noiseT * 61) + Math.sin(this._noiseT * 37)) * s;
      sy = (Math.cos(this._noiseT * 53) + Math.sin(this._noiseT * 29)) * s;
    }

    FP_EYE.set(
      this.position.x + bobX,
      this.position.y + this.eye + bobY + breathe + swim - this.landDip * 0.4,
      this.position.z
    );
    if (this.vehicle) {
      const v = this.vehicle;
      FP_EYE.set(v.camPos.x, v.camPos.y, v.camPos.z);
    }
    const roll = Math.sin(this.bob) * 0.012 * this.bobAmount + swim * 0.3;
    this.view.update(dt, FP_EYE, roll, sx, sy);

    // Field of view breathes with speed, which sells running - and in flight it
    // is the only cue that you are doing 120 m/s, since there is no engine and
    // nothing close enough to stream past you.
    const targetFov = this.vehicle
      ? 74 + clamp(this.speed * 0.35, 0, 16)
      : this.drifting
        ? 68 + clamp(this.speed * 0.20, 0, 22)
        : 68 + this.sprint * 5.5;
    if (Math.abs(cam.fov - targetFov) > 0.02) {
      cam.fov = lerp(cam.fov, targetFov, 1 - Math.exp(-dt * 4));
      cam.updateProjectionMatrix();
    }

    // Underwater look and feel.
    const under = this.underwater;
    atmo.uUnderwater.value = under ? 1 : 0;
    this.world.engine.grade.uniforms.uUnderwater.value = under ? 1 : 0;
    if (under) {
      const s = this.world.terrain.sampleAt(this.position.x, this.position.z);
      const depth = Math.max(0, (s.waterLevel === -Infinity ? 0 : s.waterLevel) - this.position.y);
      const murk = this.world.terrain.sampleAt(this.position.x, this.position.z).biome;
      atmo.uWaterFog.value.setRGB(
        lerp(0.035, 0.005, saturate(depth / 60)),
        lerp(0.155, 0.030, saturate(depth / 60)),
        lerp(0.195, 0.060, saturate(depth / 60))
      );
      atmo.uWaterDensity.value = 0.035 + saturate(depth / 300) * 0.055;
    }
    this.world.sky.setUnderwater(under, atmo.uWaterFog.value);
  }

  /* ------------------------------------------------------------ abilities */

  sitDown() {
    if (this.sitting) return;
    this.sitting = true;
    this.velocity.x = 0;
    this.velocity.z = 0;
    // If this spot faces a wall, a slope or a trunk, turn toward the view.
    this.sitYaw = this.view.chooseSitYaw();
    this.view.beginSitTurn();
    if (!this._satBefore) {
      this._satBefore = true;
      this.world.note('You sat down for a while. The world went on without you, gently.', 'note');
    }
  }

  standUp() {
    if (!this.sitting) return;
    this.sitting = false;
    this.sitYaw = null;
  }

  toggleDrift() {
    if (this.sitting) this.standUp();
    this.drifting = !this.drifting;
    if (this.drifting) {
      this.world.note('You let go of the ground. Hold shift to cover ground fast.', 'event');
    } else {
      this.boost = 0;
    }
    return this.drifting;
  }

  /** Where the player is looking, as a unit vector. */
  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eye, this.position.z);
  }

  /** Compass heading in degrees, 0 = north (-Z). */
  get heading() {
    let d = (-this.yaw * 180) / Math.PI;
    d = ((d % 360) + 360) % 360;
    return d;
  }
}

// Physics: a spatial hash of static boxes for anything you can walk into, a
// pool of dynamic rigid boxes for anything you can knock over or blow up, and
// the impulse maths that connects the two.

import * as THREE from 'three';
import { makeSolidMaterial } from '../gfx/materials.js';
import { clamp, lerp } from '../core/noise.js';

const CELL = 12;
const GRAVITY = -19.6; // a touch heavier than real, which reads better

export class Collider {
  constructor(x, y, z, hx, hy, hz, yaw = 0, data = null) {
    this.x = x; this.y = y; this.z = z;
    this.hx = hx; this.hy = hy; this.hz = hz;
    this.yaw = yaw;
    this.cos = Math.cos(-yaw);
    this.sin = Math.sin(-yaw);
    this.data = data;
    this.alive = true;
  }
  /** Point in local box space. */
  toLocal(px, py, pz, out) {
    const dx = px - this.x;
    const dz = pz - this.z;
    out[0] = dx * this.cos - dz * this.sin;
    out[1] = py - this.y;
    out[2] = dx * this.sin + dz * this.cos;
    return out;
  }
  toWorldDir(lx, lz, out) {
    out[0] = lx * this.cos + lz * this.sin;
    out[1] = -lx * this.sin + lz * this.cos;
    return out;
  }
}

export class Physics {
  constructor(world) {
    this.world = world;
    this.grid = new Map();
    this.colliders = [];
    this.bodies = [];
    this._tmp = [0, 0, 0];
    this._tmp2 = [0, 0];
    this._buildDebrisPool();
  }

  _buildDebrisPool() {
    const CAP = 420;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count * 3).fill(1), 3));
    this.debrisMat = makeSolidMaterial({ key: 'debris', flat: true, roughness: 0.9 });
    this.debrisMesh = new THREE.InstancedMesh(geo, this.debrisMat, CAP);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = true;
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
    this.debrisMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.world.engine.scene.add(this.debrisMesh);
    this.debrisCap = CAP;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /* ------------------------------------------------------------- statics */

  add(collider) {
    this.colliders.push(collider);
    const x0 = Math.floor((collider.x - collider.hx - 1) / CELL);
    const x1 = Math.floor((collider.x + collider.hx + 1) / CELL);
    const z0 = Math.floor((collider.z - collider.hz - 1) / CELL);
    const z1 = Math.floor((collider.z + collider.hz + 1) / CELL);
    collider._cells = [];
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const key = x * 4194304 + z;
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(collider);
        collider._cells.push(key);
      }
    }
    return collider;
  }

  remove(collider) {
    collider.alive = false;
    if (collider._cells) {
      for (const key of collider._cells) {
        const list = this.grid.get(key);
        if (!list) continue;
        const i = list.indexOf(collider);
        if (i >= 0) list.splice(i, 1);
      }
      collider._cells = null;
    }
    const i = this.colliders.indexOf(collider);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  query(x, z, radius, out = []) {
    out.length = 0;
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.grid.get(cx * 4194304 + cz);
        if (!list) continue;
        for (const c of list) {
          if (c.alive && out.indexOf(c) < 0) out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Push a vertical capsule out of any static box it has entered.
   * Returns the accumulated correction, and whether we ended up standing on
   * top of something.
   */
  resolveCapsule(pos, radius, height, out) {
    const near = this.query(pos.x, pos.z, radius + 2, SCRATCH);
    let groundY = -Infinity;
    let hitWall = false;
    const L = this._tmp;
    const D = this._tmp2;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of near) {
        // Expand the box by the capsule radius and test the centre line.
        c.toLocal(pos.x, pos.y, pos.z, L);
        const ex = c.hx + radius;
        const ez = c.hz + radius;
        const lowY = c.y - c.hy;
        const topY = c.y + c.hy;
        if (pos.y > topY - 0.02 || pos.y + height < lowY) {
          // Standing above it? record as ground.
          if (Math.abs(L[0]) < c.hx + radius * 0.5 && Math.abs(L[2]) < c.hz + radius * 0.5) {
            if (topY <= pos.y + 0.55 && topY > groundY) groundY = topY;
          }
          continue;
        }
        if (Math.abs(L[0]) >= ex || Math.abs(L[2]) >= ez) continue;

        // Inside: resolve along whichever axis needs the least movement.
        const pushX = ex - Math.abs(L[0]);
        const pushZ = ez - Math.abs(L[2]);
        const stepUp = topY - pos.y;
        if (stepUp > 0 && stepUp < 0.62) {
          // A kerb or a step: walk up it instead of being blocked.
          pos.y = topY + 0.001;
          if (topY > groundY) groundY = topY;
          moved = true;
          continue;
        }
        if (pushX < pushZ) {
          c.toWorldDir(Math.sign(L[0] || 1) * pushX, 0, D);
          pos.x += D[0];
          pos.z += D[1];
        } else {
          c.toWorldDir(0, Math.sign(L[2] || 1) * pushZ, D);
          pos.x += D[0];
          pos.z += D[1];
        }
        hitWall = true;
        moved = true;
      }
      if (!moved) break;
    }
    if (out) {
      out.groundY = groundY;
      out.hitWall = hitWall;
    }
    return out;
  }

  /** Is there a solid roof above this point? Used for shelter and rain. */
  roofAbove(x, y, z, maxUp = 14) {
    const near = this.query(x, z, 1.2, SCRATCH2);
    let best = 0;
    const L = this._tmp;
    for (const c of near) {
      c.toLocal(x, y, z, L);
      if (Math.abs(L[0]) > c.hx || Math.abs(L[2]) > c.hz) continue;
      const bottom = c.y - c.hy;
      if (bottom > y + 0.3 && bottom < y + maxUp) best = Math.max(best, 1);
    }
    return best;
  }

  /* ------------------------------------------------------------ dynamics */

  /**
   * Spawn a tumbling box. `kind` feeds the chemistry sim (wood burns, glass
   * shatters, metal does not).
   */
  spawnDebris(x, y, z, sx, sy, sz, color, opts = {}) {
    if (this.bodies.length >= this.debrisCap) {
      // Recycle the oldest body rather than dropping the new one.
      this.bodies.shift();
    }
    const b = {
      x, y, z,
      vx: opts.vx || 0, vy: opts.vy || 0, vz: opts.vz || 0,
      sx, sy, sz,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28, rz: Math.random() * 6.28,
      wx: (Math.random() - 0.5) * 6, wy: (Math.random() - 0.5) * 6, wz: (Math.random() - 0.5) * 6,
      color,
      life: opts.life || 26 + Math.random() * 22,
      rest: 0,
      mass: sx * sy * sz * (opts.density || 500),
      kind: opts.kind || 'rubble',
      bounce: opts.bounce !== undefined ? opts.bounce : 0.22,
      slot: -1,
    };
    this.bodies.push(b);
    return b;
  }

  impulse(b, ix, iy, iz) {
    const m = Math.max(0.5, b.mass * 0.01);
    b.vx += ix / m;
    b.vy += iy / m;
    b.vz += iz / m;
    b.rest = 0;
  }

  /** An explosion: pushes debris, damages buildings, throws vehicles, ignites. */
  explode(x, y, z, power = 1, radius = 9) {
    const w = this.world;
    for (const b of this.bodies) {
      const dx = b.x - x, dy = b.y - y, dz = b.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius * 1.6) continue;
      const f = (1 - d / (radius * 1.6)) * power * 340;
      const il = 1 / (d || 1);
      this.impulse(b, dx * il * f, (dy * il + 0.75) * f, dz * il * f);
      b.life = Math.max(b.life, 8);
    }
    w.civ.explosionDamage(x, y, z, power, radius);
    w.particles.explosion(x, y, z, power);
    w.fire.ignite(x, y + 0.5, z, power * 1.6, radius * 0.55);
    if (w.audio) w.audio.explosion(x, y, z, power);
    const p = w.player.position;
    const d = Math.hypot(p.x - x, p.y - y, p.z - z);
    if (d < radius * 2.4) {
      const f = (1 - d / (radius * 2.4)) * power;
      w.player.shove((p.x - x) / (d || 1) * f * 9, f * 5.5 + 2, (p.z - z) / (d || 1) * f * 9);
      w.player.shake(f * 1.6);
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const terrain = this.world.terrain;
    const near = SCRATCH3;
    const L = this._tmp;
    let live = 0;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.bodies.splice(i, 1);
        continue;
      }
      if (b.rest < 1) {
        b.vy += GRAVITY * dt;
        // Water slows and floats things.
        const wl = terrain.waterAt(b.x, b.z);
        if (wl > -Infinity && b.y < wl) {
          const sub = clamp((wl - b.y) / Math.max(0.1, b.sy), 0, 1);
          const buoy = b.kind === 'wood' ? 1.35 : b.kind === 'glass' ? 0.4 : 0.55;
          b.vy += -GRAVITY * dt * sub * buoy;
          const drag = Math.exp(-dt * 3.4 * sub);
          b.vx *= drag; b.vy *= drag; b.vz *= drag;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.rx += b.wx * dt;
        b.ry += b.wy * dt;
        b.rz += b.wz * dt;

        const gh = terrain.heightAt(b.x, b.z);
        const half = b.sy * 0.5;
        if (b.y - half < gh) {
          b.y = gh + half;
          if (b.vy < -0.4) {
            b.vy = -b.vy * b.bounce;
            b.vx *= 0.62; b.vz *= 0.62;
            b.wx *= 0.5; b.wy *= 0.5; b.wz *= 0.5;
            if (this.world.audio && Math.random() < 0.25) {
              this.world.audio.impact(b.x, b.y, b.z, b.kind, Math.min(1, Math.abs(b.vy) * 0.2));
            }
          } else {
            b.vy = 0;
            b.vx *= 0.82; b.vz *= 0.82;
            b.wx *= 0.8; b.wy *= 0.8; b.wz *= 0.8;
            if (Math.hypot(b.vx, b.vz) < 0.22 && Math.abs(b.wy) < 0.4) {
              b.rest += dt * 1.4;
              // Settle flat on the ground.
              b.rx = lerp(b.rx, Math.round(b.rx / 1.5708) * 1.5708, 1 - Math.exp(-dt * 4));
              b.rz = lerp(b.rz, Math.round(b.rz / 1.5708) * 1.5708, 1 - Math.exp(-dt * 4));
            }
          }
        }

        // Boxes bounce off buildings so rubble piles against walls.
        this.query(b.x, b.z, Math.max(b.sx, b.sz) + 0.5, near);
        for (const c of near) {
          c.toLocal(b.x, b.y, b.z, L);
          const ex = c.hx + b.sx * 0.5;
          const ey = c.hy + b.sy * 0.5;
          const ez = c.hz + b.sz * 0.5;
          if (Math.abs(L[0]) < ex && Math.abs(L[1]) < ey && Math.abs(L[2]) < ez) {
            const px = ex - Math.abs(L[0]);
            const py = ey - Math.abs(L[1]);
            const pz = ez - Math.abs(L[2]);
            if (py <= px && py <= pz) {
              b.y += Math.sign(L[1] || 1) * py;
              b.vy = -b.vy * b.bounce;
              b.vx *= 0.7; b.vz *= 0.7;
            } else if (px < pz) {
              b.x += Math.sign(L[0] || 1) * px;
              b.vx = -b.vx * 0.35;
            } else {
              b.z += Math.sign(L[2] || 1) * pz;
              b.vz = -b.vz * 0.35;
            }
          }
        }
      }
      live++;
    }

    // Push the surviving bodies into the instance buffer.
    const mesh = this.debrisMesh;
    const n = Math.min(this.bodies.length, this.debrisCap);
    mesh.count = n;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      this._e.set(b.rx, b.ry, b.rz);
      this._q.setFromEuler(this._e);
      const fade = clamp(b.life / 3, 0, 1);
      this._m4.compose(
        this._v.set(b.x, b.y, b.z),
        this._q,
        this._s.set(b.sx * fade, b.sy * fade, b.sz * fade)
      );
      this._m4.toArray(mesh.instanceMatrix.array, i * 16);
      mesh.instanceColor.array[i * 3] = b.color[0];
      mesh.instanceColor.array[i * 3 + 1] = b.color[1];
      mesh.instanceColor.array[i * 3 + 2] = b.color[2];
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }
}

const SCRATCH = [];
const SCRATCH2 = [];
const SCRATCH3 = [];

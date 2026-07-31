// What people left behind.
//
// Settlements are laid out deterministically from the seed: streets first, then
// plots along them, then a building on each plot. Buildings are assembled from
// pieces - wall panels, floor slabs, roof sections, panes of glass, furniture -
// and every piece is an individually addressable box with its own material,
// health and collider. That is what makes them enterable and what makes them
// come apart when you drive a bulldozer through the front wall.

import * as THREE from 'three';
import { makeSolidMaterial } from '../gfx/materials.js';
import { Rng, hash3i, hash3f, clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { SETTLEMENT, SETTLEMENT_INFO, SURFACE, SITE, SITE_INFO, BIOME } from './worldgen.js';
import { Collider } from '../sim/physics.js';
import { MATERIAL, Substance } from '../sim/chemistry.js';

const MAT = {
  brick: { col: [0.145, 0.072, 0.052], hp: 40, mat: 'brick', debris: 'rubble' },
  plaster: { col: [0.400, 0.385, 0.350], hp: 26, mat: 'concrete', debris: 'rubble' },
  concrete: { col: [0.215, 0.212, 0.205], hp: 60, mat: 'concrete', debris: 'rubble' },
  siding: { col: [0.255, 0.235, 0.200], hp: 18, mat: 'wood', debris: 'wood' },
  timber: { col: [0.115, 0.078, 0.048], hp: 20, mat: 'wood', debris: 'wood' },
  tile: { col: [0.130, 0.062, 0.048], hp: 16, mat: 'brick', debris: 'rubble' },
  slate: { col: [0.090, 0.092, 0.098], hp: 18, mat: 'stone', debris: 'rubble' },
  metal: { col: [0.245, 0.250, 0.262], hp: 34, mat: 'steel', debris: 'metal' },
  thatch: { col: [0.230, 0.185, 0.085], hp: 8, mat: 'grass', debris: 'wood' },
  wood: { col: [0.145, 0.100, 0.058], hp: 14, mat: 'wood', debris: 'wood' },
  cloth: { col: [0.230, 0.185, 0.175], hp: 5, mat: 'cloth', debris: 'wood' },
  glass: { col: [0.50, 0.62, 0.68], hp: 2, mat: 'glass', debris: 'glass' },
  asphalt: { col: [0.048, 0.048, 0.052], hp: 999, mat: 'stone', debris: 'rubble' },
  // What people build with when they are not in a town: dressed stone for a
  // chapel or a temple, mud brick for a desert fort, rusted plate for
  // everything that was left outside for fifty years.
  stone: { col: [0.185, 0.180, 0.170], hp: 90, mat: 'stone', debris: 'rubble' },
  darkstone: { col: [0.105, 0.102, 0.098], hp: 100, mat: 'stone', debris: 'rubble' },
  mudbrick: { col: [0.270, 0.200, 0.130], hp: 30, mat: 'brick', debris: 'rubble' },
  rust: { col: [0.155, 0.072, 0.038], hp: 26, mat: 'steel', debris: 'metal' },
  canvas: { col: [0.300, 0.280, 0.225], hp: 4, mat: 'cloth', debris: 'wood' },
  paint: { col: [0.480, 0.470, 0.450], hp: 24, mat: 'steel', debris: 'metal' },
  redpaint: { col: [0.330, 0.070, 0.055], hp: 24, mat: 'steel', debris: 'metal' },
  ice: { col: [0.520, 0.600, 0.660], hp: 22, mat: 'stone', debris: 'rubble' },
};

// The colours a street takes. Which one a settlement gets is decided by the
// oracle from what it could justify and what the ground will carry.
const SURFACE_COL = [
  [0.050, 0.048, 0.044],
  [0.115, 0.078, 0.048], // dirt
  [0.140, 0.132, 0.120], // gravel
  [0.050, 0.050, 0.055], // tarmac
];

const PALETTES = [
  { wall: 'brick', roof: 'tile', trim: 'timber' },
  { wall: 'plaster', roof: 'slate', trim: 'timber' },
  { wall: 'siding', roof: 'slate', trim: 'wood' },
  { wall: 'plaster', roof: 'tile', trim: 'wood' },
  { wall: 'concrete', roof: 'metal', trim: 'metal' },
  { wall: 'timber', roof: 'thatch', trim: 'timber' },
];

const CELL = 2.0;      // wall panel width for houses
const CELL_TALL = 3.4; // ...and for anything taller than three storeys
const STOREY = 2.9;

// A city has to stay a city without becoming a million triangles. These are the
// budgets that keep one drawable: how many buildings it may contain, and a hard
// ceiling on the pieces they may be built from.
const MAX_BUILDINGS = [0, 12, 34, 110, 240];
const MAX_PIECES = 42000;
const MAX_DOORS = 48;
const MAX_VEHICLES_PER_DISTRICT = 20;

/* ================================================================= builds */

/**
 * Anything assembled out of individually destructible boxes: a whole city
 * district, a farmstead, a shipwreck. Owning the pieces, the instanced meshes
 * they are drawn from and the rules for knocking them down in one place is
 * what lets a barn out on the moor burn and collapse exactly the way a town
 * house does, without a line of new code.
 */
class Build {
  constructor(civ) {
    this.civ = civ;
    this.world = civ.world;
    this.pieces = [];
    this.colliders = [];
    this.vehicles = [];
    this.lamps = [];
    this.doors = [];
    this.buildings = [];
    this.animated = []; // the few things that turn: sails, a lighthouse lamp
    this.built = false;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
  }

  /* ------------------------------------------------------------- geometry */

  _piece(x, y, z, hx, hy, hz, yaw, matKey, opts = {}) {
    const m = MAT[matKey];
    const p = {
      x, y, z, hx, hy, hz, yaw,
      matKey, mat: m,
      hp: m.hp * (opts.hpScale || 1),
      hp0: m.hp * (opts.hpScale || 1),
      slot: -1,
      alive: true,
      burning: false,
      heat: 15,
      shade: opts.shade !== undefined ? opts.shade : 0.9 + Math.random() * 0.2,
      structural: !!opts.structural,
      collide: opts.collide !== false,
      glass: matKey === 'glass',
      building: opts.building || null,
    };
    this.pieces.push(p);
    if (p.collide) {
      const c = new Collider(x, y, z, hx, hy, hz, yaw, p);
      p.collider = c;
      this.world.physics.add(c);
    }
    if (opts.building) opts.building.pieces.push(p);
    return p;
  }

  _makeDoor(x, y, z, yaw, halfW, building) {
    const geo = new THREE.BoxGeometry(halfW * 2, 2.1, 0.09);
    geo.translate(halfW, 0, 0); // hinge at the left edge
    const mesh = new THREE.Mesh(geo, this.civ.doorMat);
    mesh.position.set(x - Math.cos(yaw) * halfW, y + 1.06, z - Math.sin(yaw) * halfW);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    this.group.add(mesh);
    const door = { mesh, open: 0, target: 0, yaw, x, y, z, building };
    this.doors.push(door);
    this.civ.doors.push(door);
    return door;
  }

  _makeLamp(x, z) {
    const terrain = this.world.terrain;
    const y = terrain.heightAt(x, z);
    this._piece(x, y + 2.3, z, 0.09, 2.3, 0.09, 0, 'metal', { hpScale: 1.4 });
    this._piece(x + 0.4, y + 4.5, z, 0.5, 0.07, 0.07, 0, 'metal', { collide: false });
    const lamp = { x: x + 0.8, y: y + 4.45, z, on: false };
    this.lamps.push(lamp);
    this.civ.lamps.push(lamp);
    this._piece(lamp.x, lamp.y, lamp.z, 0.20, 0.10, 0.20, 0, 'glass', { collide: false, hpScale: 1 });
  }

  /* ----------------------------------------------------------- instancing */

  _commitPieces() {
    const solid = [];
    const glass = [];
    for (const p of this.pieces) (p.glass ? glass : solid).push(p);
    this.solidMesh = this._makeInstanced(solid, this.civ.pieceMat, false);
    this.glassMesh = this._makeInstanced(glass, this.civ.glassMat, true);
    this.solidList = solid;
    this.glassList = glass;
  }

  _makeInstanced(list, mat, isGlass) {
    if (!list.length) return null;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = !isGlass;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.slot = i;
      p.mesh = mesh;
      this._writePiece(p);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  _writePiece(p) {
    // Most pieces are upright and only need a yaw. The ones that are not - a
    // heeled-over hull, a fallen standing stone, the panels of a tent, a wing
    // lying in the grass - carry a pitch and a roll as well.
    if (p.pitch || p.roll) {
      EUL.set(p.pitch || 0, p.yaw, p.roll || 0, 'YXZ');
      QUAT.setFromEuler(EUL);
    } else {
      QUAT.setFromAxisAngle(UPV, p.yaw);
    }
    if (p.alive) {
      M4.compose(TMPV.set(p.x, p.y, p.z), QUAT, SCLV.set(p.hx * 2, p.hy * 2, p.hz * 2));
    } else {
      M4.makeScale(0, 0, 0);
    }
    M4.toArray(p.mesh.instanceMatrix.array, p.slot * 16);
    const burn = p.burning ? 0.28 : 1;
    const s = p.shade * burn * lerp(0.45, 1, p.hp / p.hp0);
    const c = p.mat.col;
    p.mesh.instanceColor.array[p.slot * 3] = c[0] * s;
    p.mesh.instanceColor.array[p.slot * 3 + 1] = c[1] * s;
    p.mesh.instanceColor.array[p.slot * 3 + 2] = c[2] * s;
    p.mesh.instanceMatrix.needsUpdate = true;
    p.mesh.instanceColor.needsUpdate = true;
  }

  /* ----------------------------------------------------------- destruction */

  damagePiece(p, amount, impulse) {
    if (!p.alive) return false;
    p.hp -= amount;
    if (p.hp > 0) {
      this._writePiece(p);
      return false;
    }
    p.alive = false;
    if (p.collider) this.world.physics.remove(p.collider);
    this._writePiece(p);

    // Break it into a handful of tumbling chunks.
    const phys = this.world.physics;
    const vol = p.hx * p.hy * p.hz * 8;
    const n = clamp(Math.round(vol * 1.7), 1, 6);
    for (let i = 0; i < n; i++) {
      const sx = p.hx * 2 / Math.cbrt(n) * 0.85;
      const sy = p.hy * 2 / Math.cbrt(n) * 0.85;
      const sz = p.hz * 2 / Math.cbrt(n) * 0.85;
      const jx = (Math.random() - 0.5) * p.hx * 1.4;
      const jy = (Math.random() - 0.5) * p.hy * 1.4;
      const jz = (Math.random() - 0.5) * p.hz * 1.4;
      const b = phys.spawnDebris(p.x + jx, p.y + jy, p.z + jz,
        Math.max(0.10, sx), Math.max(0.10, sy), Math.max(0.10, sz),
        [p.mat.col[0] * p.shade, p.mat.col[1] * p.shade, p.mat.col[2] * p.shade],
        { kind: p.mat.debris, bounce: p.glass ? 0.05 : 0.2 });
      if (impulse) phys.impulse(b, impulse[0] * 0.5, impulse[1] * 0.5 + 40, impulse[2] * 0.5);
      else phys.impulse(b, jx * 30, 60 + Math.random() * 90, jz * 30);
    }
    this.world.particles.dust(p.x, p.y, p.z, p.glass ? 2 : 6, Math.max(0.4, p.hx),
      p.glass ? [0.5, 0.6, 0.65] : [0.30, 0.28, 0.25]);
    if (this.world.audio) {
      this.world.audio.impact(p.x, p.y, p.z, p.glass ? 'glass' : p.mat.debris, 1);
    }

    // Losing a structural piece brings the pieces above it down too.
    if (p.structural && p.building) {
      for (const q of p.building.pieces) {
        if (!q.alive || q === p) continue;
        if (q.y > p.y + 0.4 && Math.hypot(q.x - p.x, q.z - p.z) < 2.6) {
          if (Math.random() < 0.5) this.damagePiece(q, 1e6, impulse);
        }
      }
    }
    return true;
  }

  /** Windmill sails and lighthouse lamps: the only things here that move. */
  update(dt) {
    for (const a of this.animated) a(dt);
  }

  dispose() {
    for (const p of this.pieces) {
      if (p.collider) this.world.physics.remove(p.collider);
      p.mesh = null;
    }
    for (const d of this.doors) {
      const i = this.civ.doors.indexOf(d);
      if (i >= 0) this.civ.doors.splice(i, 1);
      d.mesh.geometry.dispose();
    }
    for (const l of this.lamps) {
      const i = this.civ.lamps.indexOf(l);
      if (i >= 0) this.civ.lamps.splice(i, 1);
    }
    for (const v of this.vehicles.slice()) {
      // Never take away the thing the player is sitting in. Fly an aeroplane
      // a kilometre from its airstrip and the strip streams out behind you -
      // which used to delete the aeroplane with you in it.
      if (v === this.world.player.vehicle) {
        v.district = null;
        continue;
      }
      this.civ.removeVehicle(v);
    }
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.world.engine.scene.remove(this.group);
    this.pieces.length = 0;
    this.built = false;
  }
}

/* ============================================================== districts */

class District extends Build {
  constructor(civ, town) {
    super(civ);
    this.town = town;
  }

  /* ------------------------------------------------------------- layout */

  build() {
    if (this.built) return;
    this.built = true;
    const t = this.town;
    const rng = new Rng(t.seed);
    const world = this.world;
    const terrain = world.terrain;

    /* streets ---------------------------------------------------------- */
    const streets = [];
    const R = t.radius;
    if (t.kind >= SETTLEMENT.TOWN) {
      // A rotated grid, with the spacing growing toward the edges.
      const rot = rng.float(0, Math.PI);
      const step = t.kind === SETTLEMENT.CITY ? 62 : 52;
      const n = Math.ceil(R / step);
      for (let i = -n; i <= n; i++) {
        for (const axis of [0, 1]) {
          const off = i * step + rng.float(-6, 6);
          const a = rot + axis * Math.PI * 0.5;
          const dx = Math.cos(a), dz = Math.sin(a);
          const px = -dz * off, pz = dx * off;
          const half = Math.sqrt(Math.max(0, R * R - off * off));
          if (half < 24) continue;
          streets.push({
            ax: t.x + px - dx * half, az: t.z + pz - dz * half,
            bx: t.x + px + dx * half, bz: t.z + pz + dz * half,
            w: axis === 0 ? 5.6 : 4.8,
          });
        }
      }
    } else {
      // A village strings itself along the road that passes through it.
      const links = t.links.length ? t.links : [{ x: t.x + R * 2, z: t.z }];
      for (const l of links) {
        const dx = l.x - t.x, dz = l.z - t.z;
        const len = Math.hypot(dx, dz) || 1;
        streets.push({
          ax: t.x - (dx / len) * R, az: t.z - (dz / len) * R,
          bx: t.x + (dx / len) * R, bz: t.z + (dz / len) * R,
          w: 4.4,
        });
      }
      // plus one lane crossing it
      const a = rng.float(0, Math.PI);
      streets.push({
        ax: t.x + Math.cos(a) * R * 0.8, az: t.z + Math.sin(a) * R * 0.8,
        bx: t.x - Math.cos(a) * R * 0.8, bz: t.z - Math.sin(a) * R * 0.8,
        w: 3.8,
      });
    }
    this.streets = streets;
    this._buildRoads(streets);

    /* plots ------------------------------------------------------------ */
    const placed = [];
    const isCity = t.kind === SETTLEMENT.CITY;
    let budgetSpent = false;
    for (const st of streets) {
      const len = Math.hypot(st.bx - st.ax, st.bz - st.az);
      const dx = (st.bx - st.ax) / len;
      const dz = (st.bz - st.az) / len;
      const px = -dz, pz = dx;
      let along = rng.float(6, 16);
      while (along < len - 8) {
        const plotW = rng.float(7, isCity ? 22 : 13);
        for (const side of [-1, 1]) {
          if (rng.next() < (isCity ? 0.12 : 0.30)) continue;
          const back = st.w + rng.float(2.5, isCity ? 5 : 9);
          const cx = st.ax + dx * (along + plotW * 0.5) + px * side * (back + plotW * 0.42);
          const cz = st.az + dz * (along + plotW * 0.5) + pz * side * (back + plotW * 0.42);
          const dTown = Math.hypot(cx - t.x, cz - t.z);
          if (dTown > R * 1.02) continue;
          let clash = false;
          for (const p of placed) {
            if (Math.hypot(p.x - cx, p.z - cz) < (p.r + plotW * 0.6) * 0.95) {
              clash = true;
              break;
            }
          }
          if (clash) continue;
          const s = terrain.sampleAt(cx, cz);
          if (s.waterLevel > s.height - 0.4) continue;
          const slope = 1 - terrain.normalAt(cx, cz, TMPV).y;
          if (slope > 0.36) continue;
          if (this.buildings.length >= MAX_BUILDINGS[t.kind] || this.pieces.length >= MAX_PIECES) {
            budgetSpent = true;
            break;
          }
          placed.push({ x: cx, z: cz, r: plotW * 0.6 });
          const yaw = Math.atan2(-px * side, -pz * side) + Math.PI;
          this._makeBuilding(cx, cz, yaw, plotW, rng, dTown / R, t.kind);
        }
        if (budgetSpent) break;
        along += plotW + rng.float(3, 11);
      }
      // Street furniture. No grid ever reached a dirt-road hamlet, so no
      // lamp posts there either - it is the difference between a place that
      // lost its electricity and a place that never had any.
      const lampStep = 26;
      const lit = t.surface >= SURFACE.GRAVEL && t.kind >= SETTLEMENT.VILLAGE;
      for (let d = lampStep * 0.5; lit && d < len; d += lampStep) {
        const side = rng.next() < 0.5 ? -1 : 1;
        const lx = st.ax + dx * d + px * side * (st.w + 0.7);
        const lz = st.az + dz * d + pz * side * (st.w + 0.7);
        if (Math.hypot(lx - t.x, lz - t.z) > R) continue;
        this._makeLamp(lx, lz);
      }
      // Parked vehicles.
      const carStep = isCity ? 40 : 34;
      for (let d = rng.float(8, carStep); d < len - 6; d += carStep * rng.float(0.7, 1.8)) {
        if (rng.next() < 0.35) continue;
        const side = rng.next() < 0.5 ? -1 : 1;
        const vx = st.ax + dx * d + px * side * (st.w * 0.55);
        const vz = st.az + dz * d + pz * side * (st.w * 0.55);
        if (Math.hypot(vx - t.x, vz - t.z) > R) continue;
        if (this.vehicles.length >= MAX_VEHICLES_PER_DISTRICT) break;
        const roll = rng.next();
        const kind = roll < 0.62 ? 'car' : roll < 0.82 ? 'van' : roll < 0.94 ? 'truck' : 'bulldozer';
        this.civ.spawnVehicle(vx, vz, Math.atan2(dz, dx) + (side < 0 ? Math.PI : 0), kind, this);
      }
    }

    this._commitPieces();
    this.world.engine.scene.add(this.group);
  }

  /* -------------------------------------------------------------- roads */

  _buildRoads(streets) {
    const terrain = this.world.terrain;
    const sc = SURFACE_COL[this.town.surface] || SURFACE_COL[1];
    const pos = [];
    const col = [];
    const idx = [];
    const nrm = [];
    for (const st of streets) {
      const len = Math.hypot(st.bx - st.ax, st.bz - st.az);
      const steps = Math.max(2, Math.ceil(len / 5));
      const dx = (st.bx - st.ax) / len;
      const dz = (st.bz - st.az) / len;
      const px = -dz, pz = dx;
      for (let i = 0; i <= steps; i++) {
        const d = (i / steps) * len;
        const cx = st.ax + dx * d;
        const cz = st.az + dz * d;
        for (const s of [-1, 1]) {
          const x = cx + px * s * st.w;
          const z = cz + pz * s * st.w;
          pos.push(x, terrain.heightAt(x, z) + 0.05, z);
          nrm.push(0, 1, 0);
          col.push(sc[0], sc[1], sc[2]);
        }
        // painted centre line
        if (i < steps) {
          const b = (pos.length / 3) - 2;
          idx.push(b, b + 2, b + 3, b, b + 3, b + 1);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.civ.roadMat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.roadMesh = mesh;
  }

  /* ----------------------------------------------------------- buildings */

  _makeBuilding(cx, cz, yaw, plotW, rng, distN, kind) {
    const terrain = this.world.terrain;
    const isCity = kind === SETTLEMENT.CITY;
    const isTown = kind >= SETTLEMENT.TOWN;
    // Taller toward the middle of a city.
    let floors = 1;
    if (isCity) floors = Math.max(1, Math.round(lerp(8, 1.6, Math.pow(distN, 0.65)) * rng.float(0.6, 1.3)));
    else if (isTown) floors = rng.next() < 0.35 ? 2 : rng.next() < 0.75 ? 1 : 3;
    else floors = rng.next() < 0.3 ? 2 : 1;
    floors = clamp(floors, 1, 9);

    // Taller buildings get wider panels: nobody inspects the twelfth storey.
    const cell = floors > 3 ? CELL_TALL : CELL;
    const wCells = Math.max(3, Math.round(plotW / cell) - (isCity ? 0 : 1));
    const dCells = Math.max(3, Math.round(rng.float(0.62, 1.05) * wCells));
    const w = wCells * cell;
    const d = dCells * cell;

    const pal = PALETTES[isCity ? (rng.next() < 0.6 ? 4 : 1) : rng.int(0, PALETTES.length)];
    const wallKey = pal.wall;
    const roofKey = floors > 3 ? 'metal' : pal.roof;

    // Ground level: the highest corner, so the building never floats.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let base = -Infinity;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = cx + (ox * w * 0.5) * c - (oz * d * 0.5) * s;
      const pz = cz + (ox * w * 0.5) * s + (oz * d * 0.5) * c;
      base = Math.max(base, terrain.heightAt(px, pz));
    }
    base += 0.12;

    const building = {
      x: cx, z: cz, yaw, w, d, floors, base,
      height: floors * STOREY,
      pieces: [],
      kind: isCity && floors > 4 ? 'tower' : floors > 1 ? 'house' : rng.next() < 0.2 ? 'shop' : 'cottage',
      name: null,
      district: this,
    };
    this.buildings.push(building);

    const local = (lx, lz, out) => {
      out[0] = cx + lx * c - lz * s;
      out[1] = cz + lx * s + lz * c;
      return out;
    };
    const P = [0, 0];

    // Where the front door goes.
    const doorCell = 1 + rng.int(0, Math.max(1, wCells - 2));

    /* foundation, the floors you can actually reach, and the roof */
    for (let f = 0; f <= floors; f++) {
      const isRoof = f === floors;
      // Slabs exist for the ground floor, the two above it, and the roof.
      // The middle of a tower is sealed, so nothing there needs building.
      if (!isRoof && f > 2) continue;
      const y = base + f * STOREY;
      const slabKey = isRoof ? roofKey : f === 0 ? 'concrete' : 'wood';
      const nx = Math.ceil(w / 5.0);
      const nz = Math.ceil(d / 5.0);
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const lx = -w / 2 + (i + 0.5) * (w / nx);
          const lz = -d / 2 + (j + 0.5) * (d / nz);
          local(lx, lz, P);
          this._piece(P[0], y + (isRoof ? 0.14 : -0.09), P[1],
            w / nx / 2, isRoof ? 0.14 : 0.09, d / nz / 2, yaw, slabKey,
            { building, structural: isRoof, hpScale: isRoof ? 1 : 1.6 });
        }
      }
    }

    /* walls */
    for (let f = 0; f < floors; f++) {
      const y0 = base + f * STOREY;
      for (let side = 0; side < 4; side++) {
        const along = side % 2 === 0 ? wCells : dCells;
        for (let i = 0; i < along; i++) {
          const t0 = (i + 0.5) / along - 0.5;
          let lx, lz, pw, pd;
          if (side === 0) { lx = t0 * w; lz = -d / 2; pw = w / along / 2; pd = 0.14; }
          else if (side === 1) { lx = w / 2; lz = t0 * d; pw = 0.14; pd = d / along / 2; }
          else if (side === 2) { lx = t0 * w; lz = d / 2; pw = w / along / 2; pd = 0.14; }
          else { lx = -w / 2; lz = t0 * d; pw = 0.14; pd = d / along / 2; }

          const isDoor = f === 0 && side === 0 && i === doorCell;
          const wantWindow = !isDoor && rng.next() < (isCity ? 0.72 : 0.44);

          local(lx, lz, P);
          if (isDoor) {
            // A doorway: lintel above, nothing below, and a door you can open.
            this._piece(P[0], y0 + STOREY - 0.4, P[1], pw, 0.4, pd, yaw, wallKey, { building });
            if (floors <= 3 && this.doors.length < MAX_DOORS) {
              this._makeDoor(P[0], y0, P[1], yaw, pw * 1.7, building);
            }
            continue;
          }
          if (wantWindow) {
            const sillH = 0.85;
            const winH = 1.25;
            this._piece(P[0], y0 + sillH * 0.5, P[1], pw, sillH * 0.5, pd, yaw, wallKey, { building });
            if (floors <= 3) {
              this._piece(P[0], y0 + sillH + winH + (STOREY - sillH - winH) * 0.5, P[1],
                pw, (STOREY - sillH - winH) * 0.5, pd, yaw, wallKey, { building });
            }
            this._piece(P[0], y0 + sillH + winH * 0.5, P[1], pw * 0.92,
              (floors <= 3 ? winH : STOREY - sillH) * 0.5, pd * 0.4, yaw, 'glass',
              { building, collide: true });
          } else {
            this._piece(P[0], y0 + STOREY * 0.5, P[1], pw, STOREY * 0.5, pd, yaw, wallKey, { building });
          }
        }
      }

      /* a couple of interior partitions and some furniture */
      if (f <= 1 && (f === 0 || rng.next() < 0.5)) this._furnish(building, f, base + f * STOREY, w, d, cx, cz, yaw, rng, local, P);
    }

    /* pitched roof for small buildings */
    if (floors <= 2 && rng.next() < 0.8) {
      const ridgeH = Math.min(w, d) * 0.30;
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const yy = base + floors * STOREY + 0.28 + (t0 + t1) * 0.5 * ridgeH;
        const inset = (t0 + t1) * 0.5;
        local(0, 0, P);
        this._piece(P[0], yy, P[1], w * 0.5 * (1 - inset * 0.94) + 0.2, ridgeH / steps * 0.55, d * 0.5 * (1 - inset * 0.5) + 0.2,
          yaw, roofKey, { building, structural: true });
      }
    }

    /* a chimney, because smoke is lovely */
    if (floors <= 3 && rng.next() < 0.55) {
      local(w * 0.5 - CELL * 0.6, d * 0.25, P);
      this._piece(P[0], base + floors * STOREY + 1.1, P[1], 0.34, 1.1, 0.34, yaw, 'brick', { building });
    }
    return building;
  }

  _furnish(building, floor, y, w, d, cx, cz, yaw, rng, local, P) {
    const n = 2 + rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const lx = rng.float(-w * 0.34, w * 0.34);
      const lz = rng.float(-d * 0.34, d * 0.34);
      local(lx, lz, P);
      const roll = rng.next();
      if (roll < 0.22) {
        // table
        this._piece(P[0], y + 0.74, P[1], 0.62, 0.05, 0.42, yaw + rng.float(-0.4, 0.4), 'wood', { building, hpScale: 0.5 });
        this._piece(P[0], y + 0.36, P[1], 0.10, 0.36, 0.10, yaw, 'wood', { building, collide: false, hpScale: 0.4 });
      } else if (roll < 0.42) {
        // bed
        this._piece(P[0], y + 0.28, P[1], 0.52, 0.24, 1.0, yaw + rng.float(-0.2, 0.2), 'wood', { building, hpScale: 0.6 });
        this._piece(P[0], y + 0.52, P[1], 0.50, 0.10, 0.95, yaw, 'cloth', { building, collide: false });
      } else if (roll < 0.58) {
        // sofa
        this._piece(P[0], y + 0.30, P[1], 0.85, 0.30, 0.40, yaw + rng.float(-0.5, 0.5), 'cloth', { building });
      } else if (roll < 0.74) {
        // shelf
        this._piece(P[0], y + 0.95, P[1], 0.55, 0.95, 0.22, yaw + rng.float(-0.3, 0.3), 'wood', { building });
      } else if (roll < 0.86) {
        // chair
        this._piece(P[0], y + 0.44, P[1], 0.22, 0.06, 0.22, yaw, 'wood', { building, hpScale: 0.3 });
        this._piece(P[0], y + 0.72, P[1], 0.22, 0.30, 0.06, yaw, 'wood', { building, collide: false, hpScale: 0.3 });
      } else {
        // interior partition
        const horiz = rng.next() < 0.5;
        this._piece(P[0], y + STOREY * 0.5, P[1],
          horiz ? w * 0.28 : 0.10, STOREY * 0.5, horiz ? 0.10 : d * 0.28,
          yaw, 'plaster', { building, hpScale: 0.7 });
      }
    }
  }

}


/* ================================================================ outposts */

/**
 * The things standing outside the settlements. The oracle decides *what*
 * belongs where - a lighthouse only on a headland, a temple only under a
 * jungle canopy, an airstrip only on ground flat enough to land on - and this
 * builds it out of the same destructible boxes a town house is made of, so
 * everything out here burns, collapses and can be driven through too.
 */
class Outpost extends Build {
  constructor(civ, site) {
    super(civ);
    this.site = site;
    this.name = site.name;
  }

  build() {
    if (this.built) return;
    this.built = true;
    const st = this.site;
    this.rng = new Rng(st.seed);
    this.cos = Math.cos(st.yaw);
    this.sin = Math.sin(st.yaw);
    this.base = this.world.terrain.heightAt(st.x, st.z);

    switch (st.kind) {
      case SITE.FARMSTEAD: this._farmstead(); break;
      case SITE.BARN: this._barn(0, 0, 9, 14, 5); break;
      case SITE.WINDMILL: this._windmill(); break;
      case SITE.LIGHTHOUSE: this._lighthouse(); break;
      case SITE.FISHING_HUT: this._fishingHut(); break;
      case SITE.JETTY: this._jetty(); break;
      case SITE.SHIPWRECK: this._shipwreck(); break;
      case SITE.HARBOUR: this._harbour(); break;
      case SITE.WATCHTOWER: this._watchtower(); break;
      case SITE.CHAPEL: this._chapel(); break;
      case SITE.STONE_CIRCLE: this._stoneCircle(); break;
      case SITE.QUARRY: this._quarry(); break;
      case SITE.MINE: this._mine(); break;
      case SITE.RADIO_MAST: this._mast(); break;
      case SITE.FORT: this._fort(); break;
      case SITE.TEMPLE: this._temple(); break;
      case SITE.RESEARCH: this._research(); break;
      case SITE.AIRSTRIP: this._airstrip(); break;
      case SITE.PLANE_WRECK: this._planeWreck(); break;
      case SITE.CABIN: this._cabin(); break;
      case SITE.CAMP: this._camp(); break;
      case SITE.WATER_TOWER: this._waterTower(); break;
      case SITE.WELL: this._well(); break;
      case SITE.TRAIN: this._train(); break;
      default: this._ruin(); break;
    }

    this._commitPieces();
    this.world.engine.scene.add(this.group);
  }

  /* --------------------------------------------------------------- helpers */

  /** Site-local (right, forward) to world x. Sites are built facing +z local. */
  _wx(r, f) { return this.site.x + r * this.cos - f * this.sin; }
  _wz(r, f) { return this.site.z + r * this.sin + f * this.cos; }
  /** Ground height at a site-local point. */
  _gy(r, f) { return this.world.terrain.heightAt(this._wx(r, f), this._wz(r, f)); }

  /** A box in site-local coordinates, sitting `y` above the levelled pad. */
  _b(r, f, y, hr, hy, hf, mat, opts) {
    return this._piece(this._wx(r, f), this.base + y, this._wz(r, f), hr, hy, hf,
      this.site.yaw, mat, opts);
  }

  /** Four walls with a gap for a doorway, and a floor slab. */
  _box(r, f, w, d, h, wall, roof, opts = {}) {
    const b = { x: this._wx(r, f), z: this._wz(r, f), yaw: this.site.yaw, pieces: [], district: this };
    this.buildings.push(b);
    const o = { building: b };
    this._b(r, f, -0.06, w * 0.5, 0.10, d * 0.5, 'concrete', o);
    const seg = Math.max(2, Math.round(w / 2.2));
    for (let i = 0; i < seg; i++) {
      const t = (i + 0.5) / seg - 0.5;
      const door = opts.door !== false && i === (seg >> 1);
      // Front wall, with the doorway left open above head height only.
      this._b(r + t * w, f - d * 0.5, door ? h - 0.35 : h * 0.5,
        w / seg * 0.5, door ? 0.35 : h * 0.5, 0.12, wall, o);
      this._b(r + t * w, f + d * 0.5, h * 0.5, w / seg * 0.5, h * 0.5, 0.12, wall, o);
    }
    const segd = Math.max(2, Math.round(d / 2.2));
    for (let i = 0; i < segd; i++) {
      const t = (i + 0.5) / segd - 0.5;
      this._b(r - w * 0.5, f + t * d, h * 0.5, 0.12, h * 0.5, d / segd * 0.5, wall, o);
      this._b(r + w * 0.5, f + t * d, h * 0.5, 0.12, h * 0.5, d / segd * 0.5, wall, o);
    }
    if (roof) {
      if (opts.pitched) {
        const steps = 3;
        for (let i = 0; i < steps; i++) {
          const k = (i + 0.5) / steps;
          this._b(r, f, h + 0.12 + k * Math.min(w, d) * 0.28,
            w * 0.5 * (1 - k * 0.9) + 0.2, Math.min(w, d) * 0.28 / steps * 0.55, d * 0.5 + 0.2,
            roof, { building: b, structural: true });
        }
      } else {
        this._b(r, f, h + 0.12, w * 0.5 + 0.2, 0.12, d * 0.5 + 0.2, roof,
          { building: b, structural: true });
      }
    }
    return b;
  }

  /** A run of posts and rails. Cheap, and it says "someone farmed here". */
  _fence(r0, f0, r1, f1, mat = 'wood') {
    const n = Math.max(2, Math.round(Math.hypot(r1 - r0, f1 - f0) / 2.4));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const r = r0 + (r1 - r0) * t;
      const f = f0 + (f1 - f0) * t;
      // Weathered fences lose posts; a complete one reads as maintained.
      if (this.rng.next() < 0.14) continue;
      this._b(r, f, 0.62, 0.06, 0.62, 0.06, mat, { collide: false, hpScale: 0.4 });
    }
    const mr = (r0 + r1) * 0.5, mf = (f0 + f1) * 0.5;
    const len = Math.hypot(r1 - r0, f1 - f0) * 0.5;
    const ang = Math.atan2(f1 - f0, r1 - r0);
    for (const y of [0.5, 0.95]) {
      this._piece(this._wx(mr, mf), this.base + y, this._wz(mr, mf),
        len, 0.045, 0.045, this.site.yaw + ang, mat, { collide: false, hpScale: 0.3 });
    }
  }

  /** A tapered stack of boxes: towers, chimneys, headframes. */
  _tower(r, f, h, r0, r1, mat, steps = 5) {
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const rr = lerp(r0, r1, (t0 + t1) * 0.5);
      this._b(r, f, h * (t0 + t1) * 0.5, rr, h / steps * 0.5, rr, mat,
        { structural: i === steps - 1 });
    }
  }

  /* ----------------------------------------------------------- the places */

  _farmstead() {
    const rng = this.rng;
    this._box(-6, 0, 8, 7, 3.0, rng.next() < 0.5 ? 'plaster' : 'brick', 'tile', { pitched: true });
    this._barn(8, 2, 8, 11, 4.4);
    // Yard, trough, and the fields the oracle already painted furrows on.
    this._fence(-14, -12, 18, -12);
    this._fence(18, -12, 18, 14);
    this._fence(-14, 14, 18, 14);
    this._b(2, -8, 0.4, 1.6, 0.4, 0.5, 'concrete', { hpScale: 2 });
    for (let i = 0; i < 4; i++) {
      this._b(12 + i * 0.9, -6, 0.55, 0.4, 0.55, 0.4, 'metal', { hpScale: 0.6 });
    }
    if (rng.next() < 0.6) {
      this.civ.spawnVehicle(this._wx(4, -4), this._wz(4, -4), this.site.yaw + 1.2,
        rng.next() < 0.5 ? 'truck' : 'van', this, { derelict: true });
    }
  }

  _barn(r, f, w, d, h) {
    const b = this._box(r, f, w, d, h, 'siding', null, { door: false });
    // Open front and a big pitched roof: the silhouette of every barn.
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const k = (i + 0.5) / steps;
      this._b(r, f, h + 0.1 + k * w * 0.34, w * 0.5 * (1 - k * 0.92) + 0.25,
        w * 0.34 / steps * 0.6, d * 0.5 + 0.3, 'metal', { building: b, structural: true });
    }
    for (let i = 0; i < 5; i++) {
      this._b(r - w * 0.3 + i * 0.5, f + d * 0.25, 0.5, 0.24, 0.5, 0.9, 'thatch',
        { building: b, hpScale: 0.5 });
    }
  }

  _windmill() {
    this._tower(0, 0, 9, 2.4, 1.5, 'plaster', 6);
    this._b(0, 0, 9.6, 1.7, 0.6, 1.7, 'slate', { structural: true });
    // Sails on a hub that still turns in the wind, because a still windmill
    // reads as scenery and a turning one reads as a place.
    const hub = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 10.5, 0.16), this.civ.sailMat);
    const arm2 = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.9, 0.16), this.civ.sailMat);
    hub.add(arm, arm2);
    hub.position.set(this._wx(0, -2.0), this.base + 9.2, this._wz(0, -2.0));
    hub.rotation.y = this.site.yaw;
    this.group.add(hub);
    this.animated.push((dt) => {
      hub.rotation.z += dt * (0.15 + this.world.weather.wind * 0.55);
    });
  }

  _lighthouse() {
    this._tower(0, 0, 16, 2.6, 1.5, 'plaster', 8);
    // Red band, because every lighthouse has one and it is what makes it read
    // as a lighthouse from three kilometres out.
    this._b(0, 0, 9, 1.95, 1.4, 1.95, 'redpaint');
    this._b(0, 0, 17.2, 1.7, 0.14, 1.7, 'metal', { structural: true });
    this._b(0, 0, 18.6, 1.25, 1.25, 1.25, 'glass', { collide: false });
    this._b(0, 0, 20.2, 1.5, 0.3, 1.5, 'metal', { structural: true });
    this._box(4.5, 3.5, 5, 5, 2.6, 'plaster', 'slate', { pitched: true });
    // A lamp that still turns. Nobody is left to have switched it off.
    const lamp = { x: this._wx(0, 0), y: this.base + 18.6, z: this._wz(0, 0), on: true, beacon: true };
    this.lamps.push(lamp);
    this.civ.lamps.push(lamp);
  }

  _fishingHut() {
    // On stilts, because it is standing where the tide comes in.
    for (const [r, f] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) {
      this._b(r, f, 0.7, 0.16, 0.9, 0.16, 'wood');
    }
    this._b(0, 0, 1.6, 3.0, 0.12, 3.0, 'wood', { structural: true });
    const b = this._box(0, 0, 5, 5, 2.4, 'timber', 'thatch', { pitched: true });
    for (const p of b.pieces) p.y += 1.7;
    for (const p of b.pieces) if (p.collider) { p.collider.y = p.y; }
    for (let i = 0; i < 3; i++) {
      this._b(-5 - i * 1.6, 3 + i, 1.3, 0.08, 1.3, 0.08, 'wood', { collide: false });
    }
    this._b(-5, 4, 1.1, 1.4, 0.02, 1.0, 'cloth', { collide: false, hpScale: 0.3 });
  }

  _jetty() {
    const len = 22;
    for (let i = 0; i < len; i += 2) {
      const wl = this.world.terrain.waterAt(this._wx(0, i), this._wz(0, i));
      const y = wl > -Infinity ? wl - this.base : 0.2;
      this._b(-1.4, i, y - 0.8, 0.14, 1.2, 0.14, 'wood', { collide: false });
      this._b(1.4, i, y - 0.8, 0.14, 1.2, 0.14, 'wood', { collide: false });
      this._b(0, i + 0.5, y + 0.25, 1.6, 0.09, 1.0, 'wood', { structural: false });
    }
    if (this.rng.next() < 0.7) {
      this.civ.spawnVehicle(this._wx(3.2, len - 4), this._wz(3.2, len - 4),
        this.site.yaw, 'boat', this);
    }
  }

  _harbour() {
    // A quay wall, bollards, a crane and something still tied up alongside.
    for (let i = -5; i <= 5; i++) {
      this._b(i * 3, 0, 0.9, 1.5, 1.2, 4, 'concrete', { hpScale: 3 });
      if (i % 2 === 0) this._b(i * 3, 3.2, 2.4, 0.24, 0.45, 0.24, 'rust');
    }
    this._tower(-12, 1, 9, 0.7, 0.5, 'rust', 5);
    this._b(-12, 4.5, 9.4, 0.4, 0.35, 4.2, 'rust', { structural: true });
    this._box(9, 6, 7, 6, 3.2, 'metal', 'metal');
    for (let i = 0; i < 6; i++) {
      this._b(2 + (i % 3) * 2.6, 6 + Math.floor(i / 3) * 2.6, 1.2, 1.2, 1.2, 1.2, 'rust',
        { hpScale: 1.4 });
    }
    for (let k = 0; k < 2; k++) {
      this.civ.spawnVehicle(this._wx(-4 + k * 8, -6), this._wz(-4 + k * 8, -6),
        this.site.yaw + Math.PI * 0.5, 'boat', this);
    }
  }

  _shipwreck() {
    // A hull broken across its back, canted over and half buried.
    const heel = 0.42 + this.rng.next() * 0.5;
    const L = 26;
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const f = -L * 0.5 + t * L;
      const beam = 3.4 * Math.sin(0.25 + t * 2.6);
      const p = this._b(0, f, 1.6 + Math.sin(t * 3.1) * 0.3, beam, 1.8, L / 9 * 0.55,
        'rust', { hpScale: 3 });
      p.roll = heel;
      p.pitch = t > 0.55 ? 0.28 : 0;
    }
    // Superstructure and a mast that fell where it fell.
    const sup = this._b(0, 2, 4.4, 2.4, 1.6, 3.0, 'rust', { hpScale: 2 });
    sup.roll = heel;
    const mast = this._b(2.6, 1, 4.0, 0.22, 5.5, 0.22, 'rust', { collide: false });
    mast.roll = heel + 0.5;
    for (let i = 0; i < 5; i++) {
      const rr = this.rng;
      this._b(rr.float(-9, 9), rr.float(-16, 16), 0.5, 0.8, 0.5, 0.8, 'rust',
        { hpScale: 1.2, collide: false });
    }
  }

  _watchtower() {
    this._tower(0, 0, 8, 2.0, 1.6, 'stone', 5);
    this._b(0, 0, 8.3, 2.4, 0.2, 2.4, 'stone', { structural: true });
    for (const [r, f] of [[0, 2.2], [0, -2.2], [2.2, 0], [-2.2, 0]]) {
      this._b(r, f, 9.0, r ? 0.2 : 2.4, 0.7, f ? 0.2 : 2.4, 'stone');
    }
  }

  _chapel() {
    // Roofless: three walls standing, a gable, and the fourth in the grass.
    const w = 6, d = 11, h = 4.2;
    for (let i = 0; i < 5; i++) {
      const t = (i + 0.5) / 5 - 0.5;
      this._b(-w * 0.5, t * d, h * 0.5 * (0.6 + this.rng.next() * 0.6), 0.3, h * 0.5, d / 10, 'stone', { hpScale: 2 });
      if (i !== 2) this._b(w * 0.5, t * d, h * 0.5 * (0.5 + this.rng.next() * 0.7), 0.3, h * 0.5, d / 10, 'stone', { hpScale: 2 });
    }
    this._b(0, -d * 0.5, h * 0.6, w * 0.5, h * 0.6, 0.3, 'stone', { hpScale: 2 });
    this._tower(0, -d * 0.5, 9, 1.5, 1.2, 'stone', 5);
    for (let i = 0; i < 6; i++) {
      const rr = this.rng;
      this._b(rr.float(-6, 6), rr.float(-8, 8), 0.3, 0.5, 0.3, 0.4, 'stone',
        { collide: false, hpScale: 1.5 });
    }
  }

  _stoneCircle() {
    const n = 7 + this.rng.int(0, 6);
    const R = 7 + this.rng.next() * 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = Math.cos(a) * R, f = Math.sin(a) * R;
      const h = 1.2 + this.rng.next() * 1.6;
      const p = this._piece(this._wx(r, f), this._gy(r, f) + h * 0.85, this._wz(r, f),
        0.5, h, 0.28, this.site.yaw + a, 'darkstone', { hpScale: 6 });
      // A few have gone over in three thousand years.
      if (this.rng.next() < 0.25) p.roll = this.rng.float(-1.4, 1.4);
    }
  }

  _quarry() {
    // Cut benches into one side, spoil on the other, and the plant that
    // worked it left where it stopped.
    for (let i = 0; i < 4; i++) {
      this._b(0, -6 - i * 5, -1.2 - i * 1.6, 12 - i, 1.4, 2.4, 'stone', { hpScale: 4 });
    }
    for (let i = 0; i < 7; i++) {
      const rr = this.rng;
      this._b(rr.float(-12, 12), rr.float(2, 14), 0.6, rr.float(0.6, 1.8), 0.7, rr.float(0.6, 1.8),
        'stone', { hpScale: 2 });
    }
    this._box(11, 8, 5, 4, 2.6, 'rust', 'rust');
    this._tower(-8, 6, 6, 0.9, 0.7, 'rust', 4);
    if (this.rng.next() < 0.7) {
      this.civ.spawnVehicle(this._wx(2, 8), this._wz(2, 8), this.site.yaw,
        this.rng.next() < 0.5 ? 'bulldozer' : 'truck', this, { derelict: true });
    }
  }

  _mine() {
    // A headframe over a shaft, a winding house, and a spoil heap.
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const t = i / 4;
        this._b(s * (2.2 - t * 1.4), -2.2 + t * 1.4, 2.5 + t * 5, 0.2, 2.5, 0.2, 'rust',
          { collide: i === 0 });
      }
    }
    this._b(0, 0, 11.5, 2.4, 0.24, 2.4, 'rust', { structural: true });
    this._b(0, 0, 12.4, 1.1, 0.9, 0.3, 'rust', { collide: false });
    this._box(7, 3, 6, 5, 3.0, 'brick', 'metal');
    for (let i = 0; i < 6; i++) {
      const rr = this.rng;
      this._b(rr.float(-16, -8), rr.float(-8, 8), 1.0, 2.2, 1.2, 2.2, 'stone', { hpScale: 3 });
    }
  }

  _mast() {
    const H = 26;
    for (let i = 0; i < 9; i++) {
      const t = i / 9;
      this._b(0, 0, H * (t + 0.5 / 9), 0.55 * (1 - t * 0.6), H / 18, 0.55 * (1 - t * 0.6),
        'rust', { collide: i === 0, structural: i === 8 });
    }
    // Guy wires, as three thin leaning struts. They read from a long way off.
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const r = Math.cos(a) * 12, f = Math.sin(a) * 12;
      const p = this._b(r * 0.5, f * 0.5, H * 0.4, 0.06, H * 0.45, 0.06, 'metal', { collide: false });
      p.roll = Math.atan2(r, H * 0.8) * (Math.cos(a) >= 0 ? 1 : -1);
      p.pitch = Math.atan2(f, H * 0.8);
    }
    this._box(6, 4, 4, 4, 2.6, 'concrete', 'metal');
  }

  _fort() {
    // Mud brick, square, corner towers, one gate. Desert forts are all the
    // same because the same thing works.
    const R = 13;
    for (const side of [0, 1, 2, 3]) {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        let r, f, hr, hf;
        if (side === 0) { r = t * R * 2; f = -R; hr = R / n; hf = 0.5; }
        else if (side === 1) { r = R; f = t * R * 2; hr = 0.5; hf = R / n; }
        else if (side === 2) { r = t * R * 2; f = R; hr = R / n; hf = 0.5; }
        else { r = -R; f = t * R * 2; hr = 0.5; hf = R / n; }
        // Leave a gate in the front wall.
        if (side === 0 && i >= 3 && i <= 4) continue;
        this._b(r, f, 2.2, hr, 2.2, hf, 'mudbrick', { hpScale: 2 });
      }
    }
    for (const [r, f] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
      this._tower(r, f, 6.5, 1.8, 1.5, 'mudbrick', 4);
    }
    this._box(0, 5, 8, 6, 3.0, 'mudbrick', 'mudbrick');
    this._well(-6, 6);
  }

  _temple() {
    // A stepped platform with a doorway and a stand of columns, all of it
    // half swallowed. The jungle scatter grows right up to the stones.
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      this._b(0, 0, 0.9 + i * 1.7, 11 - i * 2.1, 0.85, 11 - i * 2.1, 'darkstone',
        { hpScale: 5, structural: false });
    }
    this._b(0, 0, 9.4, 3.6, 1.6, 3.6, 'darkstone', { hpScale: 5 });
    this._b(0, -3.4, 8.6, 1.0, 1.4, 0.5, 'stone', { hpScale: 3 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = Math.cos(a) * 13.5, f = Math.sin(a) * 13.5;
      const h = this.rng.next() < 0.3 ? 1.2 : 3.4; // some have come down
      this._piece(this._wx(r, f), this._gy(r, f) + h, this._wz(r, f), 0.55, h, 0.55,
        this.site.yaw, 'darkstone', { hpScale: 4 });
    }
  }

  _research() {
    // A module on legs so the drift blows under it, an antenna, fuel drums,
    // and a tracked vehicle nobody came back for.
    for (const [r, f] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) {
      this._b(r, f, 0.7, 0.22, 0.9, 0.22, 'metal');
    }
    const b = this._box(0, 0, 10, 7, 2.8, 'paint', 'metal');
    for (const p of b.pieces) { p.y += 1.6; if (p.collider) p.collider.y = p.y; }
    this._b(0, 0, 6.2, 1.4, 0.1, 1.4, 'metal', { collide: false });
    this._tower(7, 2, 8, 0.24, 0.18, 'metal', 4);
    for (let i = 0; i < 6; i++) {
      this._b(-8 + (i % 3) * 1.1, 5 + Math.floor(i / 3) * 1.1, 0.45, 0.45, 0.45, 0.45,
        'rust', { hpScale: 0.8 });
    }
    if (this.rng.next() < 0.6) {
      this.civ.spawnVehicle(this._wx(-9, -4), this._wz(-9, -4), this.site.yaw + 0.7,
        'truck', this, { derelict: true });
    }
  }

  _airstrip() {
    // A graded strip, a windsock, a hangar - and an aeroplane with fuel in it.
    const L = 110, W = 9;
    for (let i = -L / 2; i < L / 2; i += 10) {
      this._b(0, i + 5, -0.04, W * 0.5, 0.08, 5, 'concrete', { collide: false, hpScale: 99 });
    }
    for (let i = -L / 2; i < L / 2; i += 20) {
      this._b(W * 0.5 + 1.5, i + 10, 0.25, 0.2, 0.25, 0.2, 'paint', { collide: false });
      this._b(-W * 0.5 - 1.5, i + 10, 0.25, 0.2, 0.25, 0.2, 'paint', { collide: false });
    }
    this._b(W + 6, -L * 0.3, 3.2, 0.12, 3.2, 0.12, 'metal');
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.4, 7, 1, true), this.civ.sockMat);
    sock.rotation.z = -Math.PI * 0.5;
    sock.position.set(this._wx(W + 7.2, -L * 0.3), this.base + 6.1, this._wz(W + 7.2, -L * 0.3));
    this.group.add(sock);
    this.animated.push((dt) => {
      const w = this.world.weather;
      sock.rotation.y = Math.atan2(w.windDir.x, w.windDir.y);
      sock.scale.z = 0.35 + Math.min(1, w.wind) * 0.65;
    });

    // Hangar: an open arch of metal, tall enough to taxi into.
    const hb = { x: this._wx(W + 18, 0), z: this._wz(W + 18, 0), yaw: this.site.yaw, pieces: [], district: this };
    this.buildings.push(hb);
    for (let i = 0; i < 7; i++) {
      const t = (i + 0.5) / 7;
      const a = t * Math.PI;
      this._b(W + 18 - Math.cos(a) * 8, 0, Math.sin(a) * 7 + 0.3, 1.4, 0.9, 7,
        'metal', { building: hb, structural: i > 1 && i < 5 });
    }
    this._b(W + 18, 7.2, 3.5, 8.2, 3.5, 0.2, 'metal', { building: hb });

    this.civ.spawnVehicle(this._wx(0, -L * 0.36), this._wz(0, -L * 0.36),
      this.site.yaw, 'plane', this);
    if (this.rng.next() < 0.5) {
      this.civ.spawnVehicle(this._wx(W + 14, -14), this._wz(W + 14, -14),
        this.site.yaw + 1.5, 'van', this, { derelict: true });
    }
  }

  _planeWreck() {
    // A fuselage broken behind the wing, one wing folded under, the other out
    // in the grass, and a scatter of panels between them.
    const roll = this.rng.float(-0.7, 0.7);
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const p = this._b(0, -6 + t * 12, 1.1 + t * 0.35, 1.1 - t * 0.5, 1.1 - t * 0.45, 1.1,
        'paint', { hpScale: 2 });
      p.roll = roll;
      if (t > 0.6) p.pitch = 0.35;
    }
    const w1 = this._b(-5.5, -1, 0.7, 5.5, 0.22, 1.6, 'paint', { hpScale: 1.5 });
    w1.roll = roll + 0.5;
    const w2 = this._b(7.5, -3.5, 0.35, 5.0, 0.22, 1.5, 'paint', { hpScale: 1.5 });
    w2.roll = this.rng.float(-1.2, 1.2);
    const tail = this._b(0, 6.6, 2.6, 0.2, 1.8, 1.2, 'paint', { hpScale: 1.2 });
    tail.roll = roll;
    for (let i = 0; i < 7; i++) {
      const rr = this.rng;
      this._b(rr.float(-11, 11), rr.float(-11, 11), 0.2, rr.float(0.3, 1.0), 0.12, rr.float(0.3, 1.0),
        'paint', { collide: false, hpScale: 0.6 });
    }
  }

  _cabin() {
    this._box(0, 0, 6, 5, 2.6, 'timber', 'wood', { pitched: true });
    this._b(2.2, 1.6, 4.4, 0.35, 1.2, 0.35, 'stone', { hpScale: 2 });
    for (let i = 0; i < 8; i++) {
      this._b(-4.6, -2 + (i % 4) * 0.55, 0.25 + Math.floor(i / 4) * 0.5, 0.9, 0.24, 0.24,
        'wood', { collide: false, hpScale: 0.4 });
    }
    this._b(4.5, -3, 0.35, 0.5, 0.35, 0.5, 'stone', { hpScale: 2 });
  }

  _camp() {
    const rng = this.rng;
    const n = 2 + rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = Math.cos(a) * 4.5, f = Math.sin(a) * 4.5;
      // A tent is two leaning panels; a collapsed one is a heap.
      const down = rng.next() < 0.35;
      if (down) {
        this._b(r, f, 0.2, 1.3, 0.2, 1.6, 'canvas', { collide: false });
      } else {
        for (const s of [-1, 1]) {
          const p = this._b(r + s * 0.55, f, 0.85, 0.1, 1.05, 1.5, 'canvas', { hpScale: 0.6 });
          p.roll = s * 0.5;
        }
      }
    }
    // A fire ring, long cold.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      this._b(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0.12, 0.2, 0.12, 0.2, 'stone',
        { collide: false, hpScale: 2 });
    }
    for (let i = 0; i < 3; i++) {
      this._b(rng.float(-6, 6), rng.float(-6, 6), 0.35, 0.45, 0.35, 0.45, 'wood', { hpScale: 0.7 });
    }
  }

  _waterTower() {
    for (const [r, f] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) {
      this._b(r, f, 5, 0.2, 5, 0.2, 'rust');
    }
    this._b(0, 0, 10.2, 3.0, 0.16, 3.0, 'rust', { structural: true });
    this._b(0, 0, 12.4, 2.7, 2.1, 2.7, 'rust', { structural: true, hpScale: 2 });
    this._b(0, 0, 14.8, 2.9, 0.35, 2.9, 'rust', { collide: false });
  }

  _well(r = 0, f = 0) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this._piece(this._wx(r + Math.cos(a) * 1.2, f + Math.sin(a) * 1.2), this.base + 0.55,
        this._wz(r + Math.cos(a) * 1.2, f + Math.sin(a) * 1.2),
        0.5, 0.55, 0.28, this.site.yaw + a, 'stone', { hpScale: 3 });
    }
    this._b(r - 1.3, f, 2.2, 0.12, 1.6, 0.12, 'wood');
    this._b(r + 1.3, f, 2.2, 0.12, 1.6, 0.12, 'wood');
    this._b(r, f, 3.7, 1.5, 0.12, 0.3, 'wood', { structural: true });
    this._b(r, f, 3.0, 0.22, 0.25, 0.22, 'metal', { collide: false });
  }

  _train() {
    // A locomotive and whatever it was pulling, stopped on the line.
    const n = 2 + this.rng.int(0, 4);
    this._b(0, 0, 1.9, 1.5, 1.5, 5.0, 'darkstone', { hpScale: 4 });
    this._b(0, -2.0, 4.0, 1.2, 0.7, 2.2, 'darkstone', { hpScale: 3 });
    this._b(0, -3.2, 5.2, 0.35, 0.6, 0.35, 'rust', { collide: false });
    for (let i = 1; i <= n; i++) {
      const f = i * 12.5;
      this._b(0, f, 2.2, 1.5, 1.7, 5.6, i % 2 ? 'rust' : 'paint', { hpScale: 3 });
      this._b(0, f, 0.55, 1.6, 0.35, 5.8, 'rust', { collide: false });
    }
  }

  _ruin() {
    // Four broken walls and not much else - the commonest thing left standing.
    const rng = this.rng;
    const w = 5 + rng.next() * 4, d = 5 + rng.next() * 5;
    const mat = this.site.biome === BIOME.RAINFOREST || this.site.biome === BIOME.KARST
      ? 'darkstone' : this.site.biome === BIOME.DESERT || this.site.biome === BIOME.DUNES
        ? 'mudbrick' : 'stone';
    for (let side = 0; side < 4; side++) {
      const n = 4;
      for (let i = 0; i < n; i++) {
        if (rng.next() < 0.3) continue;
        const t = (i + 0.5) / n - 0.5;
        const h = 0.6 + rng.next() * 1.8;
        if (side < 2) this._b(t * w, (side ? 1 : -1) * d * 0.5, h * 0.5, w / n * 0.5, h * 0.5, 0.25, mat, { hpScale: 2 });
        else this._b((side === 2 ? 1 : -1) * w * 0.5, t * d, h * 0.5, 0.25, h * 0.5, d / n * 0.5, mat, { hpScale: 2 });
      }
    }
    for (let i = 0; i < 5; i++) {
      this._b(rng.float(-w, w), rng.float(-d, d), 0.2, rng.float(0.3, 0.8), 0.2, rng.float(0.3, 0.8),
        mat, { collide: false, hpScale: 1.5 });
    }
  }
}

/* ================================================================ vehicles */

const VEHICLE_SPECS = {
  car: { w: 1.86, l: 4.3, h: 0.72, wheel: 0.34, mass: 1300, power: 17, top: 41, blade: false, seats: 1, fuel: 45 },
  van: { w: 2.0, l: 5.2, h: 1.05, wheel: 0.38, mass: 2100, power: 15, top: 33, blade: false, seats: 1, fuel: 70 },
  truck: { w: 2.4, l: 7.4, h: 1.35, wheel: 0.52, mass: 7000, power: 14, top: 28, blade: false, seats: 1, fuel: 160 },
  bulldozer: { w: 2.9, l: 5.6, h: 1.3, wheel: 0.62, mass: 15000, power: 20, top: 16, blade: true, seats: 1, fuel: 120 },
};

const CAR_COLOURS = [
  [0.34, 0.045, 0.045], [0.045, 0.09, 0.28], [0.72, 0.70, 0.66], [0.045, 0.048, 0.052],
  [0.10, 0.22, 0.13], [0.55, 0.50, 0.16], [0.30, 0.30, 0.32], [0.42, 0.22, 0.05],
];

class Vehicle {
  constructor(civ, x, z, yaw, kind, district, opts = {}) {
    this.civ = civ;
    this.world = civ.world;
    this.kind = kind;
    // Subclasses that are not cars (aircraft, boats) substitute their own.
    this.spec = this._initSpec() || VEHICLE_SPECS[kind] || VEHICLE_SPECS.car;
    this.district = district;
    this.derelict = !!opts.derelict;
    this.position = new THREE.Vector3(x, this.world.terrain.heightAt(x, z) + this.spec.wheel, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.engineOn = false;
    this.alive = true;
    this.hp = this.spec.mass * 0.012;
    this.hp0 = this.hp;
    // Something abandoned out in the country has been standing for years:
    // the tank is all but dry and the body is rusted through.
    this.tank = new Substance('petrol',
      this.spec.fuel * (this.derelict ? Math.random() * 0.10 : 0.15 + Math.random() * 0.85), 15);
    if (this.derelict) this.hp *= 0.45;
    this.burning = false;
    this.burnT = 0;
    this.camPos = new THREE.Vector3();
    this.bladeDown = kind === 'bulldozer';
    this.colour = CAR_COLOURS[Math.floor(Math.random() * CAR_COLOURS.length)];
    if (this.derelict) {
      // Sun-bleached and gone to rust.
      this.colour = this.colour.map((c) => c * 0.55 + 0.03);
    }
    this._build();
    this.collider = new Collider(x, this.position.y + this.spec.h, z,
      this.spec.w * 0.5, this.spec.h, this.spec.l * 0.5, yaw, { vehicle: this });
    this.world.physics.add(this.collider);
    this._scratch = [];
  }

  _build() {
    const s = this.spec;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.l), this.civ.bodyMat.clone());
    body.material.color.setRGB(this.colour[0], this.colour[1], this.colour[2]);
    body.position.y = s.wheel + s.h * 0.5;
    body.castShadow = true;
    g.add(body);
    this.bodyMesh = body;

    if (this.kind === 'bulldozer') {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(s.w * 0.66, 1.25, s.l * 0.32), this.civ.bodyMat.clone());
      cab.material.color.setRGB(this.colour[0] * 0.8, this.colour[1] * 0.8, this.colour[2] * 0.8);
      cab.position.set(0, s.wheel + s.h + 0.62, -s.l * 0.1);
      cab.castShadow = true;
      g.add(cab);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(s.w * 1.22, 1.5, 0.36), this.civ.metalMat);
      blade.position.set(0, s.wheel + 0.66, s.l * 0.56);
      blade.castShadow = true;
      g.add(blade);
      this.blade = blade;
    } else {
      const cabH = s.h * (this.kind === 'car' ? 0.78 : 0.9);
      const cab = new THREE.Mesh(
        new THREE.BoxGeometry(s.w * 0.9, cabH, s.l * (this.kind === 'car' ? 0.46 : 0.30)),
        this.civ.glassMat
      );
      cab.position.set(0, s.wheel + s.h + cabH * 0.5 - 0.05, this.kind === 'car' ? -s.l * 0.03 : s.l * 0.30);
      g.add(cab);
      this.cabMesh = cab;
      if (this.kind !== 'car') {
        const box = new THREE.Mesh(new THREE.BoxGeometry(s.w * 0.98, s.h * 1.25, s.l * 0.56), this.civ.bodyMat.clone());
        box.material.color.setRGB(0.42, 0.41, 0.39);
        box.position.set(0, s.wheel + s.h * 1.1, -s.l * 0.2);
        box.castShadow = true;
        g.add(box);
      }
    }

    // Wheels.
    this.wheelMeshes = [];
    const wheelGeo = new THREE.CylinderGeometry(s.wheel, s.wheel, s.w * 0.16, 9);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [ox, oz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const wm = new THREE.Mesh(wheelGeo, this.civ.tyreMat);
      wm.position.set(ox * s.w * 0.5, s.wheel, oz * s.l * 0.33);
      wm.castShadow = true;
      g.add(wm);
      this.wheelMeshes.push(wm);
    }

    // Headlights.
    this.lightL = new THREE.SpotLight(0xfff2d0, 0, 60, 0.62, 0.45, 1.2);
    this.lightL.position.set(-s.w * 0.32, s.wheel + s.h * 0.6, s.l * 0.5);
    this.lightTarget = new THREE.Object3D();
    this.lightTarget.position.set(0, -0.4, 22);
    g.add(this.lightTarget);
    this.lightL.target = this.lightTarget;
    g.add(this.lightL);

    g.position.copy(this.position);
    g.rotation.y = this.yaw;
    this.group = g;
    this.world.engine.scene.add(g);
    if (this.district) this.district.group.add ? null : null;
  }

  driveInput(input, dt) {
    if (!input) return;
    const s = this.spec;
    const ax = input.axes(AXES);
    this.throttle = ax.y;
    this.brake = input.down('Space') ? 1 : 0;
    const steerTarget = -ax.x;
    this.steer = lerp(this.steer, steerTarget, 1 - Math.exp(-dt * 7));
    if (!this.engineOn && Math.abs(this.throttle) > 0.05) this.start();
    if (input.hit('KeyB') && this.blade) this.bladeDown = !this.bladeDown;
    if (input.hit('KeyH') && this.world.audio) this.world.audio.horn(this.position);
  }

  /** Overridden by aircraft and boats, which are not cars. */
  _initSpec() { return null; }

  /** The line the interaction prompt shows while you are at the controls. */
  readout() {
    return `${(Math.abs(this.speed) * 3.6).toFixed(0)} km/h · fuel ${this.tank.litres.toFixed(0)}L`;
  }

  /** What the prompt says you can do once you are in it. */
  controls() {
    return `<kbd>F</kbd> step out · <kbd>W/S</kbd> drive · <kbd>Space</kbd> brake`
      + `${this.blade ? ' · <kbd>B</kbd> blade' : ''} · <kbd>H</kbd> horn`;
  }

  start() {
    if (this.tank.litres <= 0.1) return false;
    this.engineOn = true;
    if (this.world.audio) this.world.audio.engineStart(this);
    return true;
  }

  update(dt) {
    if (!this.alive) return;
    const s = this.spec;
    const terrain = this.world.terrain;
    const driven = this.world.player.vehicle === this;

    if (!driven) {
      this.throttle = 0;
      this.steer = 0;
      this.brake = this.speed > 0.2 ? 0.6 : 1;
    }

    /* --- longitudinal ------------------------------------------------- */
    if (this.engineOn && this.tank.litres > 0.02) {
      const drive = this.throttle * s.power * (1 - Math.abs(this.speed) / (s.top * 1.25));
      this.speed += drive * dt;
      this.tank.litres = Math.max(0, this.tank.litres - Math.abs(this.throttle) * dt * 0.014);
      if (this.tank.litres <= 0.02) {
        this.engineOn = false;
        if (this.world.audio) this.world.audio.engineStop(this);
      }
    }
    const rollDrag = Math.exp(-dt * (0.6 + this.brake * 5.5));
    this.speed *= rollDrag;
    if (Math.abs(this.speed) < 0.04) this.speed = 0;
    this.speed = clamp(this.speed, -s.top * 0.35, s.top);

    /* --- steering ----------------------------------------------------- */
    const turn = this.steer * clamp(Math.abs(this.speed) / 7, 0, 1) * (this.speed >= 0 ? 1 : -1);
    this.yaw += turn * dt * (this.kind === 'bulldozer' ? 1.5 : 1.25);

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const nx = this.position.x + fx * this.speed * dt;
    const nz = this.position.z + fz * this.speed * dt;

    /* --- terrain following via four wheel probes ---------------------- */
    let sum = 0;
    let frontY = 0, backY = 0, leftY = 0, rightY = 0;
    const hw = s.w * 0.5, hl = s.l * 0.33;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (let i = 0; i < 4; i++) {
      const ox = (i % 2 === 0 ? -1 : 1) * hw;
      const oz = (i < 2 ? 1 : -1) * hl;
      const wx = nx + ox * c + oz * sn;
      const wz = nz - ox * sn + oz * c;
      const h = terrain.heightAt(wx, wz);
      sum += h;
      if (i < 2) frontY += h * 0.5; else backY += h * 0.5;
      if (i % 2 === 0) leftY += h * 0.5; else rightY += h * 0.5;
    }
    const groundY = sum * 0.25;

    // Water stops an engine dead.
    const wl = terrain.waterAt(nx, nz);
    if (wl > groundY + s.wheel * 1.4) {
      if (this.engineOn) {
        this.engineOn = false;
        this.world.particles.steam(nx, wl, nz, 2, 10);
        if (this.world.audio) this.world.audio.engineStop(this);
      }
      this.speed *= Math.exp(-dt * 3);
    }

    this.position.set(nx, groundY + s.wheel, nz);
    this.pitch = lerp(this.pitch, Math.atan2(backY - frontY, hl * 2), 1 - Math.exp(-dt * 9));
    this.roll = lerp(this.roll, Math.atan2(rightY - leftY, hw * 2), 1 - Math.exp(-dt * 9));

    /* --- hitting things ----------------------------------------------- */
    if (Math.abs(this.speed) > 1.2) this._collide(dt);

    /* --- pose --------------------------------------------------------- */
    this.group.position.copy(this.position);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    const spin = this.speed * dt / Math.max(0.1, s.wheel);
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const wm = this.wheelMeshes[i];
      wm.rotation.x += spin;
      if (i < 2) wm.rotation.y = this.steer * 0.5;
    }
    if (this.blade) this.blade.position.y = s.wheel + (this.bladeDown ? 0.42 : 1.3);

    // Headlights come on in the dark.
    const dark = 1 - this.world.sky.dayFactor;
    this.lightL.intensity = this.engineOn ? dark * 340 : 0;

    // Update its collider so the player can stand on it and walk round it.
    this.collider.x = this.position.x;
    this.collider.y = this.position.y + s.h * 0.9;
    this.collider.z = this.position.z;
    this.collider.yaw = this.yaw;
    this.collider.cos = Math.cos(-this.yaw);
    this.collider.sin = Math.sin(-this.yaw);

    // Camera from the driver's seat.
    const camY = this.position.y + s.wheel + s.h + (this.kind === 'bulldozer' ? 1.25 : 0.42);
    this.camPos.set(this.position.x - fx * s.l * 0.06, camY, this.position.z - fz * s.l * 0.06);

    if (driven) {
      if (Math.random() < dt * 4) {
        this.world.particles.dust(
          this.position.x - fx * s.l * 0.5, this.position.y, this.position.z - fz * s.l * 0.5,
          1, Math.min(1.4, Math.abs(this.speed) * 0.06)
        );
      }
    }

    /* --- fire and fuel ------------------------------------------------- */
    const heat = this.world.fire.heatAt(this.position.x, this.position.y + 0.5, this.position.z);
    this.tank.temp += (heat - this.tank.temp) * clamp(dt * 0.25, 0, 1);
    if (!this.burning && this.tank.litres > 0.5 && this.tank.temp > MATERIAL.petrol.ignite) {
      this.burning = true;
      this.world.fire.ignite(this.position.x, this.position.y + 0.6, this.position.z, 1.6, 2.4);
    }
    if (this.burning) {
      this.burnT += dt;
      this.world.particles.smoke(this.position.x, this.position.y + 1.4, this.position.z, 1.8, 0.85, 1);
      if (this.burnT > 3.5 + Math.random() * 4) this.explode();
    }
  }

  _collide(dt) {
    const s = this.spec;
    const phys = this.world.physics;
    const near = phys.query(this.position.x, this.position.z, s.l * 0.7 + 1.6, this._scratch);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const noseX = this.position.x + fx * s.l * 0.52;
    const noseZ = this.position.z + fz * s.l * 0.52;
    const heavy = this.kind === 'bulldozer' || this.kind === 'truck';
    for (const col of near) {
      if (col === this.collider || !col.alive) continue;
      const p = col.data;
      const dx = col.x - noseX;
      const dz = col.z - noseZ;
      const dist = Math.hypot(dx, dz);
      if (dist > Math.max(col.hx, col.hz) + s.w * 0.6) continue;
      if (col.y - col.hy > this.position.y + s.h * 2.2) continue;
      if (col.y + col.hy < this.position.y - 0.2) continue;

      if (p && p.vehicle) {
        const other = p.vehicle;
        const push = this.speed * 0.4;
        other.speed += push;
        this.speed *= 0.4;
        if (this.world.audio) this.world.audio.impact(noseX, this.position.y, noseZ, 'metal', 0.9);
        this.damage(Math.abs(push) * 2);
        other.damage(Math.abs(push) * 2);
        continue;
      }
      if (p && p.mat) {
        // A building piece. Heavy vehicles and blades go straight through.
        const energy = Math.abs(this.speed) * (heavy ? 34 : 9);
        const bladeBoost = this.blade && this.bladeDown ? 3.2 : 1;
        const destroyed = p.building && p.building.district
          ? p.building.district.damagePiece(p, energy * bladeBoost, [fx * energy, 12, fz * energy])
          : this._districtOf(p).damagePiece(p, energy * bladeBoost, [fx * energy, 12, fz * energy]);
        if (destroyed) {
          this.speed *= heavy ? 0.97 : 0.55;
          this.damage(heavy ? 0.4 : 6);
        } else {
          this.speed *= 0.35;
          this.damage(Math.abs(this.speed) * 1.4);
        }
      }
    }
  }

  _districtOf(piece) {
    for (const d of this.civ.districts.values()) {
      if (d.pieces.indexOf(piece) >= 0) return d;
    }
    for (const o of this.civ.outposts.values()) {
      if (o.pieces.indexOf(piece) >= 0) return o;
    }
    return this.district || { damagePiece: () => false };
  }

  damage(amount) {
    this.hp -= amount;
    if (this.hp <= 0 && this.alive) {
      if (this.tank.litres > 2 && Math.random() < 0.6) this.explode();
      else {
        this.burning = true;
        this.burnT = 0;
      }
    }
  }

  explode() {
    if (!this.alive) return;
    this.alive = false;
    const p = this.position;
    const power = 0.7 + clamp(this.tank.litres / 60, 0, 1.6);
    if (this.world.player.vehicle === this) {
      this.world.player.vehicle = null;
      this.world.player.position.set(p.x, p.y + 1, p.z);
    }
    // Throw the vehicle's own panels around.
    for (let i = 0; i < 12; i++) {
      const b = this.world.physics.spawnDebris(
        p.x + (Math.random() - 0.5) * 1.6, p.y + Math.random() * 1.4, p.z + (Math.random() - 0.5) * 2.6,
        0.3 + Math.random() * 0.5, 0.1 + Math.random() * 0.2, 0.3 + Math.random() * 0.6,
        [this.colour[0] * 0.5, this.colour[1] * 0.5, this.colour[2] * 0.5], { kind: 'metal', bounce: 0.3 }
      );
      this.world.physics.impulse(b, (Math.random() - 0.5) * 700, 380 + Math.random() * 460, (Math.random() - 0.5) * 700);
    }
    this.civ.removeVehicle(this);
    this.world.physics.explode(p.x, p.y + 0.6, p.z, power, 8 + power * 5);
    this.world.wildlife.startle(p.x, p.z, 90);
  }

  dispose() {
    if (this.collider) this.world.physics.remove(this.collider);
    if (this.world.audio) this.world.audio.engineStop(this);
    this.world.engine.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== this.civ.bodyMat && o.material.dispose && o.material.__clone) o.material.dispose();
    });
    this.alive = false;
  }
}


/* ================================================================ aircraft */

// Numbers a light single actually has, because guessing them is what made the
// first version climb to eight kilometres in thirty seconds. Stall 22 m/s
// (80 km/h), cruise about 55 (200 km/h), and a thrust of 3.5 m/s² - which gets
// it off a hundred-metre strip in six seconds and no faster.
const AIR_SPECS = {
  plane: {
    span: 11.0, len: 7.4, h: 0.85, wheel: 0.32, mass: 780,
    thrust: 3.5, drag: 0.00116, stall: 22, top: 62, fuel: 90,
  },
};

/**
 * A light aeroplane, flown rather than driven.
 *
 * The model is deliberately forgiving: thrust along the nose, lift with the
 * square of airspeed, and a stall speed you have to get above on the runway
 * before the wheels leave the ground. That is enough to make taking off feel
 * earned and landing feel like a skill, without asking anyone to read a manual.
 */
class Aircraft extends Vehicle {
  constructor(civ, x, z, yaw, kind, district, opts) {
    super(civ, x, z, yaw, 'plane', district, opts);
  }

  _initSpec() {
    const a = AIR_SPECS.plane;
    this.air = a;
    // Set here rather than after super(), because driveInput can run before
    // the first update and lerping from undefined poisons the whole model.
    this.elevator = 0;
    this.aileron = 0;
    this.power = 0;
    this.vy = 0;
    // The base Vehicle wants these; the flight model uses `air`.
    return { w: a.span * 0.25, l: a.len, h: a.h, wheel: a.wheel, mass: a.mass,
      power: a.thrust, top: a.top, blade: false, seats: 1, fuel: a.fuel };
  }

  _build() {
    const a = this.air;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.15, a.len), this.civ.bodyMat.clone());
    body.material.color.setRGB(this.colour[0], this.colour[1], this.colour[2]);
    body.position.y = a.wheel + 0.85;
    body.castShadow = true;
    g.add(body);
    this.bodyMesh = body;

    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.62, 1.9), this.civ.glassMat);
    cab.position.set(0, a.wheel + 1.62, 0.5);
    g.add(cab);
    this.cabMesh = cab;

    const wing = new THREE.Mesh(new THREE.BoxGeometry(a.span, 0.16, 1.55), this.civ.bodyMat.clone());
    wing.material.color.setRGB(this.colour[0] * 0.9, this.colour[1] * 0.9, this.colour[2] * 0.9);
    wing.position.set(0, a.wheel + 1.42, 0.35);
    wing.castShadow = true;
    g.add(wing);

    const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(a.span * 0.36, 0.12, 0.8), wing.material);
    tailPlane.position.set(0, a.wheel + 1.25, -a.len * 0.46);
    g.add(tailPlane);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.25, 1.0), wing.material);
    fin.position.set(0, a.wheel + 1.85, -a.len * 0.46);
    g.add(fin);

    // A propeller disc: two crossed blades, spun by the engine.
    const prop = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.4, 0.05), this.civ.tyreMat);
    const blade2 = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.05), this.civ.tyreMat);
    prop.add(blade, blade2);
    prop.position.set(0, a.wheel + 0.9, a.len * 0.52);
    g.add(prop);
    this.prop = prop;

    this.wheelMeshes = [];
    const wheelGeo = new THREE.CylinderGeometry(a.wheel, a.wheel, 0.2, 8);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [ox, oz] of [[-1.5, 0.4], [1.5, 0.4], [0, -a.len * 0.42]]) {
      const wm = new THREE.Mesh(wheelGeo, this.civ.tyreMat);
      wm.position.set(ox, a.wheel, oz);
      wm.castShadow = true;
      g.add(wm);
      this.wheelMeshes.push(wm);
    }

    this.lightL = new THREE.SpotLight(0xfff2d0, 0, 120, 0.5, 0.5, 1.2);
    this.lightL.position.set(0, a.wheel + 1.0, a.len * 0.5);
    this.lightTarget = new THREE.Object3D();
    this.lightTarget.position.set(0, -0.2, 40);
    g.add(this.lightTarget);
    this.lightL.target = this.lightTarget;
    g.add(this.lightL);

    g.position.copy(this.position);
    g.rotation.y = this.yaw;
    this.group = g;
    this.world.engine.scene.add(g);
  }

  driveInput(input, dt) {
    if (!input) return;
    const ax = input.axes(AXES);
    // Stick: forward is nose down, and that is the way round every flight
    // sim has done it since 1980.
    this.elevator = lerp(this.elevator, -ax.y, 1 - Math.exp(-dt * 6));
    this.aileron = lerp(this.aileron, ax.x, 1 - Math.exp(-dt * 6));
    if (input.down('ShiftLeft') || input.down('ShiftRight')) this.power = clamp(this.power + dt * 0.7, 0, 1);
    if (input.down('ControlLeft') || input.down('KeyC')) this.power = clamp(this.power - dt * 0.7, 0, 1);
    this.brake = input.down('Space') ? 1 : 0;
    if (this.power > 0.02 && !this.engineOn) this.start();
    if (input.hit('KeyH') && this.world.audio) this.world.audio.horn(this.position);
  }

  update(dt) {
    if (!this.alive) return;
    const a = this.air;
    const terrain = this.world.terrain;
    const driven = this.world.player.vehicle === this;
    if (!driven) {
      this.power *= Math.exp(-dt * 1.5);
      this.elevator = 0;
      this.aileron = 0;
    }

    /* --- engine ------------------------------------------------------- */
    if (this.engineOn && this.tank.litres > 0.02) {
      this.tank.litres = Math.max(0, this.tank.litres - this.power * dt * 0.02);
      if (this.tank.litres <= 0.02) {
        this.engineOn = false;
        if (this.world.audio) this.world.audio.engineStop(this);
      }
    } else {
      this.power = Math.min(this.power, 0.0);
    }

    const gy = terrain.heightAt(this.position.x, this.position.z);
    const alt = this.position.y - gy;
    const wasAirborne = alt > a.wheel + 0.6;
    this.onGround = !wasAirborne;

    /* --- longitudinal -------------------------------------------------- */
    const thrust = this.engineOn ? this.power * a.thrust : 0;
    // Climbing costs speed and diving buys it, which is the whole feel of it.
    const gravAlong = -Math.sin(this.pitch) * 9.81;
    const drag = a.drag * this.speed * Math.abs(this.speed);
    this.speed += (thrust + gravAlong - drag) * dt;
    if (this.onGround) {
      // Rolling resistance, not a parachute. At 0.35 the wheels held it to
      // ten metres a second and it could never reach rotation speed.
      this.speed *= Math.exp(-dt * (0.04 + this.brake * 2.5));
      if (this.speed < 0) this.speed = 0;
    }
    this.speed = clamp(this.speed, -4, a.top);

    /* --- attitude ------------------------------------------------------ */
    // Control authority comes from airspeed: on a standing start the stick
    // does nothing, which is exactly right.
    const q = clamp(this.speed / a.stall, 0, 1.6);
    if (this.onGround && this.speed < a.stall * 0.6) {
      this.roll = lerp(this.roll, 0, 1 - Math.exp(-dt * 4));
      this.pitch = lerp(this.pitch, 0, 1 - Math.exp(-dt * 4));
      this.yaw += this.aileron * dt * 0.9 * Math.min(1, this.speed / 6);
    } else {
      this.roll = clamp(this.roll + this.aileron * dt * 1.4 * q, -1.25, 1.25);
      this.pitch = clamp(this.pitch + this.elevator * dt * 0.55 * q, -0.95, 0.95);
      // Banking turns the nose: no rudder, just the horizontal lift component.
      this.yaw -= Math.sin(this.roll) * dt * 0.85 * q;
      // It trims itself back toward level, so it flies hands-off - and the
      // balance between these rates and the ones above is what a given stick
      // deflection settles at. A gentle nudge has to mean a gentle climb, or
      // full power buys you twenty degrees nose-up and no airspeed at all.
      this.roll = lerp(this.roll, 0, 1 - Math.exp(-dt * 0.9));
      this.pitch = lerp(this.pitch, 0, 1 - Math.exp(-dt * 0.6));
    }

    /* --- lift ----------------------------------------------------------- */
    // Either the wing carries the aeroplane or it does not. Above stall speed
    // it does, and where you go is simply where the nose points; below it the
    // support falls away with the square of airspeed and you sink. Banking
    // spills lift sideways, so a hard turn costs height - which is the one
    // piece of real aerodynamics worth having in the model.
    const support = clamp(
      (this.speed * this.speed) / (a.stall * a.stall) * Math.cos(this.roll), 0, 1);
    const sink = (1 - support) * 12;
    let vy = Math.sin(this.pitch) * this.speed - sink;
    // On the ground the wheels are holding it up, so an unsupported wing just
    // means it stays put rather than accumulating a landing impact per frame.
    if (this.onGround && vy < 0) vy = 0;
    this.vy = vy;

    const fx = Math.sin(this.yaw) * Math.cos(this.pitch);
    const fz = Math.cos(this.yaw) * Math.cos(this.pitch);
    this.position.x += fx * this.speed * dt;
    this.position.z += fz * this.speed * dt;
    this.position.y += this.vy * dt;

    /* --- the ground ------------------------------------------------------ */
    const ngy = terrain.heightAt(this.position.x, this.position.z);
    const wl = terrain.waterAt(this.position.x, this.position.z);
    const floor = Math.max(ngy, wl > -Infinity ? wl : -Infinity) + a.wheel;
    if (this.position.y <= floor) {
      // Only arriving from the air counts as arriving.
      const impact = wasAirborne ? Math.max(0, -vy) : 0;
      this.position.y = floor;
      this.vy = 0;
      // Arriving fast, steeply or on one wing is a crash, not a landing.
      const rough = impact > 9 || Math.abs(this.roll) > 0.45 || Math.abs(this.pitch) > 0.42;
      if (rough && this.speed > 8) {
        this.damage(impact * 4 + Math.abs(this.roll) * 30);
        this.world.particles.dust(this.position.x, this.position.y, this.position.z, 6, 2);
        this.speed *= 0.35;
        this.roll = 0;
        this.pitch = 0;
      }
      if (wl > ngy + 0.4) {
        // Ditching: the engine drowns and it stops very quickly.
        if (this.engineOn) {
          this.engineOn = false;
          this.world.particles.steam(this.position.x, wl, this.position.z, 3, 12);
          if (this.world.audio) this.world.audio.engineStop(this);
        }
        this.speed *= Math.exp(-dt * 2.5);
      }
    }

    /* --- pose ------------------------------------------------------------ */
    this.group.position.copy(this.position);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    if (this.prop) this.prop.rotation.z += dt * (this.engineOn ? 30 + this.power * 60 : 2);
    for (const wm of this.wheelMeshes) wm.rotation.x += this.speed * dt / a.wheel;
    const dark = 1 - this.world.sky.dayFactor;
    this.lightL.intensity = this.engineOn ? dark * 500 : 0;

    this.collider.x = this.position.x;
    this.collider.y = this.position.y + 1;
    this.collider.z = this.position.z;
    this.collider.yaw = this.yaw;
    this.collider.cos = Math.cos(-this.yaw);
    this.collider.sin = Math.sin(-this.yaw);

    this.camPos.set(this.position.x, this.position.y + a.wheel + 1.35, this.position.z);

    /* --- fire and fuel ---------------------------------------------------- */
    const heat = this.world.fire.heatAt(this.position.x, this.position.y + 0.5, this.position.z);
    this.tank.temp += (heat - this.tank.temp) * clamp(dt * 0.25, 0, 1);
    if (!this.burning && this.tank.litres > 0.5 && this.tank.temp > MATERIAL.petrol.ignite) {
      this.burning = true;
      this.world.fire.ignite(this.position.x, this.position.y + 0.6, this.position.z, 1.6, 2.4);
    }
    if (this.burning) {
      this.burnT += dt;
      this.world.particles.smoke(this.position.x, this.position.y + 1.4, this.position.z, 1.8, 0.85, 1);
      if (this.burnT > 3.5 + Math.random() * 4) this.explode();
    }
  }

  controls() {
    return `<kbd>F</kbd> get out · <kbd>Shift/C</kbd> throttle · <kbd>W/S</kbd> nose`
      + ` · <kbd>A/D</kbd> bank · <kbd>Space</kbd> brake`;
  }

  /** Airspeed and altitude, for the interaction prompt. */
  readout() {
    const gy = this.world.terrain.heightAt(this.position.x, this.position.z);
    return `${(this.speed * 3.6).toFixed(0)} km/h · ${(this.position.y - gy).toFixed(0)} m agl · `
      + `throttle ${(this.power * 100).toFixed(0)}% · fuel ${this.tank.litres.toFixed(0)}L`;
  }
}

/* =================================================================== boats */

const BOAT_SPEC = { w: 2.4, l: 6.4, h: 0.9, wheel: 0.0, mass: 1800, power: 9, top: 15, blade: false, seats: 1, fuel: 60 };

/** A small launch. Floats, and refuses to go anywhere on dry land. */
class Boat extends Vehicle {
  constructor(civ, x, z, yaw, kind, district, opts) {
    super(civ, x, z, yaw, 'boat', district, opts);
  }

  _initSpec() { return BOAT_SPEC; }

  _build() {
    const s = this.spec;
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.l), this.civ.bodyMat.clone());
    hull.material.color.setRGB(this.colour[0], this.colour[1], this.colour[2]);
    hull.position.y = s.h * 0.2;
    hull.castShadow = true;
    g.add(hull);
    this.bodyMesh = hull;
    const bow = new THREE.Mesh(new THREE.BoxGeometry(s.w * 0.5, s.h * 0.9, s.l * 0.28), hull.material);
    bow.position.set(0, s.h * 0.25, s.l * 0.5);
    g.add(bow);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(s.w * 0.7, 1.1, s.l * 0.3), this.civ.glassMat);
    cabin.position.set(0, s.h * 0.7 + 0.55, -s.l * 0.12);
    g.add(cabin);
    this.cabMesh = cabin;
    this.wheelMeshes = [];
    this.lightL = new THREE.SpotLight(0xfff2d0, 0, 70, 0.6, 0.5, 1.2);
    this.lightL.position.set(0, s.h + 1.2, s.l * 0.4);
    this.lightTarget = new THREE.Object3D();
    this.lightTarget.position.set(0, -0.3, 25);
    g.add(this.lightTarget);
    this.lightL.target = this.lightTarget;
    g.add(this.lightL);
    g.position.copy(this.position);
    g.rotation.y = this.yaw;
    this.group = g;
    this.world.engine.scene.add(g);
  }

  update(dt) {
    if (!this.alive) return;
    const s = this.spec;
    const w = this.world;
    const driven = w.player.vehicle === this;
    if (!driven) { this.throttle = 0; this.steer = 0; }

    if (this.engineOn && this.tank.litres > 0.02) {
      this.speed += this.throttle * s.power * (1 - Math.abs(this.speed) / (s.top * 1.2)) * dt;
      this.tank.litres = Math.max(0, this.tank.litres - Math.abs(this.throttle) * dt * 0.012);
      if (this.tank.litres <= 0.02) {
        this.engineOn = false;
        if (w.audio) w.audio.engineStop(this);
      }
    }
    // Water drags far harder than tarmac, and a hull carries no brakes.
    this.speed *= Math.exp(-dt * (0.9 + this.brake * 1.4));
    if (Math.abs(this.speed) < 0.05) this.speed = 0;
    this.speed = clamp(this.speed, -s.top * 0.4, s.top);
    this.yaw += this.steer * clamp(Math.abs(this.speed) / 4, 0, 1) * (this.speed >= 0 ? 1 : -1) * dt * 1.0;

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let nx = this.position.x + fx * this.speed * dt;
    let nz = this.position.z + fz * this.speed * dt;
    const gy = w.terrain.heightAt(nx, nz);
    const wl = w.terrain.waterAt(nx, nz);
    if (wl === -Infinity || wl < gy + 0.6) {
      // Aground. Stop where the water stopped rather than sailing up a beach.
      nx = this.position.x;
      nz = this.position.z;
      this.speed *= 0.2;
    }
    const level = w.terrain.waterAt(nx, nz);
    const surf = level > -Infinity ? level + w.waveHeightAt(nx, nz) : gy;
    this.position.set(nx, surf, nz);
    // Ride the swell: pitch with the wave in front of the bow.
    const ahead = w.waveHeightAt(nx + fx * s.l * 0.5, nz + fz * s.l * 0.5);
    this.pitch = lerp(this.pitch, clamp((surf - (level > -Infinity ? level : gy) - ahead) * 0.4, -0.3, 0.3), 1 - Math.exp(-dt * 4));
    this.roll = lerp(this.roll, -this.steer * clamp(this.speed / s.top, 0, 1) * 0.35, 1 - Math.exp(-dt * 3));

    this.group.position.copy(this.position);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    if (driven && Math.abs(this.speed) > 1.5 && Math.random() < dt * 8) {
      w.particles.steam(nx - fx * s.l * 0.5, this.position.y + 0.2, nz - fz * s.l * 0.5, 0.6, 1.2);
    }
    const dark = 1 - w.sky.dayFactor;
    this.lightL.intensity = this.engineOn ? dark * 220 : 0;

    this.collider.x = nx;
    this.collider.y = this.position.y + s.h;
    this.collider.z = nz;
    this.collider.yaw = this.yaw;
    this.collider.cos = Math.cos(-this.yaw);
    this.collider.sin = Math.sin(-this.yaw);
    this.camPos.set(nx - fx * 0.4, this.position.y + s.h + 1.3, nz - fz * 0.4);
  }

  controls() {
    return `<kbd>F</kbd> step off · <kbd>W/S</kbd> throttle · <kbd>A/D</kbd> steer`;
  }

  readout() {
    return `${(Math.abs(this.speed) * 3.6).toFixed(0)} km/h · fuel ${this.tank.litres.toFixed(0)}L`;
  }
}


/* ==================================================================== ways */

/**
 * The linear infrastructure between settlements: railway track, the telegraph
 * poles that follow a made road, and the vehicles left standing on both.
 *
 * All of it is rebuilt into one mesh whenever you have moved far enough to
 * matter, rather than streamed per chunk - a road is a line, not a tile, and
 * chunking a line means either seams or a lot of bookkeeping for no gain.
 */
class Ways {
  constructor(civ) {
    this.civ = civ;
    this.world = civ.world;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.world.engine.scene.add(this.group);
    this.mesh = null;
    this.lastX = Infinity;
    this.lastZ = Infinity;
    this.trains = new Set();
  }

  update(dt, player) {
    const px = player.position.x;
    const pz = player.position.z;
    if (Math.hypot(px - this.lastX, pz - this.lastZ) < 140) return;
    this.lastX = px;
    this.lastZ = pz;
    this._rebuild(px, pz);
  }

  _rebuild(px, pz) {
    const terrain = this.world.terrain;
    const { roads, rails } = this.world.wg.waysNear(px, pz, 620);
    const B = new Bars();

    for (const r of rails) {
      this._alongSegment(r, px, pz, 520, (x, z, dx, dz) => {
        const y = terrain.heightAt(x, z) + 0.16;
        const nx = -dz, nz = dx;
        // Two rails and a sleeper. Anything further than a couple of hundred
        // metres is a pair of lines on the ballast the ground already painted.
        B.bar(x + nx * 0.72, y + 0.10, z + nz * 0.72, 0.07, 0.09, 1.4, dx, dz, RAIL_COL);
        B.bar(x - nx * 0.72, y + 0.10, z - nz * 0.72, 0.07, 0.09, 1.4, dx, dz, RAIL_COL);
        if (Math.hypot(x - px, z - pz) < 190) {
          B.bar(x, y - 0.03, z, 1.30, 0.06, 0.16, dx, dz, SLEEPER_COL);
        }
      }, 1.35);
    }

    // Telegraph poles follow a made road; a dirt track never had a line on it.
    for (const r of roads) {
      if (r.surface < SURFACE.GRAVEL) continue;
      this._alongSegment(r, px, pz, 480, (x, z, dx, dz) => {
        const nx = -dz, nz = dx;
        const ox = x + nx * (r.w + 3.5);
        const oz = z + nz * (r.w + 3.5);
        const y = terrain.heightAt(ox, oz);
        if (y < 0.5) return; // no poles standing in the sea
        B.bar(ox, y + 3.6, oz, 0.11, 3.6, 0.11, 1, 0, POLE_COL);
        B.bar(ox, y + 6.9, oz, 0.9, 0.06, 0.06, dx, dz, POLE_COL);
        B.bar(ox, y + 6.4, oz, 0.7, 0.05, 0.05, dx, dz, POLE_COL);
      }, 42);
    }

    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const geo = B.geometry();
    if (geo) {
      const m = new THREE.Mesh(geo, this.civ.railMat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.mesh = m;
    }

    // Something stopped on the line, and something that came off the road.
    this._streamStock(rails, px, pz);
    this._streamWrecks(roads, px, pz);
  }

  /** Walk a segment at a fixed spacing, but only the part that is near. */
  _alongSegment(r, px, pz, range, fn, step) {
    const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
    if (len < 1) return;
    const dx = (r.bx - r.ax) / len;
    const dz = (r.bz - r.az) / len;
    // Clamp to the stretch within range of the player, so a ten-kilometre
    // link between two towns costs the same as a short one.
    const t0 = (px - r.ax) * dx + (pz - r.az) * dz;
    const from = Math.max(0, t0 - range);
    const to = Math.min(len, t0 + range);
    for (let d = from; d < to; d += step) {
      fn(r.ax + dx * d, r.az + dz * d, dx, dz);
    }
  }

  /** Abandoned rolling stock, at deterministic points along the track. */
  _streamStock(rails, px, pz) {
    const want = new Set();
    for (const r of rails) {
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      const dx = (r.bx - r.ax) / len;
      const dz = (r.bz - r.az) / len;
      for (let d = 400; d < len; d += 900) {
        const x = r.ax + dx * d;
        const z = r.az + dz * d;
        if (hash3f(x | 0, z | 0, 0x7a11) > 0.32) continue;
        if (Math.hypot(x - px, z - pz) > 480) continue;
        const key = `${x | 0}_${z | 0}`;
        want.add(key);
        if (this.trains.has(key)) continue;
        const site = {
          i: x | 0, j: z | 0, kind: SITE.TRAIN, x, z,
          h: this.world.terrain.heightAt(x, z), biome: 0,
          radius: 40, name: SITE_INFO[SITE.TRAIN].name,
          yaw: Math.atan2(dz, dx) + Math.PI * 0.5,
          seed: hash3i(x | 0, z | 0, 0x51ab) >>> 0, pad: false,
        };
        const o = new Outpost(this.civ, site);
        o.build();
        this.civ.outposts.set('T' + key, o);
        this.trains.add(key);
      }
    }
    for (const key of [...this.trains]) {
      if (want.has(key)) continue;
      const o = this.civ.outposts.get('T' + key);
      if (o) {
        o.dispose();
        this.civ.outposts.delete('T' + key);
      }
      this.trains.delete(key);
    }
  }

  /** A handful of cars that never finished their journey. */
  _streamWrecks(roads, px, pz) {
    let live = 0;
    for (const v of this.civ.vehicles) if (v.roadside) live++;
    for (const r of roads) {
      if (live >= 4) break;
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      const dx = (r.bx - r.ax) / len;
      const dz = (r.bz - r.az) / len;
      for (let d = 200; d < len; d += 640) {
        const x = r.ax + dx * d;
        const z = r.az + dz * d;
        const h = hash3f(x | 0, z | 0, 0x3c0d);
        if (h > 0.30) continue;
        const dist = Math.hypot(x - px, z - pz);
        if (dist > 330 || dist < 12) continue;
        let taken = false;
        for (const v of this.civ.vehicles) {
          if (Math.hypot(v.position.x - x, v.position.z - z) < 8) { taken = true; break; }
        }
        if (taken) continue;
        const kind = h < 0.16 ? 'car' : h < 0.24 ? 'van' : 'truck';
        const v = this.civ.spawnVehicle(x, z, Math.atan2(dz, dx) + h * 3, kind, null, { derelict: true });
        if (v) {
          v.roadside = true;
          live++;
        }
        if (live >= 4) break;
      }
    }
  }

  dispose() {
    if (this.mesh) this.mesh.geometry.dispose();
    this.world.engine.scene.remove(this.group);
  }
}

// Rusted rail head, creosoted sleeper, weathered pole. Linear reflectances.
const RAIL_COL = [0.145, 0.115, 0.098];
const SLEEPER_COL = [0.055, 0.042, 0.030];
const POLE_COL = [0.085, 0.060, 0.040];

/**
 * A tiny mesh builder for axis-aligned bars laid along a direction. Rails,
 * sleepers and telegraph poles are all the same primitive, and merging them
 * into one buffer is what keeps a whole railway to a single draw call.
 */
class Bars {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
  }

  bar(x, y, z, hw, hh, hl, dx, dz, col) {
    // hw across the direction of travel, hl along it.
    const ax = dx, az = dz;
    const bx = -dz, bz = dx;
    const base = this.pos.length / 3;
    for (const sy of [-1, 1]) {
      for (const sl of [-1, 1]) {
        for (const sw of [-1, 1]) {
          this.pos.push(
            x + bx * hw * sw + ax * hl * sl,
            y + hh * sy,
            z + bz * hw * sw + az * hl * sl
          );
          this.nrm.push(0, sy, 0);
          this.col.push(col[0], col[1], col[2]);
        }
      }
    }
    // 0..3 bottom, 4..7 top, in (l, w) order.
    const q = (a, b, c, d) => this.idx.push(base + a, base + b, base + c, base + a, base + c, base + d);
    q(4, 5, 7, 6);        // top
    q(2, 3, 1, 0);        // bottom
    q(0, 1, 5, 4);        // -l side
    q(3, 2, 6, 7);        // +l side
    q(1, 3, 7, 5);        // +w side
    q(2, 0, 4, 6);        // -w side
  }

  geometry() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** "a farmstead" / "an airstrip" - the note reads badly without it. */
function aOrAn(name) {
  return (/^[aeiou]/i.test(name) ? 'an ' : 'a ') + name;
}

/* ============================================================ the manager */

export class Civilisation {
  constructor(world) {
    this.world = world;
    this.districts = new Map();
    this.outposts = new Map();
    this.vehicles = [];
    this.lamps = [];
    this.doors = [];
    this.discovered = new Set();

    this.pieceMat = makeSolidMaterial({ key: 'piece', flat: true, roughness: 0.88, vertexColors: false });
    this.roadMat = makeSolidMaterial({ key: 'road', roughness: 0.62 });
    this.glassMat = makeSolidMaterial({
      key: 'glass', flat: false, roughness: 0.06, metalness: 0.0,
      transparent: true, opacity: 0.30, vertexColors: false, color: 0x9fc2cc,
    });
    this.bodyMat = makeSolidMaterial({ key: 'body', vertexColors: false, roughness: 0.34, metalness: 0.55 });
    this.metalMat = makeSolidMaterial({ key: 'metalv', vertexColors: false, color: 0xb8b3a4, roughness: 0.5, metalness: 0.7 });
    this.tyreMat = makeSolidMaterial({ key: 'tyre', vertexColors: false, color: 0x151517, roughness: 0.95 });
    this.doorMat = makeSolidMaterial({ key: 'door', vertexColors: false, color: 0x3a2617, roughness: 0.8 });
    this.sailMat = makeSolidMaterial({ key: 'sail', vertexColors: false, color: 0x8d7f66, roughness: 0.9, doubleSide: true });
    this.sockMat = makeSolidMaterial({ key: 'sock', vertexColors: false, color: 0xc4522a, roughness: 0.9, doubleSide: true });
    this.railMat = makeSolidMaterial({ key: 'rail', roughness: 0.72 });
    this.ways = new Ways(this);

    // A pool of real lights for street lamps near the player.
    this.lampLights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 26, 1.6);
      l.visible = false;
      world.engine.scene.add(l);
      this.lampLights.push(l);
    }
    this._scratch = [];
  }

  spawnVehicle(x, z, yaw, kind, owner, opts) {
    if (this.vehicles.length > 46) return null;
    const Cls = kind === 'plane' ? Aircraft : kind === 'boat' ? Boat : Vehicle;
    const v = new Cls(this, x, z, yaw, kind, owner, opts);
    this.vehicles.push(v);
    if (owner) owner.vehicles.push(v);
    return v;
  }

  removeVehicle(v) {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    if (v.district) {
      const j = v.district.vehicles.indexOf(v);
      if (j >= 0) v.district.vehicles.splice(j, 1);
    }
    v.dispose();
  }

  update(dt, player) {
    const px = player.position.x;
    const pz = player.position.z;

    // Stream districts in and out.
    const towns = this.world.wg.townsNear(px, pz, 2600);
    for (const t of towns) {
      const d = Math.hypot(t.x - px, t.z - pz);
      const key = t.i * 4194304 + t.j;
      let district = this.districts.get(key);
      if (d < t.radius + 620) {
        if (!district) {
          district = new District(this, t);
          this.districts.set(key, district);
          district.build();
          if (!this.discovered.has(key)) {
            this.discovered.add(key);
            this.world.note(`${t.name} — ${SETTLEMENT_INFO[t.kind].name}`, 'discovery');
            if (this.world.ui) this.world.ui.discovery(t.name, SETTLEMENT_INFO[t.kind].name);
          }
        }
      }
    }
    for (const [key, district] of this.districts) {
      const t = district.town;
      if (Math.hypot(t.x - px, t.z - pz) > t.radius + 1100) {
        district.dispose();
        this.districts.delete(key);
      }
    }

    // Outlying landmarks stream the same way, on a much shorter leash: there
    // are far more of them and each is far smaller.
    for (const site of this.world.wg.sitesNear(px, pz, 780)) {
      const key = site.i * 4194304 + site.j;
      if (this.outposts.has(key)) continue;
      const o = new Outpost(this, site);
      this.outposts.set(key, o);
      o.build();
      if (!this.discovered.has('s' + key)) {
        this.discovered.add('s' + key);
        this.world.note(`You found ${aOrAn(site.name)}.`, 'discovery');
      }
    }
    for (const [key, o] of this.outposts) {
      // Rolling stock is keyed by track position and owned by `ways`, which
      // does its own bookkeeping; culling it here would leave that stale.
      if (typeof key === 'string') continue;
      if (Math.hypot(o.site.x - px, o.site.z - pz) > 1100) {
        o.dispose();
        this.outposts.delete(key);
      }
    }
    for (const o of this.outposts.values()) o.update(dt);
    for (const d of this.districts.values()) d.update(dt);
    this.ways.update(dt, player);

    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const d = Math.hypot(v.position.x - px, v.position.z - pz);
      if (d > 1400 && this.world.player.vehicle !== v) {
        this.removeVehicle(v);
        continue;
      }
      v.update(dt);
    }

    // Doors swing.
    for (const door of this.doors) {
      if (Math.abs(door.open - door.target) > 0.002) {
        door.open = lerp(door.open, door.target, 1 - Math.exp(-dt * 6));
        door.mesh.rotation.y = door.yaw + door.open * 1.95;
      }
    }

    this._updateLamps(player);
  }

  _updateLamps(player) {
    const dark = 1 - this.world.sky.dayFactor;
    const on = dark > 0.32;
    const cands = [];
    for (const l of this.lamps) {
      const d = Math.hypot(l.x - player.position.x, l.z - player.position.z);
      // A lighthouse is worth seeing from a long way out; a street lamp is not.
      if (d < (l.beacon ? 900 : 70)) cands.push({ l, d: l.beacon ? d * 0.05 : d });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lampLights.length; i++) {
      const light = this.lampLights[i];
      const e = cands[i];
      if (!e || !on) {
        light.visible = false;
        continue;
      }
      light.visible = true;
      light.position.set(e.l.x, e.l.y, e.l.z);
      if (e.l.beacon) {
        // A slow sweep. It is the only light left turning anywhere.
        light.intensity = dark * 900 * (0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(performance.now() * 0.0012)), 6));
        continue;
      }
      // A dying grid: some lamps flicker, some have gone out for good.
      const seed = (e.l.x * 7.13 + e.l.z * 3.71) % 1;
      const flick = seed < 0.12
        ? (Math.sin(performance.now() * 0.02 + seed * 90) > 0.2 ? 1 : 0.1)
        : 1;
      light.intensity = dark * 210 * flick;
    }
  }

  /* --------------------------------------------------------- interactions */

  /** Fire reaching out from a burning point into the built world. */
  fireSpread(f, reach, windStr, wind) {
    const near = this.world.physics.query(f.x, f.z, reach + 2.5, this._scratch);
    for (const col of near) {
      const p = col.data;
      if (!p) continue;
      if (p.vehicle) continue; // vehicles handle their own fuel
      if (!p.alive || p.burning) continue;
      const m = MATERIAL[p.mat.mat];
      if (!m || !m.ignite) continue;
      const d = Math.hypot(col.x - f.x, col.z - f.z);
      const dot = d > 0.01 ? ((col.x - f.x) / d) * wind.x + ((col.z - f.z) / d) * wind.y : 0;
      const chance = (1 - smoothstep(f.radius * 0.4, reach + 2.5, d)) * (1 + Math.max(0, dot) * windStr * 2) * f.intensity * 0.5;
      if (Math.random() > chance) continue;
      p.burning = true;
      const district = p.building ? p.building.district : this._districtOfPiece(p);
      if (district) district._writePiece(p);
      this.world.fire.ignite(col.x, col.y, col.z, 0.8 + f.intensity * 0.4, 1.6 + Math.max(p.hx, p.hz));
      // Burning weakens it until it collapses.
      p.burnTimer = 6 + Math.random() * 12;
    }
  }

  _districtOfPiece(p) {
    for (const d of this.districts.values()) {
      if (d.pieces.indexOf(p) >= 0) return d;
    }
    for (const o of this.outposts.values()) {
      if (o.pieces.indexOf(p) >= 0) return o;
    }
    return null;
  }

  explosionDamage(x, y, z, power, radius) {
    const near = this.world.physics.query(x, z, radius * 1.5, this._scratch);
    for (const col of near) {
      const p = col.data;
      if (!p) continue;
      const dx = col.x - x, dy = col.y - y, dz = col.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius * 1.5) continue;
      if (p.vehicle) {
        p.vehicle.damage((1 - d / (radius * 1.5)) * power * 26);
        continue;
      }
      if (!p.alive) continue;
      const dmg = (1 - d / (radius * 1.5)) * power * 70;
      const district = p.building ? p.building.district : this._districtOfPiece(p);
      if (district) {
        const il = 1 / (d || 1);
        district.damagePiece(p, dmg, [dx * il * power * 90, 60 * power, dz * il * power * 90]);
      }
    }
  }

  /** Nearest vehicle you could climb into. */
  nearestVehicle(x, y, z, range = 3.4) {
    let best = null;
    let bd = range * range;
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      const d = (v.position.x - x) ** 2 + (v.position.y - y) ** 2 + (v.position.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  nearestDoor(x, y, z, range = 2.6) {
    let best = null;
    let bd = range * range;
    for (const d of this.doors) {
      const dd = (d.x - x) ** 2 + (d.y + 1 - y) ** 2 + (d.z - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  /** Damage a specific piece, from any source. Used by tools and impacts. */
  hitPiece(piece, amount, impulse) {
    const district = piece.building ? piece.building.district : this._districtOfPiece(piece);
    if (!district) return false;
    return district.damagePiece(piece, amount, impulse);
  }
}

const M4 = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const EUL = new THREE.Euler();
const TMPV = new THREE.Vector3();
const SCLV = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);
const AXES = { x: 0, y: 0 };

export { Vehicle, VEHICLE_SPECS };

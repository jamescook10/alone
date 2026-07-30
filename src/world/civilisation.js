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
import { SETTLEMENT, SETTLEMENT_INFO } from './worldgen.js';
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
};

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

/* ============================================================== districts */

class District {
  constructor(civ, town) {
    this.civ = civ;
    this.world = civ.world;
    this.town = town;
    this.pieces = [];
    this.colliders = [];
    this.vehicles = [];
    this.lamps = [];
    this.doors = [];
    this.built = false;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.buildings = [];
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
      // Street furniture.
      const lampStep = 26;
      for (let d = lampStep * 0.5; d < len; d += lampStep) {
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
          const centre = 1 - Math.abs(s);
          col.push(0.050, 0.050, 0.055);
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
    QUAT.setFromAxisAngle(UPV, p.yaw);
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
    for (const v of this.vehicles.slice()) this.civ.removeVehicle(v);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.world.engine.scene.remove(this.group);
    this.pieces.length = 0;
    this.built = false;
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
  constructor(civ, x, z, yaw, kind, district) {
    this.civ = civ;
    this.world = civ.world;
    this.kind = kind;
    this.spec = VEHICLE_SPECS[kind] || VEHICLE_SPECS.car;
    this.district = district;
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
    this.tank = new Substance('petrol', this.spec.fuel * (0.15 + Math.random() * 0.85), 15);
    this.burning = false;
    this.burnT = 0;
    this.camPos = new THREE.Vector3();
    this.bladeDown = kind === 'bulldozer';
    this.colour = CAR_COLOURS[Math.floor(Math.random() * CAR_COLOURS.length)];
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

/* ============================================================ the manager */

export class Civilisation {
  constructor(world) {
    this.world = world;
    this.districts = new Map();
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

  spawnVehicle(x, z, yaw, kind, district) {
    if (this.vehicles.length > 46) return null;
    const v = new Vehicle(this, x, z, yaw, kind, district);
    this.vehicles.push(v);
    if (district) district.vehicles.push(v);
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
      if (d < 70) cands.push({ l, d });
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
const TMPV = new THREE.Vector3();
const SCLV = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);
const AXES = { x: 0, y: 0 };

export { Vehicle, VEHICLE_SPECS };

// Terrain streaming.
//
// An infinite quadtree centred on the player. Nodes split as you approach and
// merge as you leave; leaves are meshed by a pool of workers and swapped in
// only once their geometry has arrived, so the horizon fills in smoothly
// instead of stuttering.

import * as THREE from 'three';
import { makeTerrainMaterial, makeWaterMaterial } from '../gfx/materials.js';
import { clamp } from '../core/noise.js';

export const ROOT_SIZE = 8192;
export const MIN_SIZE = 128;
export const MAX_DEPTH = Math.round(Math.log2(ROOT_SIZE / MIN_SIZE)); // 6
const RES_NEAR = 48; // quads per chunk edge, close in
const RES_FAR = 32;  // ...and further out, where nobody can tell
const SPLIT_K = 2.1; // distance in node-sizes at which a node splits
const ROOT_RADIUS = 2; // root cells kept around the player

export class Terrain {
  constructor(world) {
    this.world = world;
    this.wg = world.wg;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.waterGroup = new THREE.Group();
    this.waterGroup.matrixAutoUpdate = false;

    this.material = makeTerrainMaterial();
    this.waterMaterial = makeWaterMaterial();

    this.nodes = new Map(); // key -> node
    this.pending = new Map(); // id -> node
    this.nextId = 1;
    this.queue = [];
    this.ready = false;
    this.chunksLoaded = 0;

    this._initWorkers();

    // Height queries are cached on a lattice and interpolated: physics asks
    // for the ground height hundreds of times a frame.
    this._hCache = new Map();
    this._hOrder = [];
    this._sample = {};
  }

  _initWorkers() {
    const n = clamp((navigator.hardwareConcurrency || 4) - 1, 2, 6);
    this.workers = [];
    this.workerBusy = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onWorkerMessage(i, e.data);
      w.onerror = (e) => console.error('terrain worker', e.message || e);
      w.postMessage({ type: 'init', seed: this.wg.seed });
      this.workers.push(w);
      this.workerBusy.push(false);
    }
  }

  _onWorkerMessage(wi, msg) {
    if (msg.type === 'ready') return;
    this.workerBusy[wi] = false;
    if (msg.type === 'error') {
      console.error('terrain worker error', msg.message);
      this.pending.delete(msg.id);
      this._pump();
      return;
    }
    const node = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (node && !node.dead) this._applyChunk(node, msg);
    this.chunksLoaded++;
    this._pump();
  }

  /* -------------------------------------------------------------- meshing */

  _applyChunk(node, data) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setAttribute('aux', new THREE.BufferAttribute(data.aux, 2));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(data.size / 2, (data.minY + data.maxY) / 2, data.size / 2),
      Math.hypot(data.size, data.maxY - data.minY) * 0.75 + 8
    );

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(data.x0, 0, data.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = node.lod <= 1;
    mesh.renderOrder = 0;
    mesh.userData.node = node;
    node.mesh = mesh;
    node.minY = data.minY;
    node.maxY = data.maxY;
    this.group.add(mesh);

    if (data.water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(data.water.positions, 3));
      wg.setAttribute('flow', new THREE.BufferAttribute(data.water.flow, 2));
      wg.setAttribute('depth', new THREE.BufferAttribute(data.water.depth, 1));
      wg.setIndex(new THREE.BufferAttribute(data.water.indices, 1));
      wg.computeBoundingSphere();
      const wm = new THREE.Mesh(wg, this.waterMaterial);
      wm.position.set(data.x0, 0, data.z0);
      wm.matrixAutoUpdate = false;
      wm.updateMatrix();
      wm.renderOrder = 4;
      node.water = wm;
      this.waterGroup.add(wm);
    }

    if (data.scatter) {
      node.scatter = data.scatter;
      this.world.flora.onChunkLoaded(node, data.scatter);
    }
    node.loaded = true;
    node.fadeIn = 0;
    if (node.parent) node.parent.childrenLoaded++;
  }

  _dispose(node) {
    node.dead = true;
    if (node.mesh) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
    }
    if (node.water) {
      this.waterGroup.remove(node.water);
      node.water.geometry.dispose();
      node.water = null;
    }
    if (node.scatter) {
      this.world.flora.onChunkUnloaded(node);
      node.scatter = null;
    }
    if (node.children) {
      for (const c of node.children) this._dispose(c);
      node.children = null;
    }
    this.nodes.delete(node.key);
  }

  /* --------------------------------------------------------------- update */

  update(camPos) {
    // Roots form an infinite grid; only those near the player exist.
    const ri = Math.floor(camPos.x / ROOT_SIZE);
    const rj = Math.floor(camPos.z / ROOT_SIZE);
    const alive = new Set();
    for (let j = -ROOT_RADIUS; j <= ROOT_RADIUS; j++) {
      for (let i = -ROOT_RADIUS; i <= ROOT_RADIUS; i++) {
        const gi = ri + i;
        const gj = rj + j;
        const key = `${gi}_${gj}_r`;
        alive.add(key);
        let node = this.nodes.get(key);
        if (!node) {
          node = this._makeNode(gi * ROOT_SIZE, gj * ROOT_SIZE, ROOT_SIZE, MAX_DEPTH, null, key);
        }
        this._updateNode(node, camPos, alive);
      }
    }
    // Retire roots that fell outside the ring.
    for (const [key, node] of this.nodes) {
      if (node.isRoot && !alive.has(key)) this._dispose(node);
    }
    this._pump();
    if (!this.ready && this.chunksLoaded > 12) this.ready = true;
  }

  _makeNode(x, z, size, lod, parent, key) {
    const node = {
      key: key || `${x}_${z}_${size}`,
      x, z, size, lod,
      parent,
      isRoot: !parent,
      children: null,
      childrenLoaded: 0,
      mesh: null,
      water: null,
      scatter: null,
      loaded: false,
      requested: false,
      dead: false,
      minY: 0,
      maxY: 0,
    };
    this.nodes.set(node.key, node);
    return node;
  }

  _updateNode(node, camPos, alive) {
    alive.add(node.key);
    const cx = node.x + node.size / 2;
    const cz = node.z + node.size / 2;
    const dx = camPos.x - cx;
    const dz = camPos.z - cz;
    const dy = Math.max(0, Math.abs(camPos.y - (node.minY + node.maxY) / 2) - node.size);
    const d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.35);

    const wantSplit = node.lod > 0 && d < node.size * SPLIT_K;

    if (wantSplit) {
      if (!node.children) {
        const h = node.size / 2;
        node.children = [
          this._makeNode(node.x, node.z, h, node.lod - 1, node),
          this._makeNode(node.x + h, node.z, h, node.lod - 1, node),
          this._makeNode(node.x, node.z + h, h, node.lod - 1, node),
          this._makeNode(node.x + h, node.z + h, h, node.lod - 1, node),
        ];
        node.childrenLoaded = 0;
      }
      for (const c of node.children) this._updateNode(c, camPos, alive);
      // Keep our own mesh visible until every child has arrived - this is
      // what stops holes appearing in the ground while you walk.
      const allIn = node.children.every((c) => c.loaded || (c.children && c.childrenLoaded >= 4));
      if (allIn) {
        if (node.mesh) node.mesh.visible = false;
        if (node.water) node.water.visible = false;
        this.world.flora.setChunkVisible(node, false);
      } else {
        this._request(node);
        if (node.mesh) node.mesh.visible = true;
        if (node.water) node.water.visible = true;
        this.world.flora.setChunkVisible(node, true);
      }
    } else {
      if (node.children) {
        for (const c of node.children) this._dispose(c);
        node.children = null;
        node.childrenLoaded = 0;
      }
      this._request(node);
      if (node.mesh) node.mesh.visible = true;
      if (node.water) node.water.visible = true;
      this.world.flora.setChunkVisible(node, true);
    }
  }

  _request(node) {
    if (node.loaded || node.requested) return;
    node.requested = true;
    node.priority = node.lod;
    this.queue.push(node);
  }

  _pump() {
    if (!this.queue.length) return;
    // Nearest (lowest LOD index) first so the ground under your feet is
    // always the first thing to appear.
    this.queue.sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      if (this.workerBusy[i]) continue;
      let node = this.queue.shift();
      while (node && node.dead) node = this.queue.shift();
      if (!node) return;
      const id = this.nextId++;
      this.pending.set(id, node);
      this.workerBusy[i] = true;
      this.workers[i].postMessage({
        type: 'build',
        id,
        x0: node.x,
        z0: node.z,
        size: node.size,
        res: node.lod <= 2 ? RES_NEAR : RES_FAR,
        lod: node.lod,
        // Beyond a couple of kilometres the flat horizon plate takes over,
        // so there is no point meshing water out there.
        wantWater: node.lod <= 4,
        wantScatter: node.lod <= 1,
      });
    }
  }

  /* ------------------------------------------------------------- sampling */

  /** Cached, bilinearly interpolated ground height. */
  heightAt(x, z) {
    const G = 1.5;
    const gx = Math.floor(x / G);
    const gz = Math.floor(z / G);
    const fx = x / G - gx;
    const fz = z / G - gz;
    const h00 = this._gridH(gx, gz);
    const h10 = this._gridH(gx + 1, gz);
    const h01 = this._gridH(gx, gz + 1);
    const h11 = this._gridH(gx + 1, gz + 1);
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  _gridH(gx, gz) {
    const key = gx * 8388608 + gz;
    let v = this._hCache.get(key);
    if (v !== undefined) return v;
    v = this.wg.height(gx * 1.5, gz * 1.5);
    this._hCache.set(key, v);
    this._hOrder.push(key);
    if (this._hOrder.length > 65536) {
      const drop = this._hOrder.splice(0, 16384);
      for (const k of drop) this._hCache.delete(k);
    }
    return v;
  }

  /** Ground normal, from the cached height field. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** Full world sample (biome, climate, water) at a point. */
  sampleAt(x, z, out) {
    return this.wg.sample(x, z, out || this._sample);
  }

  /** Water surface height at a point, or -Infinity. */
  waterAt(x, z) {
    return this.wg.sample(x, z, this._sample).waterLevel;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
  }
}

// The landscape on the horizon.
//
// The streamed quadtree ends around twenty kilometres out, and beyond it the
// world used to stop dead: from a hilltop - and worse, from the aeroplane -
// mountain ranges were sliced off by nothing at all. This draws everything
// from the edge of the streamed terrain to the far plane as one silhouette
// ring: a polar mesh of quickSample()d heights, built in its own worker,
// re-centred only when the player has moved a kilometre or so. It shares the
// terrain's material, so fog, snow and rain treat it as the same ground.
//
// Costs one draw call and about five and a half thousand triangles.

import * as THREE from 'three';

// The 5x5 root ring guarantees real terrain to at least two root-sizes
// (16.4 km) from the player, whichever way they drift inside a root cell. The
// ring starts inside that, and rebuilds long before the worst-case drift can
// open a gap between the last real chunk and the first silhouette one.
const R_IN = 15000;
const R_OUT = 54000; // just inside the far plane, ~99% fogged at sea level
const AZI = 256; // ~370 m of arc at the inner edge - the chunk grid's scale
const RINGS = 12;
const REBUILD_DIST = 1200;

export class Horizon {
  constructor(world) {
    this.world = world;
    this.mesh = null;
    this.center = null;
    this.pending = null;
    // Its own worker rather than a slot in the terrain pool: a rebuild is
    // rare and must never queue behind (or in front of) a chunk mesh.
    this.worker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => console.error('horizon worker', e.message || e);
    this.worker.postMessage({ type: 'init', seed: world.wg.seed });
  }

  update() {
    if (this.pending) return;
    const p = this.world.player.position;
    if (this.center && Math.hypot(p.x - this.center.x, p.z - this.center.z) < REBUILD_DIST) return;
    this.pending = { x: p.x, z: p.z };
    this.worker.postMessage({
      type: 'horizon',
      cx: p.x, cz: p.z,
      rIn: R_IN, rOut: R_OUT, azi: AZI, rings: RINGS,
    });
  }

  _onMessage(msg) {
    if (msg.type === 'ready') return;
    if (msg.type === 'error') {
      console.error('horizon build', msg.message);
      // Back off to where we asked from, so a bad build cannot retry-loop.
      this.center = this.pending || this.center;
      this.pending = null;
      return;
    }
    if (msg.type !== 'horizon') return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
    geo.setAttribute('aux', new THREE.BufferAttribute(msg.aux, 4));
    geo.setIndex(new THREE.BufferAttribute(msg.indices, 1));

    const mesh = new THREE.Mesh(geo, this.world.terrain.material);
    mesh.position.set(msg.cx, 0, msg.cz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // An annulus around the camera intersects every frustum; culling it would
    // only ever cost the bounding-sphere test.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const scene = this.world.engine.scene;
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    scene.add(mesh);
    this.mesh = mesh;
    this.center = this.pending;
    this.pending = null;
  }

  dispose() {
    this.worker.terminate();
    if (this.mesh) {
      this.world.engine.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }
}

// Offline tree baking rig. Loaded headlessly by scripts/bake-trees.mjs.
//
// ez-tree generates far better trees than the in-game blob builder, but it is
// too heavy to run per-instance at boot. So it runs HERE, once, and the game
// ships the resulting geometry: trunks and canopies normalised to unit height,
// exported as GLB, instanced by the same pools that drew the old blobs.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Tree, TreePreset } from '@dgreenheck/ez-tree';

function applyOverrides(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
      if (!target[k]) target[k] = {};
      applyOverrides(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
}

/** Generate one tree and return { branches, leaves } geometries, unit height. */
function generate(presetName, overrides) {
  const tree = new Tree();
  tree.loadPreset(presetName);
  if (overrides) applyOverrides(tree.options, overrides);
  tree.generate();

  const branches = tree.branchesMesh.geometry.clone();
  const leaves = tree.leavesMesh.geometry.clone();

  // ez-tree expresses bark tiling as a texture repeat on its own material;
  // bake it into the UVs instead, so the game can share one texture between
  // species with different tiling.
  const ts = tree.options.bark.textureScale || { x: 1, y: 1 };
  const uv = branches.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * ts.x, uv.getY(i) * ts.y);
  }

  // Normalise so the tip of the tree sits at y=1 and the trunk at y=0. The
  // game then scales instances by its own species heights.
  branches.computeBoundingBox();
  leaves.computeBoundingBox();
  const top = Math.max(branches.boundingBox.max.y, leaves.boundingBox.max.y);
  const s = 1 / Math.max(top, 1e-3);
  branches.scale(s, s, s);
  leaves.scale(s, s, s);
  return { branches, leaves };
}

function countTris(geo) {
  return ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
}

async function exportGlb(parts) {
  const scene = new THREE.Scene();
  for (const [name, geo] of Object.entries(parts)) {
    if (!geo || !geo.attributes.position || geo.attributes.position.count === 0) continue;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = name;
    scene.add(mesh);
  }
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(scene, { binary: true });
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Bake one species config; returns { glb, farGlb, tris, farTris }. */
window.bakeOne = async function (cfg) {
  const near = generate(cfg.preset, cfg.overrides);
  const far = generate(cfg.preset, Object.assign({}, cfg.overrides, cfg.farOverrides));
  return {
    glb: await exportGlb({ branches: near.branches, leaves: near.leaves }),
    farGlb: await exportGlb({ branches: far.branches, leaves: far.leaves }),
    tris: countTris(near.branches) + countTris(near.leaves),
    farTris: countTris(far.branches) + countTris(far.leaves),
  };
};

window.bakeReady = true;

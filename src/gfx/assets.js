// Baked assets. The world remains procedurally PLACED, but geometry that is
// too expensive to grow at boot - the trees - is baked offline by
// scripts/bake-trees.mjs and loaded here once, before the world starts.
//
// Everything degrades: if these files are missing or fail to parse, the game
// silently falls back to the old in-code builders and still runs.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const assets = {
  trees: null, // { name: { bark, leaf, farBark, farLeaf, tex: {bark, leaf} } }
  terrain: false, // true when the baked terrain splat sets are present
  character: null, // { scene, clips } - the rigged player body, see bake-character.mjs
  texture: null, // (path, {srgb}) -> THREE.Texture, cached
};

function prepGeometry(g) {
  if (!g) return null;
  // Pool materials use vertexColors for the burn/growth tint; a missing
  // colour attribute samples as black (the classic trap), so fill white.
  if (!g.attributes.color) {
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * n).fill(1), 3));
  }
  g.computeBoundingSphere();
  return g;
}

function meshGeometry(gltf, name) {
  let found = null;
  gltf.scene.traverse((o) => {
    if (o.isMesh && o.name === name) found = o.geometry;
  });
  return prepGeometry(found);
}

export async function loadAssets(base = 'assets/') {
  const cache = new Map();
  const texLoader = new THREE.TextureLoader();
  assets.texture = (path, opts = {}) => {
    let t = cache.get(path);
    if (!t) {
      t = texLoader.load(base + path);
      t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      cache.set(path, t);
    }
    return t;
  };

  try {
    const res = await fetch(base + 'trees/MANIFEST.json');
    if (!res.ok) throw new Error('manifest http ' + res.status);
    const manifest = await res.json();
    const loader = new GLTFLoader();
    const trees = {};
    await Promise.all(
      Object.entries(manifest.species).map(async ([name, tex]) => {
        const [near, far] = await Promise.all([
          loader.loadAsync(base + `trees/${name}.glb`),
          loader.loadAsync(base + `trees/${name}_far.glb`),
        ]);
        trees[name] = {
          bark: meshGeometry(near, 'branches'),
          leaf: meshGeometry(near, 'leaves'),
          farBark: meshGeometry(far, 'branches'),
          farLeaf: meshGeometry(far, 'leaves'),
          tex,
        };
      })
    );
    assets.trees = trees;
  } catch (e) {
    console.warn('baked trees unavailable, using procedural builders:', e.message);
    assets.trees = null;
  }

  try {
    const res = await fetch(base + 'terrain/MANIFEST.json');
    assets.terrain = res.ok;
  } catch {
    assets.terrain = false;
  }

  try {
    const res = await fetch(base + 'character/MANIFEST.json');
    if (!res.ok) throw new Error('manifest http ' + res.status);
    const manifest = await res.json();
    const gltf = await new GLTFLoader().loadAsync(base + 'character/' + manifest.file);
    if (!gltf.animations || !gltf.animations.length) throw new Error('no animation clips');
    assets.character = { scene: gltf.scene, clips: gltf.animations };
  } catch (e) {
    console.warn('baked character unavailable, using procedural body:', e.message);
    assets.character = null;
  }
  return assets;
}

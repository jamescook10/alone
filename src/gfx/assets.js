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

  // The flat-shaded restyle draws trees and terrain with solid colours from
  // the in-code builders, so the baked textured sets are deliberately not
  // loaded any more (the bake scripts and files remain for reference).
  assets.trees = null;
  assets.terrain = false;

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

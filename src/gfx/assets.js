// Baked assets. The world remains procedurally PLACED, but geometry that is
// too expensive to grow at boot - the trees - is baked offline by
// scripts/bake-trees.mjs and loaded here once, before the world starts.
//
// Everything degrades: if these files are missing or fail to parse, the game
// silently falls back to the old in-code builders and still runs.

import * as THREE from 'three';

export const assets = {
  trees: null, // { name: { bark, leaf, farBark, farLeaf, tex: {bark, leaf} } }
  terrain: false, // true when the baked terrain splat sets are present
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

  // Nothing else is fetched. The player's animated body was the last thing
  // this loaded, and it went out with the third-person camera - so the game
  // now downloads no models and no textures at all at run time. The bake
  // scripts and the tree pack stay on disk for reference.
  return assets;
}

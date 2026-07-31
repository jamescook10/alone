// Bake the player character's ANIMATION. Not its body - see
// src/player/wandererMesh.js for that.
//
// The motion comes from KayKit's "Adventurers" pack (CC0, by Kay Lousberg) -
// the Rogue. The source GLB carries 75 combat animations, five holdable
// weapons and a painted 1024x1024 atlas this peaceful game will never use.
// This strips it to locomotion + sitting, throws the visible mesh away
// entirely, and prunes what that orphans: ~3.6 MB becomes a few tens of KB,
// and the game is left loading no textures at all at run time.
//
//   node scripts/bake-character.mjs [path/to/Rogue.glb]
//
// With no argument it downloads the file from the pack's GitHub repo at a
// pinned commit. Output: public/assets/character/{wanderer.glb, LICENSE.md,
// MANIFEST.json}. The game falls back to a hand-posed body if these are
// missing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, resample, quantize, weld } from '@gltf-transform/functions';

const COMMIT = '672074b73ba276876a19e8816ecdc5241817ab47';
const REPO = 'KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0';
const SRC = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/addons/kaykit_character_pack_adventures/Characters/gltf/Rogue.glb`;
const LICENSE_SRC = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/LICENSE.txt`;
const OUT = 'public/assets/character';

// Everything the camera rig and the player's life out here can ask of a
// body. No backwards walk: the character turns to face its velocity, so it
// is always walking forward somewhere.
const KEEP_CLIPS = new Set([
  'Idle', 'Walking_A', 'Running_A', 'Jump_Idle',
  'Sit_Floor_Down', 'Sit_Floor_Idle', 'Sit_Floor_StandUp',
]);
/**
 * Throw the body away and keep the skeleton.
 *
 * A glTF skin is only valid on a node that also carries a mesh, and three.js
 * only promotes a node to a Bone if some skin claims it as a joint - so
 * deleting every mesh would quietly turn the skeleton into a bag of plain
 * Object3Ds. One degenerate triangle stays behind to hold the skin in place;
 * the game drops it again at load. It is worth the ugliness: the atlas that
 * goes with it was the last texture the game fetched at run time.
 */
function stripMesh(doc) {
  const root = doc.getRoot();
  const anchor = root.listNodes().find((n) => n.getMesh() && n.getSkin());
  if (!anchor) throw new Error('no skinned node to anchor the skeleton to');

  const buffer = root.listBuffers()[0];
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));

  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const mat of root.listMaterials()) mat.dispose();
  for (const tex of root.listTextures()) tex.dispose();
  // Mesh-only nodes (the body parts, the cape, the weapons) are not joints,
  // so nothing in the skeleton or the clips misses them.
  for (const node of root.listNodes()) {
    if (node !== anchor && !node.getMesh() && node.listChildren().length === 0 && !isJoint(root, node)) node.dispose();
  }
  anchor.setMesh(doc.createMesh('skeleton-anchor').addPrimitive(prim));
}

function isJoint(root, node) {
  for (const skin of root.listSkins()) if (skin.listJoints().includes(node)) return true;
  return false;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: http ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const io = new NodeIO().registerExtensions([KHRMeshQuantization]);
let doc;
if (process.argv[2]) {
  doc = await io.read(process.argv[2]);
  console.log('read ' + process.argv[2]);
} else {
  doc = await io.readBinary(await fetchBytes(SRC));
  console.log('fetched Rogue.glb @ ' + COMMIT.slice(0, 7));
}

const root = doc.getRoot();
for (const anim of root.listAnimations()) {
  if (KEEP_CLIPS.has(anim.getName())) continue;
  // Disposing only the Animation leaves its channels, samplers and their
  // accessors alive in the graph where prune() cannot see they are orphans -
  // that alone is ~1.9 MB of the source file.
  for (const ch of anim.listChannels()) {
    const sampler = ch.getSampler();
    ch.dispose();
    if (sampler) sampler.dispose();
  }
  anim.dispose();
}
stripMesh(doc);
// The real weight of this file is not vertex data - it is thousands of
// animation channels that never move: every clip carries a track for every
// bone's translation, rotation AND scale, and most are pinned at the rest
// pose. A channel that is constant and rest-valued in EVERY kept clip can
// be dropped outright: no clip will ever write that property, so it simply
// stays at rest. (Dropping them from only some clips would let a pose leak
// across a crossfade, which is why the test is global.)
stripRestChannels(root);
await doc.transform(dedup(), weld(), resample({ tolerance: 1e-3 }), quantize(), prune());

function stripRestChannels(root) {
  const EPS = 1e-4;
  const restOf = (node, path) =>
    path === 'translation' ? node.getTranslation() : path === 'rotation' ? node.getRotation() : node.getScale();
  const constantRest = (channel) => {
    const node = channel.getTargetNode();
    const path = channel.getTargetPath();
    const sampler = channel.getSampler();
    if (!node || !sampler || path === 'weights') return false;
    const out = sampler.getOutput().getArray();
    const rest = restOf(node, path);
    const stride = rest.length;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - rest[i % stride]) > EPS) return false;
    }
    return true;
  };

  // A channel key is droppable only if every clip that touches it agrees.
  const veto = new Set();
  const seen = new Map();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (!node) continue;
      const key = node.getName() + ':' + ch.getTargetPath();
      seen.set(key, (seen.get(key) || 0) + 1);
      if (!constantRest(ch)) veto.add(key);
    }
  }
  let dropped = 0;
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (!node) continue;
      const key = node.getName() + ':' + ch.getTargetPath();
      if (veto.has(key)) continue;
      const sampler = ch.getSampler();
      ch.dispose();
      if (sampler) sampler.dispose();
      dropped++;
    }
  }
  console.log(`dropped ${dropped} rest-pose channels`);
}

const kept = root.listAnimations().map((a) => a.getName());
const missing = [...KEEP_CLIPS].filter((n) => !kept.includes(n));
if (missing.length) throw new Error('expected clips missing from source: ' + missing.join(', '));

mkdirSync(OUT, { recursive: true });
const glb = await io.writeBinary(doc);
writeFileSync(`${OUT}/wanderer.glb`, glb);

const licenseText = new TextDecoder().decode(await fetchBytes(LICENSE_SRC));
writeFileSync(
  `${OUT}/LICENSE.md`,
  `# Character asset licence

\`wanderer.glb\` is the skeleton and seven animation clips of the Rogue from
**KayKit : Adventurers Character Pack (1.0)** by Kay Lousberg
(https://kaylousberg.com), licensed **CC0**, cut down to locomotion and
sitting by \`scripts/bake-character.mjs\`.

The visible body is **not** from this pack and none of its artwork ships
here: the mesh and its texture atlas are discarded at bake time, and the
player's body is generated in code by \`src/player/wandererMesh.js\`. What
remains is joint positions and motion.

Source: https://github.com/${REPO} @ ${COMMIT}

Original licence text:

\`\`\`
${licenseText.trim()}
\`\`\`
`
);
writeFileSync(
  `${OUT}/MANIFEST.json`,
  JSON.stringify({ file: 'wanderer.glb', source: REPO, commit: COMMIT, license: 'CC0', contains: 'skeleton + clips only; mesh and texture discarded', clips: kept }, null, 2) + '\n'
);
console.log(`wrote ${OUT}/wanderer.glb (${(glb.length / 1024).toFixed(0)} KB), clips: ${kept.join(', ')}`);

// The table of places.
//
// Everything the world knows about "what kind of country is this" lives here as
// plain data: the ground colours, how much grows on it, which plants grow, and
// which rock and sand it weathers into. The oracle classifies, this describes.
//
// Pure data and pure functions only - this module is imported by the terrain
// workers, so it must never touch three.js or the DOM.
//
// Ground colours are *reflectances*, not display colours. They are authored in
// sRGB as the pastel the player should see under a midday sun and converted to
// linear once at load. Raising one without raising the light is what made the
// early builds look like washed-out plastic.

/* ================================================================== biomes */

export const BIOME = {
  DEEP_OCEAN: 0,
  OCEAN: 1,
  REEF: 2,
  BEACH: 3,
  GRASSLAND: 4,
  FOREST: 5,
  RAINFOREST: 6,
  TAIGA: 7,
  TUNDRA: 8,
  SNOW: 9,
  DESERT: 10,
  SAVANNA: 11,
  SWAMP: 12,
  ALPINE: 13,
  SCREE: 14,
  MEADOW: 15,
  // --- everything below is new country -------------------------------------
  MANGROVE: 16,
  SALT_FLAT: 17,
  DUNES: 18,
  ROCKY_DESERT: 19,
  STEPPE: 20,
  SHRUBLAND: 21,
  MOOR: 22,
  BOG: 23,
  MARSH: 24,
  BAMBOO: 25,
  CLOUD_FOREST: 26,
  LAVA_FIELD: 27,
  GLACIER: 28,
  POLAR_DESERT: 29,
  KARST: 30,
  BADLANDS: 31,
  PRAIRIE: 32,
  OASIS: 33,
  CROPLAND: 34,
  URBAN: 35,
  KELP: 36,
  DRY_FOREST: 37,
  BLACK_SAND: 38,
};

/* ================================================================= species */

// Plant species ids. Shared by the oracle (which decides what grows where),
// the terrain worker (which scatters them) and flora.js (which builds them).
export const SPECIES = {
  OAK: 0, PINE: 1, BIRCH: 2, PALM: 3, ACACIA: 4, CACTUS: 5, WILLOW: 6, SNAG: 7,
  JUNGLE: 8, SPRUCE: 9, BUSH: 10, FERN: 11, SAPLING: 12,
  BAOBAB: 13, EUCALYPT: 14, BANANA: 15, BAMBOO: 16, MANGROVE: 17, CYPRESS: 18,
  JOSHUA: 19, AGAVE: 20, OLIVE: 21, SAGE: 22, TUSSOCK: 23, DWARF_BIRCH: 24,
  TREE_FERN: 25, LARCH: 26, REED: 27, KELP: 28, MOSS: 29, WHEAT: 30,
  ASPEN: 31, DEAD_PALM: 32,
};

// height   : metres at full maturity, before the per-instance scale
// cap      : instance pool size. Niche species get small pools; the ones that
//            carpet a whole biome need thousands.
// mature   : game-days to full size
// burn     : how readily it takes fire, relative to oak
// wood     : firewood yielded when felled
export const SPECIES_INFO = [
  { name: 'oak', height: 11, cap: 2600, fruit: 'apple', fruitChance: 0.5, mature: 5.5, burn: 1.0, wood: 4 },
  { name: 'pine', height: 15, cap: 2600, fruit: 'pinecone', fruitChance: 0.3, mature: 6.5, burn: 1.3, wood: 4 },
  { name: 'birch', height: 12, cap: 1800, fruit: null, fruitChance: 0, mature: 4.5, burn: 1.1, wood: 3 },
  { name: 'palm', height: 13, cap: 900, fruit: 'coconut', fruitChance: 0.6, mature: 6, burn: 0.9, wood: 3 },
  { name: 'acacia', height: 9, cap: 1100, fruit: null, fruitChance: 0, mature: 6, burn: 1.0, wood: 3 },
  { name: 'cactus', height: 4.5, cap: 700, fruit: 'prickly pear', fruitChance: 0.45, mature: 8, burn: 0.4, wood: 1 },
  { name: 'willow', height: 10, cap: 700, fruit: null, fruitChance: 0, mature: 5, burn: 0.9, wood: 3 },
  { name: 'dead tree', height: 8, cap: 900, fruit: null, fruitChance: 0, mature: 3, burn: 1.8, wood: 3 },
  { name: 'kapok', height: 24, cap: 1400, fruit: 'mango', fruitChance: 0.5, mature: 9, burn: 0.9, wood: 6 },
  { name: 'spruce', height: 17, cap: 2200, fruit: null, fruitChance: 0.15, mature: 7, burn: 1.4, wood: 4 },
  { name: 'bush', height: 1.5, cap: 3000, fruit: 'berries', fruitChance: 0.55, mature: 1.6, burn: 1.5, wood: 1 },
  { name: 'fern', height: 1.1, cap: 2200, fruit: null, fruitChance: 0, mature: 1.2, burn: 1.2, wood: 0 },
  { name: 'sapling', height: 1.0, cap: 400, fruit: null, fruitChance: 0, mature: 1.0, burn: 1.4, wood: 0 },
  { name: 'baobab', height: 18, cap: 260, fruit: 'baobab fruit', fruitChance: 0.5, mature: 12, burn: 0.5, wood: 8 },
  { name: 'eucalypt', height: 20, cap: 1300, fruit: null, fruitChance: 0, mature: 6, burn: 2.2, wood: 4 },
  { name: 'banana plant', height: 3.4, cap: 900, fruit: 'banana', fruitChance: 0.7, mature: 2.2, burn: 0.8, wood: 1 },
  { name: 'bamboo', height: 13, cap: 3400, fruit: null, fruitChance: 0, mature: 1.8, burn: 1.6, wood: 2 },
  { name: 'mangrove', height: 7, cap: 1200, fruit: null, fruitChance: 0, mature: 5, burn: 0.6, wood: 3 },
  { name: 'swamp cypress', height: 19, cap: 800, fruit: null, fruitChance: 0, mature: 8, burn: 0.9, wood: 5 },
  { name: 'joshua tree', height: 7, cap: 500, fruit: null, fruitChance: 0, mature: 10, burn: 0.7, wood: 2 },
  { name: 'agave', height: 1.4, cap: 1200, fruit: null, fruitChance: 0, mature: 3, burn: 0.5, wood: 0 },
  { name: 'olive tree', height: 6.5, cap: 1100, fruit: 'olives', fruitChance: 0.55, mature: 7, burn: 0.9, wood: 3 },
  { name: 'sagebrush', height: 0.9, cap: 2600, fruit: null, fruitChance: 0, mature: 1.4, burn: 1.9, wood: 0 },
  { name: 'tussock', height: 0.7, cap: 3000, fruit: null, fruitChance: 0, mature: 1.0, burn: 1.5, wood: 0 },
  { name: 'dwarf birch', height: 1.8, cap: 1800, fruit: null, fruitChance: 0, mature: 3, burn: 1.2, wood: 1 },
  { name: 'tree fern', height: 5.5, cap: 900, fruit: null, fruitChance: 0, mature: 4, burn: 1.0, wood: 1 },
  { name: 'larch', height: 16, cap: 1600, fruit: null, fruitChance: 0.1, mature: 7, burn: 1.3, wood: 4 },
  { name: 'reeds', height: 2.2, cap: 3000, fruit: null, fruitChance: 0, mature: 1.0, burn: 1.7, wood: 0 },
  { name: 'kelp', height: 6, cap: 1400, fruit: null, fruitChance: 0, mature: 2, burn: 0, wood: 0 },
  { name: 'moss', height: 0.5, cap: 2600, fruit: null, fruitChance: 0, mature: 1.4, burn: 0.6, wood: 0 },
  { name: 'wheat', height: 1.2, cap: 2400, fruit: 'grain', fruitChance: 0.8, mature: 1.2, burn: 2.0, wood: 0 },
  { name: 'aspen', height: 13, cap: 1500, fruit: null, fruitChance: 0, mature: 4.5, burn: 1.2, wood: 3 },
  { name: 'dead palm', height: 9, cap: 400, fruit: null, fruitChance: 0, mature: 3, burn: 1.6, wood: 2 },
];

const S = SPECIES;

/**
 * Flora mixes. Each entry is [species, cumulative threshold]; the scatter rolls
 * one hash in [0,1) and takes the first entry above it, so weights are just the
 * gaps. The point of the table is that a Namibian plain and an Icelandic one
 * hold entirely different things even though both are "flat and open".
 */
const MIX = {
  [BIOME.GRASSLAND]: [[S.OAK, 0.34], [S.BUSH, 0.62], [S.BIRCH, 0.84], [S.ASPEN, 1]],
  [BIOME.MEADOW]: [[S.OAK, 0.30], [S.BIRCH, 0.55], [S.BUSH, 0.85], [S.ASPEN, 1]],
  [BIOME.PRAIRIE]: [[S.BUSH, 0.45], [S.OAK, 0.68], [S.TUSSOCK, 1]],
  [BIOME.STEPPE]: [[S.SAGE, 0.60], [S.TUSSOCK, 0.86], [S.BUSH, 1]],
  [BIOME.FOREST]: [[S.OAK, 0.38], [S.BIRCH, 0.60], [S.PINE, 0.78], [S.ASPEN, 0.92], [S.SNAG, 1]],
  [BIOME.DRY_FOREST]: [[S.EUCALYPT, 0.44], [S.ACACIA, 0.70], [S.OLIVE, 0.86], [S.BUSH, 1]],
  [BIOME.RAINFOREST]: [[S.JUNGLE, 0.48], [S.BANANA, 0.66], [S.TREE_FERN, 0.80], [S.FERN, 0.94], [S.PALM, 1]],
  [BIOME.CLOUD_FOREST]: [[S.TREE_FERN, 0.42], [S.JUNGLE, 0.64], [S.FERN, 0.86], [S.MOSS, 1]],
  [BIOME.BAMBOO]: [[S.BAMBOO, 0.88], [S.FERN, 1]],
  [BIOME.TAIGA]: [[S.SPRUCE, 0.46], [S.PINE, 0.72], [S.LARCH, 0.88], [S.SNAG, 1]],
  [BIOME.TUNDRA]: [[S.DWARF_BIRCH, 0.44], [S.TUSSOCK, 0.78], [S.MOSS, 0.94], [S.SNAG, 1]],
  [BIOME.MOOR]: [[S.TUSSOCK, 0.50], [S.SAGE, 0.74], [S.DWARF_BIRCH, 0.92], [S.SNAG, 1]],
  [BIOME.BOG]: [[S.TUSSOCK, 0.44], [S.MOSS, 0.74], [S.REED, 0.92], [S.SNAG, 1]],
  [BIOME.MARSH]: [[S.REED, 0.56], [S.WILLOW, 0.80], [S.TUSSOCK, 1]],
  [BIOME.SWAMP]: [[S.CYPRESS, 0.36], [S.WILLOW, 0.58], [S.REED, 0.78], [S.FERN, 0.92], [S.SNAG, 1]],
  [BIOME.MANGROVE]: [[S.MANGROVE, 0.86], [S.REED, 1]],
  [BIOME.SNOW]: [[S.SPRUCE, 0.52], [S.LARCH, 0.78], [S.SNAG, 1]],
  [BIOME.GLACIER]: [[S.MOSS, 1]],
  [BIOME.POLAR_DESERT]: [[S.MOSS, 0.70], [S.TUSSOCK, 1]],
  [BIOME.DESERT]: [[S.CACTUS, 0.52], [S.AGAVE, 0.78], [S.SAGE, 1]],
  [BIOME.DUNES]: [[S.SAGE, 0.60], [S.DEAD_PALM, 0.82], [S.AGAVE, 1]],
  [BIOME.ROCKY_DESERT]: [[S.JOSHUA, 0.40], [S.AGAVE, 0.70], [S.CACTUS, 0.88], [S.SAGE, 1]],
  [BIOME.SALT_FLAT]: [[S.SAGE, 1]],
  [BIOME.OASIS]: [[S.PALM, 0.70], [S.REED, 0.88], [S.BUSH, 1]],
  [BIOME.SAVANNA]: [[S.ACACIA, 0.54], [S.BAOBAB, 0.64], [S.BUSH, 0.86], [S.EUCALYPT, 1]],
  [BIOME.SHRUBLAND]: [[S.OLIVE, 0.42], [S.SAGE, 0.70], [S.BUSH, 0.88], [S.AGAVE, 1]],
  [BIOME.ALPINE]: [[S.SPRUCE, 0.40], [S.LARCH, 0.64], [S.DWARF_BIRCH, 0.84], [S.TUSSOCK, 1]],
  [BIOME.SCREE]: [[S.MOSS, 0.60], [S.TUSSOCK, 1]],
  [BIOME.KARST]: [[S.BAMBOO, 0.36], [S.JUNGLE, 0.60], [S.FERN, 0.82], [S.BUSH, 1]],
  [BIOME.BADLANDS]: [[S.SAGE, 0.62], [S.JOSHUA, 0.82], [S.SNAG, 1]],
  [BIOME.LAVA_FIELD]: [[S.MOSS, 0.74], [S.TUSSOCK, 0.92], [S.SNAG, 1]],
  [BIOME.BEACH]: [[S.PALM, 0.74], [S.BUSH, 1]],
  [BIOME.BLACK_SAND]: [[S.TUSSOCK, 0.72], [S.MOSS, 1]],
  [BIOME.REEF]: [[S.KELP, 1]],
  [BIOME.KELP]: [[S.KELP, 1]],
  [BIOME.CROPLAND]: [[S.WHEAT, 0.82], [S.OAK, 0.92], [S.BUSH, 1]],
  [BIOME.URBAN]: [[S.OAK, 0.52], [S.BUSH, 1]],
};

const DEFAULT_MIX = [[S.BUSH, 1]];

/** Pick a species for a biome from one hash roll in [0,1). */
export function speciesFor(biome, r) {
  const mix = MIX[biome] || DEFAULT_MIX;
  for (let i = 0; i < mix.length; i++) {
    if (r < mix[i][1]) return mix[i][0];
  }
  return mix[mix.length - 1][0];
}

/* ============================================================ ground table */

// col/col2 : the two flat tones the ground alternates between
// trees    : plant density multiplier
// grass    : ground-cover density multiplier
// rocks    : loose-rock density
// flowers  : flowering fraction of the ground cover
// rock     : the colour steep faces weather to (null = the default grey)
// sand     : the colour the shoreline takes (null = pale gold)
// hard     : how hostile it is to settlement, 0 easy .. 1 nobody lives here
// road     : the best road surface people would build here
export const BIOME_INFO = [
  { name: 'Abyss', col: [0.20, 0.27, 0.36], col2: [0.16, 0.22, 0.31], trees: 0, grass: 0, rocks: 0.5, flowers: 0, hard: 1 },
  { name: 'Seabed', col: [0.72, 0.66, 0.48], col2: [0.62, 0.57, 0.42], trees: 0, grass: 0.1, rocks: 0.6, flowers: 0, hard: 1 },
  { name: 'Reef', col: [0.83, 0.76, 0.54], col2: [0.52, 0.72, 0.62], trees: 0.5, grass: 0.5, rocks: 1.2, flowers: 0.4, hard: 1 },
  { name: 'Shore', col: [0.89, 0.80, 0.58], col2: [0.83, 0.73, 0.51], trees: 0.05, grass: 0.05, rocks: 0.35, flowers: 0.02, hard: 0.5 },
  { name: 'Grassland', col: [0.56, 0.73, 0.36], col2: [0.66, 0.79, 0.42], trees: 0.10, grass: 1.0, rocks: 0.16, flowers: 0.7, hard: 0.05, road: 'tarmac' },
  { name: 'Forest', col: [0.42, 0.63, 0.32], col2: [0.50, 0.70, 0.37], trees: 0.85, grass: 0.7, rocks: 0.22, flowers: 0.35, hard: 0.25, road: 'tarmac' },
  { name: 'Rainforest', col: [0.31, 0.58, 0.30], col2: [0.38, 0.66, 0.34], trees: 1.35, grass: 0.9, rocks: 0.14, flowers: 0.5, hard: 0.85, road: 'dirt' },
  { name: 'Taiga', col: [0.48, 0.63, 0.41], col2: [0.55, 0.67, 0.46], trees: 0.75, grass: 0.4, rocks: 0.35, flowers: 0.15, hard: 0.45, road: 'gravel' },
  { name: 'Tundra', col: [0.70, 0.67, 0.51], col2: [0.77, 0.72, 0.57], trees: 0.10, grass: 0.35, rocks: 0.5, flowers: 0.12, hard: 0.7, road: 'gravel' },
  { name: 'Snowfield', col: [0.93, 0.94, 0.97], col2: [0.86, 0.89, 0.94], trees: 0.03, grass: 0.02, rocks: 0.4, flowers: 0, hard: 0.95 },
  { name: 'Desert', col: [0.91, 0.76, 0.49], col2: [0.85, 0.68, 0.42], trees: 0.03, grass: 0.06, rocks: 0.3, flowers: 0.03, hard: 0.85, road: 'dirt', sand: [0.93, 0.79, 0.51] },
  { name: 'Savanna', col: [0.80, 0.71, 0.38], col2: [0.86, 0.77, 0.44], trees: 0.16, grass: 0.8, rocks: 0.2, flowers: 0.2, hard: 0.45, road: 'dirt' },
  { name: 'Swamp', col: [0.44, 0.62, 0.35], col2: [0.50, 0.65, 0.39], trees: 0.55, grass: 1.2, rocks: 0.08, flowers: 0.45, hard: 0.75, road: 'dirt' },
  { name: 'Alpine', col: [0.66, 0.64, 0.70], col2: [0.73, 0.71, 0.76], trees: 0.14, grass: 0.25, rocks: 0.9, flowers: 0.3, hard: 0.8, road: 'gravel' },
  { name: 'Scree', col: [0.60, 0.58, 0.65], col2: [0.53, 0.51, 0.58], trees: 0.02, grass: 0.03, rocks: 1.4, flowers: 0.02, hard: 0.95 },
  { name: 'Meadow', col: [0.59, 0.76, 0.37], col2: [0.68, 0.82, 0.44], trees: 0.18, grass: 1.4, rocks: 0.1, flowers: 1.6, hard: 0.05, road: 'tarmac' },

  { name: 'Mangrove', col: [0.36, 0.52, 0.34], col2: [0.43, 0.56, 0.37], trees: 1.1, grass: 0.5, rocks: 0.04, flowers: 0.1, hard: 0.9, road: 'dirt' },
  { name: 'Salt flat', col: [0.90, 0.89, 0.85], col2: [0.84, 0.83, 0.79], trees: 0.005, grass: 0.02, rocks: 0.08, flowers: 0, hard: 0.95, sand: [0.92, 0.91, 0.87] },
  { name: 'Dunes', col: [0.93, 0.80, 0.52], col2: [0.88, 0.73, 0.45], trees: 0.012, grass: 0.03, rocks: 0.05, flowers: 0, hard: 0.98, sand: [0.94, 0.81, 0.53] },
  { name: 'Stone desert', col: [0.76, 0.60, 0.42], col2: [0.68, 0.53, 0.37], trees: 0.05, grass: 0.05, rocks: 0.95, flowers: 0.02, hard: 0.9, road: 'dirt', rock: [0.68, 0.50, 0.36] },
  { name: 'Steppe', col: [0.74, 0.72, 0.44], col2: [0.79, 0.76, 0.50], trees: 0.05, grass: 0.75, rocks: 0.22, flowers: 0.2, hard: 0.4, road: 'gravel' },
  { name: 'Scrubland', col: [0.68, 0.66, 0.40], col2: [0.74, 0.70, 0.45], trees: 0.32, grass: 0.55, rocks: 0.35, flowers: 0.4, hard: 0.25, road: 'tarmac' },
  { name: 'Moorland', col: [0.55, 0.52, 0.36], col2: [0.61, 0.56, 0.40], trees: 0.10, grass: 0.9, rocks: 0.4, flowers: 0.35, hard: 0.55, road: 'gravel' },
  { name: 'Peat bog', col: [0.47, 0.49, 0.34], col2: [0.53, 0.52, 0.38], trees: 0.14, grass: 1.1, rocks: 0.1, flowers: 0.2, hard: 0.85, road: 'dirt' },
  { name: 'Marsh', col: [0.52, 0.65, 0.40], col2: [0.58, 0.69, 0.44], trees: 0.32, grass: 1.3, rocks: 0.05, flowers: 0.5, hard: 0.7, road: 'dirt' },
  { name: 'Bamboo forest', col: [0.50, 0.68, 0.35], col2: [0.57, 0.72, 0.40], trees: 1.5, grass: 0.6, rocks: 0.12, flowers: 0.2, hard: 0.7, road: 'dirt' },
  { name: 'Cloud forest', col: [0.34, 0.55, 0.36], col2: [0.40, 0.60, 0.40], trees: 1.2, grass: 1.0, rocks: 0.3, flowers: 0.7, hard: 0.85, road: 'dirt' },
  { name: 'Lava field', col: [0.24, 0.23, 0.24], col2: [0.30, 0.29, 0.29], trees: 0.10, grass: 0.35, rocks: 1.3, flowers: 0.05, hard: 0.9, road: 'gravel', rock: [0.21, 0.20, 0.21], sand: [0.22, 0.21, 0.22] },
  { name: 'Glacier', col: [0.85, 0.90, 0.96], col2: [0.76, 0.84, 0.93], trees: 0, grass: 0, rocks: 0.25, flowers: 0, hard: 1, rock: [0.72, 0.79, 0.88] },
  { name: 'Polar desert', col: [0.76, 0.76, 0.76], col2: [0.69, 0.70, 0.72], trees: 0.02, grass: 0.08, rocks: 0.6, flowers: 0, hard: 0.98 },
  { name: 'Karst', col: [0.62, 0.70, 0.44], col2: [0.72, 0.74, 0.55], trees: 0.75, grass: 0.6, rocks: 0.8, flowers: 0.3, hard: 0.8, road: 'dirt', rock: [0.80, 0.79, 0.72] },
  { name: 'Badlands', col: [0.72, 0.49, 0.36], col2: [0.79, 0.58, 0.40], trees: 0.06, grass: 0.12, rocks: 0.7, flowers: 0.03, hard: 0.9, road: 'dirt', rock: [0.66, 0.42, 0.31] },
  { name: 'Prairie', col: [0.71, 0.75, 0.40], col2: [0.77, 0.79, 0.46], trees: 0.07, grass: 1.25, rocks: 0.12, flowers: 0.8, hard: 0.1, road: 'tarmac' },
  { name: 'Oasis', col: [0.55, 0.72, 0.38], col2: [0.72, 0.68, 0.44], trees: 0.85, grass: 1.0, rocks: 0.15, flowers: 0.5, hard: 0.35, road: 'dirt', sand: [0.92, 0.78, 0.50] },
  { name: 'Farmland', col: [0.66, 0.62, 0.36], col2: [0.74, 0.70, 0.42], trees: 0.10, grass: 0.9, rocks: 0.05, flowers: 0.25, hard: 0, road: 'tarmac' },
  { name: 'City', col: [0.52, 0.51, 0.49], col2: [0.58, 0.56, 0.53], trees: 0.05, grass: 0.15, rocks: 0.02, flowers: 0.1, hard: 0, road: 'tarmac' },
  { name: 'Kelp forest', col: [0.36, 0.46, 0.36], col2: [0.30, 0.40, 0.34], trees: 0.6, grass: 0.4, rocks: 0.7, flowers: 0, hard: 1 },
  { name: 'Dry forest', col: [0.60, 0.66, 0.36], col2: [0.67, 0.71, 0.42], trees: 0.62, grass: 0.6, rocks: 0.25, flowers: 0.25, hard: 0.4, road: 'gravel' },
  { name: 'Black sand', col: [0.26, 0.25, 0.26], col2: [0.32, 0.31, 0.31], trees: 0.03, grass: 0.10, rocks: 0.45, flowers: 0.02, hard: 0.7, sand: [0.24, 0.23, 0.24], rock: [0.22, 0.21, 0.22] },
];

/* ------------------------------------------------------------------ colour */

/** sRGB -> linear. The whole palette above is authored as display colour. */
export function s2l(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Converted once, in place, at module load. This file runs inside workers, so
// there is no THREE.Color to lean on.
for (const info of BIOME_INFO) {
  for (const key of ['col', 'col2', 'rock', 'sand']) {
    if (info[key]) info[key] = info[key].map(s2l);
  }
  if (info.road === undefined) info.road = null;
  if (info.hard === undefined) info.hard = 0.5;
}

/* ------------------------------------------------------------------- names */

// Biomes the player would call "under water", used by anything that needs to
// know whether it is standing on a seabed rather than on land.
export const SUBMERGED = new Set([BIOME.DEEP_OCEAN, BIOME.OCEAN, BIOME.REEF, BIOME.KELP]);

// Biomes where a hard road surface would be absurd: nobody tarmacs a glacier.
export const NO_ROAD = new Set([
  BIOME.DEEP_OCEAN, BIOME.OCEAN, BIOME.REEF, BIOME.KELP,
  BIOME.GLACIER, BIOME.SNOW, BIOME.SCREE, BIOME.DUNES, BIOME.SALT_FLAT,
  BIOME.POLAR_DESERT, BIOME.LAVA_FIELD, BIOME.MANGROVE,
]);

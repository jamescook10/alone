// What you can carry.
//
// Deliberately short. Nothing here is a quest item and nothing unlocks
// anything; they are just the handful of things that let you act on the world.

import { Substance, MATERIAL, PHASE } from '../sim/chemistry.js';

export const ITEMS = {
  hand: { name: 'hands', icon: '✋', stack: 1 },
  firestarter: { name: 'fire drill', icon: '🔥', stack: 1, desc: 'spin it against dry wood' },
  axe: { name: 'stone axe', icon: '🪓', stack: 1, desc: 'fells trees, breaks things' },
  pot: { name: 'iron pot', icon: '🫕', stack: 1, desc: 'holds water, sits on a fire' },
  torch: { name: 'torch', icon: '🕯️', stack: 1, desc: 'carries fire with you' },
  wood: { name: 'firewood', icon: '🪵', stack: 40 },
  seed: { name: 'seeds', icon: '🌱', stack: 60 },
  fruit: { name: 'fruit', icon: '🍎', stack: 30 },
  stone: { name: 'stones', icon: '🪨', stack: 40 },
  lantern: { name: 'lantern', icon: '🏮', stack: 1 },
  canteen: { name: 'canteen', icon: '🧴', stack: 1 },
};

export class Inventory {
  constructor(world) {
    this.world = world;
    this.slots = [
      { key: 'hand', n: 1 },
      { key: 'firestarter', n: 1 },
      { key: 'axe', n: 1 },
      { key: 'pot', n: 1, substance: null },
      { key: 'torch', n: 1, lit: false },
      { key: 'wood', n: 4 },
      { key: 'seed', n: 3, species: 0 },
      { key: 'fruit', n: 0 },
      { key: 'canteen', n: 1, substance: new Substance('water', 1, 14) },
    ];
    this.selected = 0;
  }

  get current() {
    return this.slots[this.selected];
  }

  get currentItem() {
    return ITEMS[this.current.key];
  }

  select(i) {
    this.selected = ((i % this.slots.length) + this.slots.length) % this.slots.length;
    return this.current;
  }

  cycle(d) {
    return this.select(this.selected + d);
  }

  find(key) {
    return this.slots.find((s) => s.key === key);
  }

  count(key) {
    const s = this.find(key);
    return s ? s.n : 0;
  }

  add(key, n = 1, extra = null) {
    let slot = this.slots.find((s) => s.key === key);
    if (!slot) {
      slot = { key, n: 0 };
      this.slots.push(slot);
    }
    slot.n = Math.min(ITEMS[key] ? ITEMS[key].stack : 99, slot.n + n);
    if (extra) Object.assign(slot, extra);
    return slot;
  }

  take(key, n = 1) {
    const slot = this.slots.find((s) => s.key === key);
    if (!slot || slot.n < n) return false;
    slot.n -= n;
    return true;
  }

  /** Label for the HUD, including what a container currently holds. */
  label(slot = this.current) {
    const item = ITEMS[slot.key];
    if (!item) return slot.key;
    let s = item.name;
    if (slot.substance) {
      const sub = slot.substance;
      s += ` · ${sub.label} ${sub.temp.toFixed(0)}°`;
      if (sub.phase === PHASE.SOLID) s += ' (frozen)';
      else if (sub.sterile) s += ' (boiled)';
    }
    if (slot.key === 'torch' && slot.lit) s += ' · lit';
    if (slot.key === 'seed' && slot.species !== undefined) {
      s += ` · ${SEED_NAMES[slot.species] || 'unknown'}`;
    }
    return s;
  }

  /**
   * Containers keep simulating wherever you are: a pot of water left over a
   * fire boils, a canteen carried up a mountain in winter freezes solid.
   */
  update(dt, ambient, firePower) {
    for (const slot of this.slots) {
      if (!slot.substance || slot.n <= 0) continue;
      const insulation = slot.key === 'canteen' ? 0.35 : 1;
      const power = slot.key === 'pot' ? firePower : firePower * 0.15;
      const event = slot.substance.step(dt, ambient, power, insulation);
      if (!event) continue;
      if (event === 'boiled') {
        this.world.note(`The ${ITEMS[slot.key].name} came to a rolling boil.`, 'event');
        this.world.particles.steam(
          this.world.player.position.x, this.world.player.position.y + 1.1, this.world.player.position.z, 0.8, 6
        );
      } else if (event === 'boiling' && Math.random() < dt * 6) {
        this.world.particles.steam(
          this.world.player.position.x, this.world.player.position.y + 1.1, this.world.player.position.z, 0.6, 1
        );
      } else if (event === 'froze') {
        this.world.note(`The water in your ${ITEMS[slot.key].name} froze.`, 'event');
      } else if (event === 'thawed') {
        this.world.note(`The ice in your ${ITEMS[slot.key].name} melted.`, 'event');
      }
    }
  }
}

export const SEED_NAMES = ['oak', 'pine', 'birch', 'palm', 'acacia', 'cactus', 'willow', '', 'kapok', 'spruce', 'bush', 'fern'];

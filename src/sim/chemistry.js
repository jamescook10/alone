// Materials, heat and phase change.
//
// The world keeps a real temperature field: altitude, latitude, time of day,
// weather and nearby fires all feed into it. Anything that holds a substance
// (a pot, a puddle, a lake, a bottle) tracks its own temperature and changes
// state when it crosses a threshold. That is what lets you boil water over a
// campfire, and what freezes a full canteen if you carry it up a mountain.

import { clamp, lerp, smoothstep } from '../core/noise.js';

export const PHASE = { SOLID: 0, LIQUID: 1, GAS: 2 };

/**
 * specificHeat: kJ per kg per K (scaled for gameplay pacing)
 * conduct: how fast it exchanges heat with its surroundings, 0..1 per second
 * ignite: temperature at which it starts to burn, or null if it does not
 * heatOfCombustion: how much energy burning it releases
 */
export const MATERIAL = {
  water: {
    name: 'water', phase: PHASE.LIQUID, density: 1000, specificHeat: 4.18,
    melt: 0, boil: 100, conduct: 0.075, ignite: null, colour: [0.10, 0.36, 0.42],
    solidName: 'ice', gasName: 'steam', extinguishes: 12,
  },
  wood: {
    name: 'wood', phase: PHASE.SOLID, density: 620, specificHeat: 1.7,
    melt: null, boil: null, conduct: 0.05, ignite: 300, heatOfCombustion: 17,
    colour: [0.11, 0.075, 0.05], ash: [0.06, 0.055, 0.055],
  },
  grass: {
    name: 'dry grass', phase: PHASE.SOLID, density: 90, specificHeat: 1.4,
    ignite: 180, heatOfCombustion: 14, conduct: 0.22, colour: [0.14, 0.16, 0.05],
  },
  leaf: {
    name: 'leaves', phase: PHASE.SOLID, density: 120, specificHeat: 1.5,
    ignite: 220, heatOfCombustion: 13, conduct: 0.20, colour: [0.07, 0.12, 0.04],
  },
  cloth: {
    name: 'cloth', phase: PHASE.SOLID, density: 300, specificHeat: 1.4,
    ignite: 250, heatOfCombustion: 15, conduct: 0.12, colour: [0.28, 0.24, 0.20],
  },
  petrol: {
    name: 'petrol', phase: PHASE.LIQUID, density: 750, specificHeat: 2.2,
    boil: 95, ignite: 45, heatOfCombustion: 44, conduct: 0.25, explosive: 1.0,
    colour: [0.30, 0.26, 0.10],
  },
  stone: {
    name: 'stone', phase: PHASE.SOLID, density: 2600, specificHeat: 0.84,
    melt: 1200, conduct: 0.03, ignite: null, colour: [0.14, 0.135, 0.128],
  },
  concrete: {
    name: 'concrete', phase: PHASE.SOLID, density: 2400, specificHeat: 0.88,
    melt: 1400, conduct: 0.03, ignite: null, colour: [0.22, 0.215, 0.205],
  },
  brick: {
    name: 'brick', phase: PHASE.SOLID, density: 1900, specificHeat: 0.84,
    conduct: 0.035, ignite: null, colour: [0.145, 0.075, 0.055],
  },
  steel: {
    name: 'steel', phase: PHASE.SOLID, density: 7800, specificHeat: 0.49,
    melt: 1450, conduct: 0.45, ignite: null, colour: [0.30, 0.31, 0.33],
  },
  glass: {
    name: 'glass', phase: PHASE.SOLID, density: 2500, specificHeat: 0.84,
    melt: 700, conduct: 0.08, ignite: null, shatters: true, colour: [0.62, 0.72, 0.76],
  },
  sand: {
    name: 'sand', phase: PHASE.SOLID, density: 1600, specificHeat: 0.83,
    melt: 1700, conduct: 0.05, ignite: null, colour: [0.32, 0.28, 0.19],
  },
  ice: {
    name: 'ice', phase: PHASE.SOLID, density: 917, specificHeat: 2.05,
    melt: 0, conduct: 0.18, ignite: null, colour: [0.55, 0.72, 0.80],
  },
  meat: {
    name: 'meat', phase: PHASE.SOLID, density: 1000, specificHeat: 3.0,
    ignite: 340, conduct: 0.14, cooksAt: 72, colour: [0.32, 0.10, 0.09],
  },
};

/** A quantity of a substance in a container, with its own temperature. */
export class Substance {
  constructor(material, litres = 1, temperature = 15) {
    this.mat = MATERIAL[material] || MATERIAL.water;
    this.litres = litres;
    this.temp = temperature;
    this.phase = this.mat.phase;
    this.cooked = 0;
    this.boiledOff = 0;
    this.sterile = false;
  }

  get mass() {
    return this.litres * this.mat.density * 0.001;
  }

  get label() {
    const m = this.mat;
    if (this.phase === PHASE.SOLID && m.solidName) return m.solidName;
    if (this.phase === PHASE.GAS && m.gasName) return m.gasName;
    return m.name;
  }

  /**
   * Exchange heat with the surroundings and change state if a threshold is
   * crossed. `power` is external heating in kW (a campfire is roughly 20).
   * Returns an event string when something visible happens.
   */
  step(dt, ambient, power = 0, insulation = 1) {
    const m = this.mat;
    const mass = Math.max(0.02, this.mass);
    const c = m.specificHeat;

    // Conductive exchange with the air, plus any direct heating. The rate has
    // to scale with mass: a thimble of water follows the air temperature in
    // seconds, a full pot takes minutes, and that difference is the whole
    // reason a pot on a fire ever reaches boiling.
    const k = (m.conduct * insulation) / Math.max(0.2, mass);
    let dT = (ambient - this.temp) * (1 - Math.exp(-k * dt));
    dT += (power * dt) / (mass * c);
    this.temp += dT;

    let event = null;

    if (m.boil !== undefined && m.boil !== null) {
      if (this.temp >= m.boil) {
        // Latent heat: it holds at boiling point and gives off vapour.
        this.temp = m.boil;
        // Latent heat of vaporisation: 2260 kJ per kilogram, and one litre of
        // water is one kilogram.
        const rate = clamp((power * dt) / 2260, 0, this.litres);
        if (rate > 0) {
          this.litres = Math.max(0, this.litres - rate);
          this.boiledOff += rate;
          if (!this.sterile) {
            this.sterile = true;
            event = 'boiled';
          } else {
            event = 'boiling';
          }
        }
        this.phase = PHASE.LIQUID;
      }
    }
    if (m.melt !== undefined && m.melt !== null) {
      if (this.temp <= m.melt - 0.5 && this.phase === PHASE.LIQUID) {
        this.temp = Math.min(this.temp, m.melt);
        this.phase = PHASE.SOLID;
        event = 'froze';
      } else if (this.temp > m.melt + 0.5 && this.phase === PHASE.SOLID) {
        this.phase = PHASE.LIQUID;
        event = 'thawed';
      }
    }
    if (m.cooksAt && this.temp > m.cooksAt) {
      const before = this.cooked;
      this.cooked = clamp(this.cooked + dt * 0.06, 0, 1.4);
      if (before < 1 && this.cooked >= 1) event = 'cooked';
      if (before < 1.35 && this.cooked >= 1.35) event = 'burnt';
    }
    return event;
  }
}

/**
 * Ambient air temperature at a point, in celsius.
 * Combines the world's climate field with altitude, the time of day, weather
 * and the warmth of any nearby fire.
 */
export function ambientAt(world, x, y, z) {
  const s = world.terrain.sampleAt(x, z);
  let t = s.temperature;
  // Air above the recorded ground temperature still cools with height.
  t -= Math.max(0, y - Math.max(0, s.height)) * 0.0065;
  // Day/night swing, larger in dry places.
  const dayness = world.sky ? world.sky.dayFactor : 1;
  const dryness = 1 - s.moisture;
  t += (dayness - 0.5) * (5 + dryness * 9);
  if (world.weather) {
    t -= world.weather.rain * 3.2;
    t -= world.weather.wind * 1.6;
    t -= world.weather.overcast * 1.2 * dayness;
  }
  // Water is thermally sluggish: much closer to its mean than the air.
  if (s.waterLevel > -Infinity && y < s.waterLevel) {
    const depth = s.waterLevel - y;
    t = lerp(t, s.temperature, clamp(depth / 12, 0, 1));
    t = lerp(t, 4, clamp((depth - 40) / 400, 0, 1)); // the deep ocean is cold
  }
  if (world.fire) t += world.fire.heatAt(x, y, z);
  return t;
}

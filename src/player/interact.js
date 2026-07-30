// Reaching out and touching things.
//
// Every frame this works out the single most interesting thing in front of you
// and offers one verb for it. Holding a different item changes the verb, which
// is the whole interaction language of the game: look at a tree with empty
// hands and you can pick its fruit; look at it holding the axe and you can fell
// it; look at it holding a torch and you can set it alight.

import * as THREE from 'three';
import { Inventory, ITEMS, SEED_NAMES } from './inventory.js';
import { Substance, MATERIAL, PHASE, ambientAt } from '../sim/chemistry.js';
import { makeSolidMaterial } from '../gfx/materials.js';
import { SPECIES_INFO } from '../world/flora.js';
import { clamp, lerp } from '../core/noise.js';

const REACH = 4.2;

export class Interaction {
  constructor(world) {
    this.world = world;
    this.inv = new Inventory(world);
    world.inventory = this.inv;
    this.target = null;
    this.prompt = '';
    this.secondary = '';
    this.ray = new THREE.Raycaster();
    this.ray.far = REACH + 1;
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this.heldTorchLight = new THREE.PointLight(0xffa040, 0, 15, 1.8);
    this.heldTorchLight.visible = false;
    world.engine.scene.add(this.heldTorchLight);
    this.observed = new Set();
    this._swing = 0;

    // Containers set down in the world. They keep their contents and keep
    // simulating where they stand - that is the whole point of a pot.
    this.placed = [];
    this._potGeo = new THREE.CylinderGeometry(0.20, 0.155, 0.24, 10);
    this._potMat = makeSolidMaterial({ key: 'pot', vertexColors: false, flat: true, color: 0x33363b, roughness: 0.55, metalness: 0.6 });
    this._potWaterGeo = new THREE.CircleGeometry(0.16, 10);
    this._potWaterMat = makeSolidMaterial({ key: 'potwater', vertexColors: false, color: 0x1c2f38, roughness: 0.15 });
  }

  _placePot(x, y, z, substance) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this._potGeo, this._potMat);
    body.position.y = 0.12;
    body.castShadow = true;
    const water = new THREE.Mesh(this._potWaterGeo, this._potWaterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.21;
    g.add(body, water);
    g.position.set(x, y, z);
    this.world.engine.scene.add(g);
    const c = { key: 'pot', substance: substance || null, x, y, z, mesh: g, water };
    this.placed.push(c);
    return c;
  }

  update(dt) {
    const w = this.world;
    const p = w.player;
    const inp = w.input;

    const ambient = ambientAt(w, p.position.x, p.position.y + 1, p.position.z);
    const firePower = w.fire.powerAt(p.position.x, p.position.y + 0.9, p.position.z);
    this.inv.update(dt, ambient, firePower);

    // A pot set down keeps simulating: over a fire it boils, on a winter
    // night it freezes. Notes only when you are near enough to notice.
    for (const c of this.placed) {
      c.water.visible = !!(c.substance && c.substance.litres > 0.04);
      if (!c.substance || c.substance.litres <= 0) continue;
      const amb = ambientAt(w, c.x, c.y + 0.2, c.z);
      const power = w.fire.powerAt(c.x, c.y + 0.2, c.z);
      const event = c.substance.step(dt, amb, power, 1);
      if (!event) continue;
      const near = Math.hypot(c.x - p.position.x, c.z - p.position.z) < 22;
      if (event === 'boiled') {
        if (near) w.note('The pot came to a rolling boil.', 'event');
        w.particles.steam(c.x, c.y + 0.3, c.z, 0.8, 6);
      } else if (event === 'boiling' && Math.random() < dt * 6) {
        w.particles.steam(c.x, c.y + 0.3, c.z, 0.6, 1);
      } else if (event === 'froze') {
        if (near) w.note('The water in the pot froze.', 'event');
      } else if (event === 'thawed') {
        if (near) w.note('The ice in the pot melted.', 'event');
      }
    }

    // A lit torch is a real light and a real ignition source.
    const torch = this.inv.find('torch');
    const holdingTorch = this.inv.current.key === 'torch' && torch && torch.lit;
    this.heldTorchLight.visible = !!holdingTorch;
    if (holdingTorch) {
      const f = 0.8 + 0.2 * Math.sin(w.time * 21) * Math.sin(w.time * 13);
      // At the body, not the camera - in third person the camera is metres
      // behind you and a light there would glow from empty air.
      this.heldTorchLight.position.copy(p.eyePosition(this._origin));
      this.heldTorchLight.intensity = 62 * f;
      if (Math.random() < dt * 22) {
        const fwd = p.forward(this._dir);
        w.particles.fire(
          p.position.x + fwd.x * 0.6, p.position.y + p.eye - 0.25, p.position.z + fwd.z * 0.6, 0.3, 1
        );
      }
      if (w.weather.rain > 0.6 && Math.random() < dt * 0.4 * (1 - p.sheltered)) {
        torch.lit = false;
        w.note('The rain put your torch out.', 'event');
      }
    }

    if (inp) {
      // Hotbar.
      for (let i = 0; i < 9; i++) {
        if (inp.hit('Digit' + (i + 1))) this.inv.select(i);
      }
      if (inp.wheel) this.inv.cycle(inp.wheel > 0 ? 1 : -1);
    }

    this._findTarget();
    if (p.sitting && !this.prompt) {
      this.prompt = '<kbd>X</kbd> stand up';
      this.secondary = 'or just move';
    }

    if (inp) {
      if (inp.hit('KeyE') || inp.clicked[0]) this._act();
      if (inp.hit('KeyQ') || inp.clicked[2]) this._altAct();
      if (inp.hit('KeyF')) {
        if (p.vehicle) {
          p.vehicle = null;
          w.note('You stepped out.', 'event');
        } else {
          p.toggleDrift();
        }
      }
    }
    this._swing = Math.max(0, this._swing - dt * 3);
  }

  /* ---------------------------------------------------------------- target */

  _findTarget() {
    const w = this.world;
    const p = w.player;
    // Reach is measured from the body's own eyes: the third-person camera
    // sits metres behind them and would put "in front of you" at your heels.
    p.eyePosition(this._origin);
    p.forward(this._dir);
    const held = this.inv.current;
    const key = held.key;

    if (p.vehicle) {
      this.target = { kind: 'driving', vehicle: p.vehicle };
      const v = p.vehicle;
      this.prompt = `<kbd>F</kbd> step out · <kbd>W/S</kbd> drive · <kbd>Space</kbd> brake${v.blade ? ' · <kbd>B</kbd> blade' : ''} · <kbd>H</kbd> horn`;
      this.secondary = `${(Math.abs(v.speed) * 3.6).toFixed(0)} km/h · fuel ${v.tank.litres.toFixed(0)}L`;
      return;
    }

    let best = null;

    // Vehicles first: they are big and unmistakable.
    const veh = w.civ.nearestVehicle(this._origin.x, this._origin.y, this._origin.z, 3.6);
    if (veh) best = { kind: 'vehicle', vehicle: veh, dist: 0.9 };

    // A door within arm's reach.
    const door = w.civ.nearestDoor(p.position.x, p.position.y, p.position.z, 2.8);
    if (door && (!best || 0.8 < best.dist)) best = { kind: 'door', door, dist: 0.8 };

    // Plants.
    const eye = this._origin;
    const ahead = TMP.copy(eye).addScaledVector(this._dir, 1.9);
    const hit = w.flora.nearest(ahead.x, ahead.y, ahead.z, 2.6);
    if (hit && (!best || 1.0 < best.dist)) best = { kind: 'plant', plant: hit, dist: 1.0 };

    // Fire.
    let nearFire = null;
    let fd = 3.6;
    for (const f of w.fire.fires) {
      const d = Math.hypot(f.x - ahead.x, f.y - ahead.y, f.z - ahead.z);
      if (d < fd) {
        fd = d;
        nearFire = f;
      }
    }
    if (nearFire && (!best || 0.7 < best.dist)) best = { kind: 'fire', fire: nearFire, dist: 0.7 };

    // Something you set down earlier. Beats the fire, so a pot sitting in the
    // flames can still be looked at and lifted out.
    let pc = null;
    let pd = 1.4;
    for (const c of this.placed) {
      const d = Math.hypot(c.x - ahead.x, c.y + 0.15 - ahead.y, c.z - ahead.z);
      if (d < pd) {
        pd = d;
        pc = c;
      }
    }
    if (pc && (!best || 0.65 < best.dist)) best = { kind: 'placed', item: pc, dist: 0.65 };

    // Water within reach.
    const wl = w.terrain.waterAt(ahead.x, ahead.z);
    const gh = w.terrain.heightAt(ahead.x, ahead.z);
    if (wl > -Infinity && wl > gh && ahead.y < wl + 1.1 && (!best || 1.4 < best.dist)) {
      best = { kind: 'water', level: wl, x: ahead.x, z: ahead.z, dist: 1.4 };
    }

    // An animal to watch.
    const animal = w.wildlife.nearest(ahead.x, ahead.y, ahead.z, 4.5);
    if (animal && (!best || 1.2 < best.dist)) best = { kind: 'animal', animal, dist: 1.2 };

    // Otherwise: a building piece, or the bare ground.
    if (!best || best.dist > 0.95) {
      const pieces = w.physics.query(ahead.x, ahead.z, 1.6, SCRATCH);
      let bp = null;
      let bd = 2.2;
      for (const c of pieces) {
        const d = Math.hypot(c.x - ahead.x, c.y - ahead.y, c.z - ahead.z);
        if (d < bd && c.data && c.data.mat) {
          bd = d;
          bp = c.data;
        }
      }
      if (bp && (!best || 1.1 < best.dist)) best = { kind: 'piece', piece: bp, dist: 1.1 };
    }
    if (!best) {
      const groundAhead = TMP2.copy(eye).addScaledVector(this._dir, 2.4);
      const g = w.terrain.heightAt(groundAhead.x, groundAhead.z);
      if (Math.abs(groundAhead.y - g) < 2.2) {
        best = { kind: 'ground', x: groundAhead.x, y: g, z: groundAhead.z };
      }
    }

    this.target = best;
    this._describe(key, held);
  }

  _describe(key, held) {
    const t = this.target;
    const w = this.world;
    this.prompt = '';
    this.secondary = '';
    if (!t) return;

    switch (t.kind) {
      case 'vehicle':
        this.prompt = `<kbd>E</kbd> get into the ${t.vehicle.kind}`;
        this.secondary = t.vehicle.tank.litres > 0.5
          ? `${t.vehicle.tank.litres.toFixed(0)}L of petrol left`
          : 'the tank is dry';
        if (key === 'firestarter' || (key === 'torch' && this.inv.find('torch').lit)) {
          this.secondary += ' · <kbd>Q</kbd> set it alight';
        }
        break;
      case 'door':
        this.prompt = `<kbd>E</kbd> ${t.door.target > 0.5 ? 'close' : 'open'} the door`;
        break;
      case 'plant': {
        const pl = t.plant.plant;
        const info = SPECIES_INFO[pl.sp];
        const m = w.flora.maturity(pl);
        this.secondary = `${info.name} · ${(m * 100) | 0}% grown`;
        if (key === 'axe') this.prompt = `<kbd>E</kbd> fell the ${info.name}`;
        else if (key === 'torch' && this.inv.find('torch').lit) this.prompt = `<kbd>E</kbd> set the ${info.name} alight`;
        else if (pl.slotFruit >= 0) this.prompt = `<kbd>E</kbd> pick ${info.fruit} · <kbd>Q</kbd> take a seed`;
        else if (info.fruit) this.prompt = `<kbd>E</kbd> search the branches · <kbd>Q</kbd> take a seed`;
        else this.prompt = `<kbd>E</kbd> look closer · <kbd>Q</kbd> take a seed`;
        break;
      }
      case 'fire':
        if (key === 'pot' && held.n > 0) {
          this.prompt = `<kbd>E</kbd> set the pot on the fire`;
          const sub = held.substance;
          if (sub) this.secondary = `${sub.label} at ${sub.temp.toFixed(0)}°C`;
        } else if (key === 'canteen') {
          const sub = held.substance;
          this.prompt = sub && sub.litres > 0.05
            ? `<kbd>E</kbd> hold the ${ITEMS[key].name} over the flames`
            : `<kbd>E</kbd> warm your hands`;
          if (sub) this.secondary = `${sub.label} at ${sub.temp.toFixed(0)}°C`;
        } else if (key === 'wood' && held.n > 0) {
          this.prompt = `<kbd>E</kbd> feed the fire`;
        } else if (key === 'torch') {
          this.prompt = `<kbd>E</kbd> light your torch`;
        } else {
          this.prompt = `<kbd>E</kbd> warm your hands`;
          this.secondary = 'it smells of woodsmoke';
        }
        break;
      case 'placed': {
        const sub = t.item.substance;
        this.prompt = `<kbd>E</kbd> pick up the pot`;
        if (sub && sub.litres > 0.04) {
          let s = `${sub.label} at ${sub.temp.toFixed(0)}°C`;
          if (sub.phase === PHASE.SOLID) s += ' · frozen';
          else if (sub.sterile) s += ' · boiled clean';
          this.secondary = s;
        } else {
          this.secondary = 'empty';
        }
        break;
      }
      case 'water':
        if ((key === 'pot' || key === 'canteen') && held.n > 0) {
          const sub = held.substance;
          this.prompt = (!sub || sub.litres < 0.9)
            ? `<kbd>E</kbd> fill the ${ITEMS[key].name}`
            : `<kbd>E</kbd> empty the ${ITEMS[key].name}`;
        } else {
          this.prompt = `<kbd>E</kbd> touch the water`;
        }
        this.secondary = `${ambientAt(w, t.x, t.level - 0.3, t.z).toFixed(0)}°C`;
        break;
      case 'animal': {
        const a = t.animal;
        this.prompt = `<kbd>E</kbd> watch the ${a.sp.name}`;
        this.secondary = a.alert > 0.4 ? 'it has noticed you' : 'it has not noticed you';
        break;
      }
      case 'piece': {
        const p = t.piece;
        const mat = MATERIAL[p.mat.mat];
        this.secondary = `${mat ? mat.name : p.mat.mat}${p.burning ? ' · burning' : ''}`;
        if (key === 'axe') this.prompt = `<kbd>E</kbd> break it`;
        else if (key === 'torch' && this.inv.find('torch').lit && mat && mat.ignite) this.prompt = `<kbd>E</kbd> set it alight`;
        else if (key === 'pot' && held.substance && held.substance.litres > 0.1 && p.burning) this.prompt = `<kbd>E</kbd> douse it`;
        else this.prompt = '';
        break;
      }
      case 'ground':
        if (key === 'seed' && held.n > 0) this.prompt = `<kbd>E</kbd> plant a ${SEED_NAMES[held.species] || 'seed'}`;
        else if (key === 'firestarter' && this.inv.count('wood') > 0) this.prompt = `<kbd>E</kbd> build a fire`;
        else if (key === 'wood' && held.n > 0) this.prompt = `<kbd>E</kbd> stack the firewood`;
        else if (key === 'pot' && held.n > 0) this.prompt = `<kbd>E</kbd> set the pot down`;
        break;
    }
  }

  /* ------------------------------------------------------------------- act */

  _act() {
    const w = this.world;
    const p = w.player;
    const t = this.target;
    const held = this.inv.current;
    const key = held.key;
    this._swing = 1;

    if (p.vehicle) return;
    if (!t) return;

    switch (t.kind) {
      case 'vehicle': {
        const v = t.vehicle;
        p.vehicle = v;
        v.start();
        w.note(`You climbed into the ${v.kind}.`, 'event');
        return;
      }
      case 'door':
        t.door.target = t.door.target > 0.5 ? 0 : 1;
        if (w.audio) w.audio.door(t.door.x, t.door.y + 1, t.door.z, t.door.target > 0.5);
        return;
      case 'plant': {
        const hit = t.plant;
        const pl = hit.plant;
        const info = SPECIES_INFO[pl.sp];
        if (key === 'axe') {
          const yield_ = w.flora.fell(hit);
          this.inv.add('wood', Math.max(1, yield_.wood));
          w.wildlife.startle(pl.x, pl.z, 34);
          if (w.audio) w.audio.chop(pl.x, pl.y + 1, pl.z, true);
          w.particles.leaf(pl.x, pl.y + w.flora.height(pl) * 0.6, pl.z, [0.06, 0.11, 0.03]);
          w.note(`You felled a ${info.name}. (+${Math.max(1, yield_.wood)} firewood)`, 'event');
          return;
        }
        if (key === 'torch' && this.inv.find('torch').lit) {
          pl.burning = true;
          w.fire.ignite(pl.x, pl.y + w.flora.height(pl) * 0.3, pl.z, 1.0, 1.8, hit);
          w.note(`The ${info.name} catches.`, 'event');
          return;
        }
        if (pl.slotFruit >= 0) {
          const fruit = w.flora.pickFruit(hit);
          this.inv.add('fruit', 2 + Math.floor(Math.random() * 3));
          this.inv.add('seed', 1, { species: pl.sp });
          if (w.audio) w.audio.pick(pl.x, pl.y + 1.4, pl.z);
          w.note(`You picked ${fruit}.`, 'event');
          return;
        }
        if (info.fruit) this._searchForFruit(hit);
        else this._examine(hit);
        return;
      }
      case 'fire': {
        const f = t.fire;
        if (key === 'wood' && held.n > 0) {
          this.inv.take('wood', 1);
          f.fuel += 14;
          f.target = Math.min(2.2, f.target + 0.25);
          w.particles.sparks(f.x, f.y + 0.3, f.z, 8, 0.5);
          return;
        }
        if (key === 'torch') {
          this.inv.find('torch').lit = true;
          w.note('Your torch takes the flame.', 'event');
          return;
        }
        if (key === 'pot' && held.n > 0) {
          this.inv.take('pot', 1);
          const gy = w.terrain.heightAt(f.x, f.z);
          this._placePot(f.x, gy, f.z, held.substance);
          held.substance = null;
          if (this.inv.current === held) this.inv.select(0);
          w.note('You set the pot on the fire.', 'event');
          return;
        }
        if (key === 'canteen' && held.substance) {
          w.note(`You hold the ${ITEMS[key].name} over the fire. ${held.substance.temp.toFixed(0)}°C.`, 'event');
          return;
        }
        p.warmth = Math.min(1, p.warmth + 0.12);
        w.note('Warmth. You had forgotten how good it feels.', 'note');
        return;
      }
      case 'placed': {
        const c = t.item;
        w.engine.scene.remove(c.mesh);
        this.placed.splice(this.placed.indexOf(c), 1);
        this.inv.add('pot', 1, { substance: c.substance || null });
        w.note(
          c.substance && c.substance.temp > 55
            ? 'You lift the pot carefully by the rim.'
            : 'You picked the pot back up.',
          'event'
        );
        return;
      }
      case 'water': {
        if ((key === 'pot' || key === 'canteen') && held.n > 0) {
          const sub = held.substance;
          if (!sub || sub.litres < 0.9) {
            const temp = ambientAt(w, t.x, t.level - 0.3, t.z);
            held.substance = new Substance('water', key === 'pot' ? 2 : 1, temp);
            if (w.audio) w.audio.pour(t.x, t.level, t.z, true);
            w.note(`You filled the ${ITEMS[key].name}.`, 'event');
          } else {
            held.substance = null;
            if (w.audio) w.audio.pour(t.x, t.level, t.z, false);
          }
          w.particles.splash(t.x, t.level, t.z, 0.5, 6);
          return;
        }
        w.particles.splash(t.x, t.level, t.z, 0.35, 5);
        if (w.audio) w.audio.pour(t.x, t.level, t.z, true);
        return;
      }
      case 'animal': {
        const a = t.animal;
        if (!this.observed.has(a.sp.key)) {
          this.observed.add(a.sp.key);
          w.note(`You watched a ${a.sp.name} for a while. It did not mind.`, 'discovery');
        } else {
          w.note(`A ${a.sp.name}, going about its day.`, 'note');
        }
        return;
      }
      case 'piece': {
        const piece = t.piece;
        if (key === 'axe') {
          if (w.civ.hitPiece(piece, 9, [this._dir.x * 40, 10, this._dir.z * 40])) {
            if (piece.mat.debris === 'wood') this.inv.add('wood', 1);
          }
          if (w.audio) w.audio.chop(piece.x, piece.y, piece.z, false);
          return;
        }
        if (key === 'torch' && this.inv.find('torch').lit) {
          const mat = MATERIAL[piece.mat.mat];
          if (mat && mat.ignite) {
            piece.burning = true;
            w.fire.ignite(piece.x, piece.y, piece.z, 1.0, 1.8);
          }
          return;
        }
        if (key === 'pot' && held.substance && held.substance.litres > 0.1) {
          w.fire.extinguishNear(piece.x, piece.y, piece.z, 3.2, 1.4);
          held.substance.litres = Math.max(0, held.substance.litres - 1);
          return;
        }
        return;
      }
      case 'ground': {
        if (key === 'seed' && held.n > 0) {
          this.inv.take('seed', 1);
          const sp = held.species !== undefined ? held.species : 0;
          w.flora.plant(t.x, t.z, sp);
          if (w.audio) w.audio.plant(t.x, t.y, t.z);
          w.note(`You planted a ${SEED_NAMES[sp] || 'seed'}. Come back and see.`, 'event');
          return;
        }
        if (key === 'firestarter' && this.inv.count('wood') > 0) {
          this.inv.take('wood', 1);
          const s = w.terrain.sampleAt(t.x, t.z);
          const wet = w.weather.rain > 0.35 || s.waterLevel > s.height - 0.1;
          if (wet) {
            w.note('Too wet. Nothing catches.', 'event');
            w.particles.smoke(t.x, t.y + 0.2, t.z, 0.6, 0.4, 4);
            return;
          }
          const f = w.fire.ignite(t.x, t.y + 0.2, t.z, 1.0, 2.0);
          if (f) {
            f.fuel = 40;
            w.note('A fire. The oldest comfort there is.', 'event');
          }
          return;
        }
        if (key === 'wood' && held.n > 0) {
          this.inv.take('wood', 1);
          w.physics.spawnDebris(t.x, t.y + 0.3, t.z, 0.16, 0.16, 0.9,
            [0.12, 0.082, 0.05], { kind: 'wood', life: 600 });
          return;
        }
        if (key === 'pot' && held.n > 0) {
          this.inv.take('pot', 1);
          this._placePot(t.x, t.y, t.z, held.substance);
          held.substance = null;
          // Empty hands afterwards: the pot slot with nothing in it has no verbs.
          if (this.inv.current === held) this.inv.select(0);
          if (w.audio) w.audio.footstep('stone', 0.4);
          w.note('You set the pot down.', 'event');
          return;
        }
        return;
      }
    }
  }

  /** E on a bearing species with nothing on it: say honestly why. */
  _searchForFruit(hit) {
    const w = this.world;
    const pl = hit.plant;
    const info = SPECIES_INFO[pl.sp];
    if (w.audio) w.audio.footstep('leaves', 0.55);
    const m = w.flora.maturity(pl);
    if (m < 0.55) {
      w.note(`This ${info.name} is too young to be carrying anything.`, 'note');
      return;
    }
    if (!w.flora.bearsFruit(pl)) {
      w.note(`You search the branches. This ${info.name} bears nothing.`, 'note');
      return;
    }
    const hours = w.flora.hoursUntilFruit(pl);
    if (hours > 0.05) {
      w.note(`Picked bare. Another ${fmtHours(hours)} before there is more.`, 'note');
    } else {
      w.note(`Nothing ripe within reach.`, 'note');
    }
  }

  /** E on something that never fruits: just look at it properly. */
  _examine(hit) {
    const w = this.world;
    const pl = hit.plant;
    const info = SPECIES_INFO[pl.sp];
    const h = w.flora.height(pl);
    const m = (w.flora.maturity(pl) * 100) | 0;
    w.note(
      m >= 99
        ? `A full-grown ${info.name}, ${h.toFixed(1)} metres of it.`
        : `A ${info.name}, ${h.toFixed(1)} metres and still growing. ${m}% there.`,
      'note'
    );
  }

  _takeSeed(hit) {
    const w = this.world;
    const pl = hit.plant;
    const info = SPECIES_INFO[pl.sp];
    this.inv.add('seed', 1, { species: pl.sp });
    w.note(`You took a ${info.name} seed.`, 'event');
    if (w.audio) w.audio.pick(pl.x, pl.y + 1, pl.z);
  }

  _altAct() {
    const w = this.world;
    const t = this.target;
    const held = this.inv.current;
    const key = held.key;

    // Eating and drinking are always available.
    if (key === 'fruit' && held.n > 0) {
      this.inv.take('fruit', 1);
      w.player.energy = Math.min(1, w.player.energy + 0.28);
      if (w.audio) w.audio.eat();
      w.note('Sweet. Slightly warm from the sun.', 'note');
      return;
    }
    if ((key === 'canteen' || key === 'pot') && held.substance && held.substance.litres > 0.1) {
      const sub = held.substance;
      if (sub.phase === PHASE.SOLID) {
        w.note('It is frozen solid.', 'note');
        return;
      }
      if (sub.temp > 55) {
        w.note('Far too hot to drink yet.', 'note');
        return;
      }
      sub.litres = Math.max(0, sub.litres - 0.35);
      w.player.energy = Math.min(1, w.player.energy + 0.12);
      w.player.warmth = Math.min(1, w.player.warmth + (sub.temp > 30 ? 0.10 : -0.02));
      if (w.audio) w.audio.drink();
      w.note(sub.sterile ? 'Clean, and still faintly warm.' : 'Cold, and tasting of the river.', 'note');
      return;
    }
    if (!t) return;

    if (t.kind === 'vehicle') {
      const lit = key === 'firestarter' || (key === 'torch' && this.inv.find('torch').lit);
      if (lit) {
        t.vehicle.burning = true;
        t.vehicle.burnT = 0;
        w.fire.ignite(t.vehicle.position.x, t.vehicle.position.y + 0.5, t.vehicle.position.z, 1.4, 2.2);
        w.note('You should probably step back.', 'event');
      }
      return;
    }
    if (t.kind === 'plant') this._takeSeed(t.plant);
  }
}

function fmtHours(h) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  return h < 2 ? 'an hour or so' : `${Math.round(h)} hours`;
}

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const SCRATCH = [];

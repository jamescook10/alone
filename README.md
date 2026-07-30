# ALONE

An endless, procedurally generated open world that runs in a browser tab. There
are no goals, no score, no enemies and nobody else. You wake up somewhere
pleasant and the rest is up to you.

Best played with headphones — the sound is fully three-dimensional.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

Nothing is downloaded at run time. There isn't a single texture, model or audio
file in this repository: every heightfield, tree, animal, cloud, footstep and
birdsong is generated from the world seed while you play.

---

## What is out there

**The land.** An infinite quadtree of terrain streamed in Web Workers, sampled
from a single pure function of `(x, z)` and the seed. Continents, mountain belts
with real ranges rather than noise, erosion, glacial valleys, coastal plains,
ocean shelves, mid-ocean ridges and trenches down past −1800 m. Peaks reach
1800 m and above. The world never ends and never repeats, and two people with
the same seed stand in exactly the same place.

**Water.** Oceans, lakes carved into bowls, and rivers that follow the shape of
the land downhill because their surface is derived from the smoothed terrain
itself. You can wade, swim, dive, and run out of breath. Underwater everything
changes: the fog turns green, caustics crawl over the seabed, the surface becomes
a mirror above you, and every sound in the world is muffled behind a low-pass
filter.

**Sixteen biomes** from abyss to snowfield, chosen from a real climate model —
temperature that falls with altitude and varies by region, moisture that pools
near water. There are genuine deserts, genuine rainforest and genuine ice.

**Weather** that wanders rather than cycling: fronts sweep through, cloud thickens
and thins, rain and snow are decided by the local temperature, and valley fog
gathers on still damp mornings. Lightning flashes, and the thunder arrives at the
speed of sound. Stand out in it and you get wet and cold. Step under a roof and
the rain stops hitting you, the sound changes, and you start to dry off.

**Sky.** A single-scattering atmosphere shared between the sky shader and the
CPU, so the haze on a distant ridge is exactly the colour of the sky behind it.
Raymarched clouds, a moon with a real phase that drifts from night to night, a
star field with a Milky Way, aurora when it is cold and clear, and eye adaptation
so dawn, noon and starlight are all legible.

**Things that grow.** Trees are built procedurally per species and drawn from
packed instance pools, so a forest is a few dozen draw calls. Every one carries
the world-day it sprouted, and growth happens in the vertex shader — trees get
taller while you watch. Pick fruit, take a seed, push it into the ground, and
come back to a sapling that is on its way to being a tree.

**Animals** with one shared skeleton trick: every vertex knows which limb it
belongs to and where that limb pivots, so legs walk, wings beat and fish
undulate entirely on the GPU. Deer, rabbits, boar, wolves, foxes, mountain
goats, camels, songbirds, gulls, eagles, fish, butterflies — and whales, out in
the deep water, which surface to blow. They flock, graze, rest, flee and are
mostly indifferent to you.

**Fire, and the physics of it.** A fire is fuel, intensity and a radius. It warms
everything nearby, and anything with an ignition temperature that gets hot enough
starts burning too. Wind pushes the spread downwind. Rain fights it. Trees
blacken and lose their leaves, grass carries the flame, buildings take damage,
petrol tanks cook off. Light a fire in a dry pine forest on a windy day and you
will regret it.

**Real thermodynamics.** Every container tracks its own temperature and mass. Fill
a pot from a river, hold it over a campfire, and it comes to a rolling boil in
about two minutes. Carry a canteen into a blizzard and it freezes solid. Thaw it
by the fire. None of this is scripted; it falls out of specific heat, latent heat
and a conduction rate that scales with mass.

**What people left behind.** Hamlets, villages, towns and — rarely — cities, laid
out from the seed: streets first, then plots, then a building on each plot. Every
building is assembled from individual pieces — wall panels, floor slabs, roof
sections, panes of glass, furniture — each with its own material, health and
collider. So you can walk in through the door, up to the first floor, and out
through a window. Or you can find the bulldozer, drop the blade, and drive
through the front wall.

**Cars, vans, trucks and a bulldozer**, with four-wheel terrain probing,
headlights that come on at dusk, fuel that runs out, and tanks that explode if
they get hot enough. Drive one into a river and the engine drowns.

**Sound.** Every sound is synthesised. Wind in three bands that opens up as you
climb. Water that knows whether it is a brook, a lake or surf, positioned at the
nearest water's edge and moving as you walk past it. Birdsong that trebles at
dawn. Crickets on warm nights, frogs near water. Footsteps that know what you are
standing on. Fire crackle, engine notes tied to RPM, thunder delayed by distance.
Convolution reverb with a different impulse response for open ground, forest,
valley, indoors and underwater. And a generative score — a slow pad, a drone and
scattered bell tones in a mode chosen by the biome you are standing in, which
swells at dawn and on summits, and goes quiet when you walk into a town.

---

## Controls

| | |
|---|---|
| `W A S D` | walk |
| `Shift` | run |
| `Ctrl` / `C` | crouch |
| `Space` | jump · swim up · brake |
| Mouse | look |
| `E` / left click | use what is in front of you |
| `Q` / right click | second action · eat · drink |
| `1`–`9` / wheel | choose what you are holding |
| `F` | drift — let go of the ground, and land again · leave a vehicle |
| `B` | raise or drop a bulldozer blade |
| `H` | horn |
| `J` | journal |
| `P` | photo mode |
| `M` | mute |
| `O` | cycle the weather |
| `[` `]` | wind time back and forward |
| `Tab` | pause and settings |
| `Esc` | releases the mouse (browser behaviour) — click the view to take it back |

Touch is supported: drag the left half of the screen to move, the right half to
look, tap to interact.

What you can do depends on what you are holding. Look at a tree with empty hands
and you can pick its fruit; look at it holding the axe and you can fell it; look
at it holding a lit torch and you can set it alight. That is the whole
interaction language.

---

## How it is put together

```
src/
  core/      noise and deterministic RNG · renderer, camera, post-processing
  gfx/       shared atmosphere shader · procedural materials and textures · particles
  world/     the world oracle · terrain streaming + worker · sky · weather
             flora · wildlife · civilisation · the World that owns them all
  sim/       materials and phase change · combustion · rigid bodies and explosions
  player/    input · the body · reaching out and touching things · inventory
  audio/     synthesis primitives · the soundscape · the generative score
  ui/        heads-up display, journal, settings
```

Two ideas carry most of the weight.

**The world is a pure function.** `WorldGen.sample(x, z)` answers every question
about a point — height, biome, climate, water, river flow, whether a town's
footprint reaches it — with no stored state. That is what makes the world
infinite, what makes it identical across sessions and machines, and what lets
five Web Workers mesh different parts of it at once without talking to each
other. Only the things *you* change are stored, keyed so they survive chunks
streaming out and back in.

**Everything shares one atmosphere.** A single injected shader function gives the
terrain, the trees, the animals, the buildings and the debris the same
height-based, sun-aware aerial perspective, and the CPU evaluates the identical
model to drive the fog colour, the light colours, the water reflections and the
exposure. Nothing is tuned twice, so nothing disagrees.

Performance: roughly 2.5–4 million triangles and ~250 draw calls in a dense
forest, held there by a cheap far-tier tree that takes over past the nearest ring
of chunks, per-LOD terrain resolution, and instance pools that keep their
buffers packed. If the frame rate does not hold, the game quietly reduces
resolution, then bloom, then shadows, and tells you it did.

---

## Honest notes

- The look is deliberately stylised — low-poly geometry, procedural albedo,
  physically-scaled light. It is not chasing photorealism.
- Ground albedos, sun and skylight intensities are real reflectance and
  irradiance ratios rather than hand-picked colours, which is why the world holds
  up at every hour of the day. It also means an overcast forest floor is
  genuinely dim, because it is.
- Buildings are enterable and destructible piece by piece, but they are assembled
  from boxes; there are no curved roofs or staircases, and you reach upper floors
  by stepping up through the structure.
- Caves are not implemented. The deepest places are ocean trenches.
- The simulation runs at whatever the frame rate is, with a clamped timestep, so
  a very slow machine experiences a slower world rather than a broken one.

## Licence

MIT.

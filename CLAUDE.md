# Working on ALONE

## This is live. Ship continuously.

`main` is production. Every push to `main` triggers `.github/workflows/pages.yml`
and is on GitHub Pages roughly forty seconds later. The link has been shared
publicly, so **assume someone is playing right now.**

**Commit and push fixes without asking.** Do not hold a bug fix waiting for
approval, do not batch fixes up, do not open a pull request for routine work.
Fix it, verify it, push it. That is the workflow the owner has asked for.

Work directly on `main`. Keep `claude/open-world-browser-game-uvqwjp` pointed at
the same commit so the two never diverge:

```bash
git push origin main
git branch -f claude/open-world-browser-game-uvqwjp main   # from another branch
git push origin claude/open-world-browser-game-uvqwjp
```

Ask first only for things that are not bug fixes: deleting features, changing
the feel of the game, reworking the art direction, anything irreversible.

## Because it is live, verify before you push

Shipping fast and shipping broken are different things. A bad push is a black
screen for real people. Always, before pushing:

1. `npx vite build` — a build failure blocks the deploy anyway (`deploy` needs
   `build`), but find out locally, not in CI.
2. `npm run smoke` — boots the real game in headless Chromium, clicks through
   the title screen, runs the simulation and fails on any page error. Needs
   `npm i -D playwright-core` once. See "The test loop" below.
3. `npm run tour` — the same, but it teleports to one example of every biome
   and every landmark kind it can find, and flies the aeroplane. The smoke test
   only ever sees the spot you wake up in, and almost nothing in this world is
   there. Most of what has broken since the world got big broke somewhere else.
4. `npm run flight` — pins the player at 2 m, 280 m and 600 m and checks the
   near ring hands over to silhouettes, that no instance pool count goes
   negative, and that the painted canopy reaches the terrain. Nearly every
   streaming bug so far has been invisible at head height and obvious from
   the air; smoke and tour both measure standing up.
5. Look at a screenshot **only when pushing straight to `main`**. This is a
   game; a change that compiles and throws no errors can still be visibly
   wrong. Several bugs here rendered perfectly cleanly and looked terrible.
   `npm run postcards -- shots/` takes one of each biome in a single browser
   session. When working on a branch the owner will review, skip the
   screenshot pass - it is quicker for them to check out the branch and boot
   the game for real than for headless SwiftShader to render it.
6. If you touched the sky, `npm run skyshots -- shots/` instead. It stands you
   on an open hilltop with no town in sight and takes the Milky Way, the moon's
   phases, an aurora, a meteor, dawn, dusk, cirrus, a rainbow and a lightning
   stroke - forcing each, because most of them happen on a few nights a year
   and you cannot wait for one. Pass a substring as the fourth argument to
   shoot only the matching frames.
7. If you touched water or rain, `npm run watershots -- shots/` instead. It
   stands you at a lake shore, beside a river, in a soaked storm (puddles,
   heavy streaks, droplets on the lens) and in drizzle - postcards only ever
   catches whatever weather it happens to get, which is usually none.

If you push something that turns out to be broken, revert first and diagnose
second: `git revert <sha> && git push origin main` puts players back on a
working build in under a minute.

## The test loop

Headless Chromium is available at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, with WebGL via
SwiftShader. Launch flags that work:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--ignore-gpu-blocklist --no-sandbox --disable-dev-shm-usage
```

Two things to know or you will waste an hour:

- **SwiftShader is software rendering, roughly 0.2–3 fps here.** Shader
  compilation alone can take 30+ seconds before the first frame. Wait 40–60
  seconds after clicking "step outside" before measuring anything. Frame rates
  measured here mean nothing about real hardware; draw calls and triangle
  counts mean everything.
- **The simulation advances with the frame rate**, and `dt` is clamped to 0.05,
  so at 1 fps the world moves 20× slower than real time. To exercise game
  logic, drive it directly instead of waiting:
  `for (let i = 0; i < 900; i++) world.update(0.033)` — that is 30 seconds of
  world in one call, and it is how wildlife, weather, fire and growth were
  tested.

`window.__game` exposes `engine`, `world`, `cam`, `fps`, `running`, `errors`
and `biomeInfo` for exactly this.

`node scripts/survey.mjs [seed]` needs no browser at all: the oracle is pure
JavaScript, so it samples a hundred-kilometre square in about a second and
prints the biome shares, the relief histogram and the settlement counts. It is
by far the cheapest way to answer "are mountains everywhere again?" - use it
before you spend two minutes on a screenshot.

## Performance budgets — do not regress these

Measured in a dense forest and in a city. If a change pushes past these, it
needs to pay for itself:

| | budget |
|---|---|
| triangles per frame | 2.5–4 M |
| draw calls | ~250 (up to ~310 in a city) |
| shaded pixels | ~2.6 M (`defaultPixelRatio()` targets this) |
| pieces per settlement | 42 000 hard cap |
| instanced pools on screen | keep empty ones hidden, not merely zero-count |

There are thirty-three plant species and forty-odd animals, one instanced pool
each, so most pools are empty most of the time - `Pool.commit` hides them rather
than relying on a zero-instance early-out. Far-distance trees are pooled by
*silhouette form*, not by species (eight pools, not thirty-three), with the
species colour and height carried on the instance; that alone was worth a dozen
draw calls every time the far ring crossed a biome boundary.

Both of the big performance disasters so far came from the same mistake:
building something correct without asking what it costs at scale. A city
reached 23.2 M triangles and 2982 draw calls. The forest reached 6.1 M
triangles. Count before you build.

## Things that cost real debugging time

- **Pointer lock must be requested inside a user gesture.** Asking from a
  `setTimeout` after loading is silently refused. It is requested in the "step
  outside" click, and any click on the canvas takes it back.
- **`vertexColors: true` on a bare `BoxGeometry` renders black.** The missing
  attribute defaults to zero. Building pieces are coloured per instance, so
  that material must set `vertexColors: false`.
- **Never enable `logarithmicDepthBuffer`.** It writes `gl_FragDepth` in every
  fragment shader, killing early-Z on every GPU. If you re-enable it, every
  custom `ShaderMaterial` also needs the `<logdepthbuf_*>` chunks or it will
  fail the depth test invisibly — that is what made water not render at all.
- **`injectAtmosphere` can only be applied once per material.** It replaces
  `#include <fog_pars_vertex>`; a second call finds nothing to replace and the
  attribute declarations vanish while the code that uses them stays. Chain onto
  `onBeforeCompile` and target `varying vec3 vWorldPos;` instead — see
  `Wildlife._patch` and `Flora._patchGrowth`.
- **three.js strips `.`, `[`, `]`, `:` and `/` out of node names on load**,
  because those are the separators its animation-track paths are built from.
  Nothing in the game loads a rigged model any more, but if anything ever
  does again: a bone authored as `upperleg.l` arrives as `upperlegl`, and a
  lookup table keyed the other way misses every limb, changes nothing, and
  reports no error.
- **`Pool.free(i)` removes an instance; there is no argument-less form.**
  A helper added as `free()` meaning "how many slots are left" resolved to the
  same method, so every capacity check quietly deleted one instance from each
  pool it looked at. Counts drifted negative, forests thinned as you flew, and
  nothing threw. The accessor is `headroom()` for that reason.
- **Freeing a chunk's instances in allocation order double-frees them.**
  `Pool.free` swap-removes: it moves the pool's last instance into the freed
  slot and tells its owner. When that owner is the chunk being torn down, the
  slot list being iterated is rewritten under the loop to a slot already
  released. Free highest-slot-first, grouped by pool.
- **Tier and LOD decisions must use three-dimensional distance.** Priced on
  `dx`/`dz` alone, the ground under an aeroplane is nought metres away and
  keeps its full-detail trees, so flying paid the near-ring bill for scenery
  two hundred metres below. `npm run flight` exists to catch exactly this.
- **Painted detail keyed on chunk LOD draws a square on the ground.** The
  canopy that stands in for distant trees is baked on every chunk and faded in
  by *camera distance* in the shader; keying it to `lod >= 2` made every LOD
  boundary a hard-edged square of darker green in the middle distance.
- **A `ShaderMaterial` gets no free uniform declarations, and a shader that
  fails to compile draws nothing without throwing.** `ATMO_PARS` declares the
  atmosphere uniforms it uses; `uPlayerPos` is in the shared `atmo` object but
  is *not* in `ATMO_PARS`, so using it in the water shader failed the whole
  program. three.js logs that to the console and carries on, no exception, no
  page error — so smoke and tour both passed while every lake and river in the
  world was invisible, and the lit riverbed showing through looked plausible
  enough to burn several rounds of screenshots chasing a foam bug that did not
  exist. `npm run watershots` now fails loudly on shader console errors. If
  water ever disappears, check the console before you touch the maths.
- **Two transparent surfaces at nearly the same height produce moire.** The
  horizon plate sits at −2.2 m, writes depth and draws before the water.
- **Physically scaled light needs physically scaled albedo.** Ground colours in
  `BIOME_INFO` are reflectances, not display colours. Raising one without the
  other is what made the first builds look like washed-out plastic, and then
  like midnight.
- **The filmic curve is roughly quadratic near black, and it eats night skies.**
  A physically scaled moonless zenith of 0.006 comes out of ACES at 0.0004,
  which is one value in eight bits — the Milky Way, the aurora and every star
  went with it. Two things fix it and they are not interchangeable: exposure
  rises to 1.55 after dark (`Sky._applyLights`, and a full moon pulls it back
  down, the way a full moon really does), and the night stops in `STOPS` are
  painted well above the radiance they represent. That second lift belongs to
  the *dome and the fog only* — skylight scales back by the same factor at
  night, or an unlit hillside comes out brighter than the sky above it.
- **The horizon under the sun and the horizon behind you are different
  colours.** One warm stop applied all the way round turned every sunset into a
  flat red wash from the ground to the zenith. `uHorizonCool` is the away-side
  colour and `atmoApply` makes the identical azimuthal blend — change one,
  change both, or distant hills glow warm against a cool sky.
- **Instanced pools filled by a raster scan run out in the near corner.** Under
  a solid overcast nearly every cloud cell is occupied, so the row-by-row loop
  spent all eighty stratus slots on the first two rows and left the rest of the
  sky empty. `Clouds.update` walks outward in square rings so the cap only ever
  drops the furthest cloud.
- **Additive geometry must not be `transparent: true`.** Three puts transparent
  objects in a queue that renders after all the opaque ones, so a negative
  `renderOrder` stops meaning anything and the star field hangs in front of the
  hills. `transparent: false` with `blending: AdditiveBlending` keeps it in the
  opaque queue where the render order still holds.

## Architecture in one paragraph each

**The world is a pure function.** `WorldGen.sample(x, z)` answers everything
about a point with no stored state, which is what makes the world infinite,
identical across machines, and meshable by five Web Workers that never talk to
each other. Only player changes are stored, in `world.edits`, keyed so they
survive chunks streaming out and back.

**A region has to feel like one place.** This is a harder constraint than
variety, and the first version of the big world failed it badly: a ten-kilometre
walk moved you 13 °C on average and up to 60 at worst, only a third of that walk
was in any one biome, and twenty-six different kinds of country sat within
10 km. Forty biomes are worth nothing if you cross six of them on the way to the
river - there is nothing left to travel for. The climate and province fields are
now roughly an order of magnitude slower, and `npm run survey` prints the
numbers that matter. Keep them near these:

| | target |
|---|---|
| air temperature change over a 10 km walk | ~4 °C median, under 10 at the 90th |
| share of a 10 km walk in one biome | 70%+ |
| kinds of country within 10 km | 3-5 |
| distance before a 15 °C change | 50 km+ median |
| kinds of country within 150 km | 20+ |

The last two lines are the point: the variety is all still there, it is just far
enough away to be worth going to. Local interest inside a region comes from
things the player can *see the reason for* - altitude and its lapse rate, rivers
and lakes, the coast, the landform province - not from the climate flickering.

**Landform first, then climate, then biome.** A slow field with a wavelength of
tens of kilometres (`WorldGen.landform`) decides what *kind* of country a region
is - plain, downs, plateau, karst, sand sea, archipelago, volcanic waste,
mountain range - and the noise stack is then scaled by it. Mountains need both a
mountain belt and a high-relief province, which together cover a few per cent of
the map; that is deliberate, and it is why the world is mostly flat. Temperature
and moisture are pushed through `rank()` and then through splines authored as
*quantiles*, so "the coldest twelfth of the world" means exactly that. Vegetation
is chosen on effective moisture, not rainfall: cold ground keeps far more of what
falls on it, which is the one line that lets the same two noise fields make both
a Sahara and a peat bog. If you retune any of this, run `npm run survey` and look
at both the shares *and* the coherence block before and after.

The small high-frequency term added to each climate field is not a second
climate - it is ±1 °C over a few hundred metres, and its only job is to fray the
edge wherever a threshold happens to fall, so a boundary is a mottled band a few
hundred metres wide instead of a drawn line. Four fifths of boundaries interleave
that way. Raise its amplitude and you get the old flickering world back.

**Rivers are traced, not painted.** They used to be a band of `|fbm|` noise,
which is why one could run along the side of a mountain and why its surface,
tied to the local ground height, draped down that mountain. `WorldGen` now
offers a spring on a coarse lattice wherever the country is wet and high
enough, and *walks* the channel downhill over the smooth base height until it
reaches the sea, runs into a lake (which it enters and leaves again at the
lowest point of the rim) or runs out of length. Three things fall out of that
and none of them could be had from noise: it can only flow downhill, its
surface is monotonic and the ground is then cut down to meet it — so water is
always *in* the land — and two springs in the same valley converge into one
river with nothing arranging it, which is where confluences and the way a
river widens downstream both come from. Two tiers, because a real network is
mostly short streams: trunk rivers on a 3 km lattice, brooks on a 700 m one,
giving ~0.33 km of channel per km² and water a median 400 m walk away. A path
depends only on its own spring cell, so the five workers and the main thread
trace identical rivers without talking. Channel width and depth go as √Q
(`channelWidth`/`channelDepth`), and white water comes off the traced gradient
carried to the mesh on the `fall` vertex attribute — never off flow speed,
which a placid river also has.

**Everything people left is made of the same boxes.** `Build` in
`civilisation.js` owns the destructible-piece machinery; `District` (a
settlement) and `Outpost` (a farmstead, a lighthouse, a shipwreck, an airstrip)
both extend it, so anything out in the country burns, collapses and can be
driven through exactly the way a town house does. What may stand where is
decided by the oracle in `WorldGen.siteCell`, and it is decided on the local
biome and slope - there are no tarmac roads in the jungle and no lighthouses
inland, and keeping it that way is most of what makes the world feel real.

**Everything shares one atmosphere.** One injected shader function gives
terrain, trees, animals, buildings and debris the same fog, and the CPU
evaluates the identical model (`Sky._radiance`) for fog colour, light colour,
water reflection and exposure. Change one, change both, or the horizon splits.

**The sky is a real one.** Everything above the horizon hangs on one 3×3 matrix
in `stars.js`, built from the local sidereal time and a latitude that follows
the region's climate — cold country gets a polar sky, jungle a tropical one, and
it eases slowly enough that you never catch it moving. The sun's ecliptic
longitude drives that sidereal time, so the seasons, the four-minute nightly
drift of the constellations, and the moon's phases are consequences rather than
fudges. Stars are a real catalogue (`starData.js`: right ascension, declination,
magnitude and B–V for about 130 named stars in 23 figures) drawn as one `Points`
call with a procedural field of fainter ones behind; planets are five circular
heliocentric orbits differenced against the Earth's, which is why Venus is never
far from the sun and Mars flares up at opposition. The Milky Way, the nebulae,
the aurora and the meteors live in the dome shader in `sky.js`. Anything new up
there should be authored in the frame it actually belongs to and rotated by
`Stars.skyRot`, not painted onto the dome in world space.

```
src/core/    noise + RNG · renderer, camera, post chain
src/gfx/     atmosphere injection · procedural materials · particles
src/world/   biomes (the table of places) · worldgen oracle
             terrain + worker · sky · stars + star catalogue · weather
             clouds · flora · wildlife · civilisation · World (update order)
src/sim/     chemistry (heat, phase change) · fire · physics
src/player/  input · player body · the camera · interaction · inventory
src/audio/   synthesis · soundscape · generative score
src/ui/      hud, journal, settings
```

## House style

- **The game ships no assets and loads none.** There is no `public/`, no
  runtime loader, and every request a player makes is the HTML, the JS, the
  CSS and the terrain worker — about 250 KB gzipped. It got back to that in
  two steps: the flat-shaded restyle stopped anything reading the baked tree
  and terrain packs, and taking the third-person camera out took the player's
  animated body with it. The packs then sat in the deploy for a while being
  downloaded by nobody, and were deleted.
- The bake scripts stay, and they are the canonical form: `bake-trees.mjs`
  (ez-tree, MIT) and `bake-terrain.mjs` regenerate their packs into
  `public/assets/` from nothing but a command, vendoring their own licence
  files as they go. If a baked look ever returns, run them and write a loader
  again. Prefer that to checked-in binaries — a derived artifact in the repo
  is one nobody can tell is stale, and the "generated world" spirit survives
  the script far better than it survives the output.
- Budgets, if baked trees ever come back: ~600–1100 triangles near, ~60–100
  far. The near ring holds hundreds of full-detail trees at once; the far
  pools start past ~200 m, so both numbers matter.
- Comments explain *why*, especially where a number was tuned or a trap was
  avoided. Do not narrate what the code already says.
- Commit messages: what changed and what it fixes, with the measurement if
  there is one. The commit log is the record of why the game is the way it is.

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
3. Look at a screenshot. This is a game; a change that compiles and throws no
   errors can still be visibly wrong. Several bugs here rendered perfectly
   cleanly and looked terrible.

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

`window.__game` exposes `engine`, `world`, `cam`, `fps`, `running` and
`errors` for exactly this.

## Performance budgets — do not regress these

Measured in a dense forest and in a city. If a change pushes past these, it
needs to pay for itself:

| | budget |
|---|---|
| triangles per frame | 2.5–4 M |
| draw calls | ~250 (up to ~310 in a city) |
| shaded pixels | ~2.6 M (`defaultPixelRatio()` targets this) |
| pieces per settlement | 42 000 hard cap |

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
- **Two transparent surfaces at nearly the same height produce moire.** The
  horizon plate sits at −2.2 m, writes depth and draws before the water.
- **Physically scaled light needs physically scaled albedo.** Ground colours in
  `BIOME_INFO` are reflectances, not display colours. Raising one without the
  other is what made the first builds look like washed-out plastic, and then
  like midnight.

## Architecture in one paragraph each

**The world is a pure function.** `WorldGen.sample(x, z)` answers everything
about a point with no stored state, which is what makes the world infinite,
identical across machines, and meshable by five Web Workers that never talk to
each other. Only player changes are stored, in `world.edits`, keyed so they
survive chunks streaming out and back.

**Everything shares one atmosphere.** One injected shader function gives
terrain, trees, animals, buildings and debris the same fog, and the CPU
evaluates the identical model (`Sky._radiance`) for fog colour, light colour,
water reflection and exposure. Change one, change both, or the horizon splits.

```
src/core/    noise + RNG · renderer, camera, post chain
src/gfx/     atmosphere injection · procedural materials · particles
src/world/   worldgen oracle · terrain + worker · sky · weather
             flora · wildlife · civilisation · World (owns update order)
src/sim/     chemistry (heat, phase change) · fire · physics
src/player/  input · player body · interaction · inventory
src/audio/   synthesis · soundscape · generative score
src/ui/      hud, journal, settings
```

## House style

- No assets. Every texture, mesh and sound is generated at run time. Keep it
  that way — it is the whole point, and it keeps the download tiny.
- Comments explain *why*, especially where a number was tuned or a trap was
  avoided. Do not narrate what the code already says.
- Commit messages: what changed and what it fixes, with the measurement if
  there is one. The commit log is the record of why the game is the way it is.

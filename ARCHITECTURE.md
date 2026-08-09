# Architecture

How Subsurface is put together, and — where it matters more — why. `README.md`
says what the project is; `docs/design-spec.md` is the source of truth for
*intent*, and code comments reference its section numbers (§4.1, §5, …) so a
decision can be traced back to the reason for it. This file is the source of
truth for *shape*: what the pieces are, which way the dependencies point, and
which constraints are load-bearing rather than incidental.

---

## The layers

```
              docs/play/index.html        markup, styles, the <script> tags
                       │
              docs/play/app.js            canvas, input, HUD, star tiers
                       │
       ┌───────────────┼────────────────┐
       │               │                │
  levels.js       bodies.js          sim.js
  (the bank)   (rigid bodies)   (the cellular grid)
                       └────────┬───────┘
                          vendor/planck.min.js
```

Dependencies point **downward only**. `sim.js` knows nothing about the DOM, the
bodies layer, or the bank; `bodies.js` knows about `sim.js` and planck;
`app.js` knows about all of them. Nothing below `app.js` may reach upward.

That is not tidiness. `sim.js` running unchanged under Node is what makes the
solver possible at all — the judge plays a level by *running the real rules*
rather than by modelling them, and a second implementation of the rules to keep
in step with the first would be worse than no judge.

### `docs/play/sim.js` — the cellular grid

A dense `Uint8Array` of material ids, stepped bottom-up with an alternating
horizontal scan direction. Fluid, sand, wet sand and gravel move; clay, bedrock,
the collector and drains do not. Pressure is a cheap stand-in for a real solve:
one top-down pass records how deep each fluid cell sits in a contiguous column,
and that depth raises its lateral flow probability.

Three things about it are contracts, not implementation details:

- **Volume is conserved.** `released = inPlay + collected + lost + heldBySand`,
  asserted after every step by the test suite. Wet sand *holds* a unit rather
  than destroying it and gives it back under pressure, so a saturated band is a
  delay and a reservoir, not a leak.
- **It is deterministic.** All randomness comes from the seeded `mulberry32`
  PRNG. Same seed, same run, forever — which is what makes both the integration
  tests and the level bank meaningful.
- **Out of bounds reads as bedrock.** A level is sealed unless a drain says
  otherwise, so fluid can never fall off the edge of the grid uncounted.

**Heat vents (`VENT`)** are the one hazard whose cost is measured in *time*
rather than in ground: every other hazard punishes where you cut, and a vent
punishes how long the payload spends beside it. They are uncuttable, they do not
move, and a unit they boil off is counted as **`lost`**, not as a fifth bucket —
`lost` has always meant "removed from play and not collected", which is exactly
what evaporation is. That keeps the conservation invariant true for the right
reason, and it means the solver's ceiling calculation already knows a level
dawdled through becomes unwinnable, without being told vents exist. They arrive
at stage 31, which is where spec §5 puts environmental hazards.

`buildLevel()` also lives here: it turns a **spec** into terrain. See below.

### `docs/play/bodies.js` — the rigid-body layer

Fractured rock is pre-scored into chunks at build time; cutting any part of a
chunk detaches the whole thing into a planck body. The two-way contract with the
grid is the part no library provides:

- bodies stamp their occupied cells into `sim.mask`, and `sim.get` reports those
  cells as bedrock — so every cellular rule treats a rock chunk as solid without
  knowing rigid bodies exist;
- grid fluid exerts buoyancy and pressure on the bodies.

Everything else — collision response, friction, restitution, the solver — is
planck's.

### `docs/play/app.js` — the browser harness

Rendering into an `ImageData` buffer blitted whole, pointer input, the HUD, and
the star tiers. **The tiers are 3★ at 97%, 2★ at 92%, 1★ at 85%**, and they are
mirrored in `tools/solve.js` because the whole level-quality criterion is
expressed in them. If they move in one place they must move in the other.

---

## What a level is

A level is a **spec**: a flat object of dials — where the strata sit, how wide
the corridor is, how big the crystal and its apron are, how far the shelves
reach, how much the cavern floor is crowned. `buildLevel()` takes one and emits
terrain. There are two ways to get one, and they meet at the same builder:

```
  difficultyFor(n)          the curve — a level number in, a spec out
         │
         │  generator samples around it, solver judges the samples
         ▼
  docs/play/levels.js       the bank — the specs that were judged good
         │
         ▼
  buildLevel({ spec })      one builder, so a banked level and a derived one
                            cannot diverge in how they are interpreted
```

**The bank wins where it has an entry; the curve is the fallback.** A level with
no banked entry still builds, so a short or missing bank is a smaller game
rather than a broken one. `tools/bank.js#specFor(n)` is the single place that
decision is made, and every tool goes through it so that "what is level 7" has
exactly one answer.

A banked entry records **every** dial, not just the ones the generator varied.
A spec that inherits half its values from `difficultyFor()` changes meaning when
the curve is edited, and then a banked level is no longer the level that was
verified. `test/bank.test.js` pins the round trip cell-for-cell.

### Why the bank is a script and not JSON

The game is a handful of plain `<script>` tags with no build step and no runtime
network calls, which is what makes it a PWA that works offline from the first
load. Fetching JSON would make level building asynchronous, and that reaches
into `reset()`, the service worker and the end-to-end tests — all to express an
array of numbers. So `levels.js` is a UMD module like `sim.js`: `require`-able
in Node, a global in the browser, precached by the same list as everything else.

### Resolution

Levels are authored in **fractions** of the grid, so the same spec builds at any
size. The simulation does **not** behave identically across sizes — a channel
four cells wide is a different channel at 90 cells across than at 120 — so
everything that makes a claim about level quality runs at the play resolution,
**120 × 200**. The bank records the grid it was verified at for that reason.

---

## Judging levels

`tools/solve.js` is the judge. It plays a level the way a player would, by
cutting channels and watching what the fluid does. That is slow, and it is the
point.

Four families of **plan**:

| family | what it models | why it exists |
|---|---|---|
| `naive` | ten straight shafts across the level | if one wins, the answer is "drag downwards" |
| `route` | the level's own intended lane, corner by corner | if this fails the level has no answer the game knows |
| `rough` | the route cut by somebody with the idea but not the precision | the only way to see whether a near miss still gets home |
| `collapse` | drop a gravel pocket, let it settle, then route | the one constructive move in the game |

`profile()` runs them, keeps **every** score, and reports a histogram over the
star tiers plus three clauses:

- **ace** — some plan reaches 3★. There *is* a line, and finding it is worth
  something.
- **forgiving** — some plan lands in [85, 92). A near miss still gets home.
  Without this the level is a lock rather than a puzzle.
- **hard** — every naive drop is under 85%.

All three, and the level is `fun`. Two of them alone are satisfied by a level
with exactly one answer and a cliff either side of it.

### Two measurement details that are easy to get wrong

- **Stopping and giving up are different thresholds.** `stopAt` ends a run once
  the score is banked (nothing later can un-collect it); `giveUpBelow` abandons
  it once the score is unreachable. Conflating them makes every leaking plan
  report near zero, which hides the whole 85–92 band.
- **Rejection order is chosen by rarity, then cost.** The route goes first (one
  simulation kills anything with no answer). The rough family goes second: it
  answers the rare question *and* is cheap, since its plans settle in a thousand
  steps. The naive drops go last because they are the expensive ones — a shaft
  that meets the roof leaves the payload working along a shelf for several
  thousand steps to resolve into a verdict of nought. Measured on one candidate:
  rough family six seconds, naive family fifty.
- **Nothing is truncated once it has been started.** The rough family runs to
  the end even after it has seen enough to accept, so a spec that survives every
  stage leaves with a *complete* distribution. Truncating saved three seconds
  and forced a second full profile — fifty seconds — to rank or record it.

---

## Generating levels

```sh
node tools/generate-levels.js 1 24 --tries 8 --keep 2 --seed 1
```

`tools/generate-worker.js` samples specs around the curve, rejects the
structurally pointless ones for free by looking at the built geometry, profiles
the rest, and keeps the best that meets the criterion for its level number.

- **The band flags are never sampled.** Which materials a level contains is the
  teaching order (spec §5); a generator that put fractured rock in level 6
  because it scored well would be optimising the wrong thing. Shape is fair
  game, progression is authored.
- **Levels 1–3 are judged differently.** They teach the basic move, so they are
  *supposed* to fall to a straight drop.
- **Runs are deterministic**: same range, same seed, same bank byte for byte, so
  a regenerated bank is reviewable as a diff.
- **It does not run in CI.** It is minutes per level by design. CI checks the
  bank that came out.

Two budgets, because they bound different failure modes: `--tries` caps a level
that is going badly, `--keep` caps one that is going well. An acceptance costs
the full plan set — tens of seconds — where a rejection costs a few, so without
the second cap the search spends most of its time choosing between candidates
that are already good enough.

A run **merges** over the existing bank rather than replacing it, so a level the
search could not fill on the first pass can be given another go at a wider
budget without disturbing the rest:

```sh
node tools/generate-levels.js 15 15 --tries 40 --keep 1 --seed 7
```

---

## Tests and CI

| file | what it covers |
|---|---|
| `test/sim.test.js` | the cellular rules, conservation, and level geometry |
| `test/bodies.test.js` | the grid ↔ rigid-body contract |
| `test/solve.test.js` | the judge itself — the decision rule and the two measurement bugs it has had |
| `test/bank.test.js` | the bank round trip: a banked level is the level that was measured |
| `test/levels.test.js` | the levels themselves, by playing them |
| `test/vendor.test.js` | the committed planck bundle matches the installed one, and the service worker precaches only files that exist |
| `test/e2e/` | the game in a real browser: title screen, playing, restart, level jump, installability, offline, cache staleness |

`test/levels.test.js` forks `tools/verify-levels.js`, which runs a process per
core. It lives inside the ordinary test run rather than in a job of its own for
two reasons: it is the same kind of claim as everything else there — a rule the
game has to obey — and Node's runner gives each file its own process, so it runs
alongside the other suites instead of after them.

**Banked levels are gated on the full criterion; derived levels are reported on
only.** The generator searched until it found terrain that met the criterion and
wrote down what it measured, so a banked level failing now means the bank has
drifted from the rules — regenerate rather than lower the bar. A derived level
has never claimed to meet the criterion, and gating on one would be gating on
the difficulty curve happening to be lucky at that number.

**Watch the clock.** Judging by playing costs twenty-odd simulations per sampled
level, which is the long pole in `npm test` by a wide margin — about eight
minutes of a nine-minute suite on a four-core machine, and about five of the
`unit` job's ten-minute timeout on a GitHub runner. The sample is already down
to four and skips the teaching levels, because the criterion does not apply to
them. Before adding work here, measure it; and if the sample ever needs to grow,
the only lever left is `timeout-minutes` in the workflow — which agents cannot
edit, so hand the owner the YAML.

**Level-quality work belongs inside `npm test`, not in a new workflow file.**
Agents working on this repo cannot write to `.github/workflows/` (OAuth scope),
so a check that needs to run in CI has to reach CI through the test suite. The
existing `unit` job has a 10-minute timeout; the level pass is the long pole in
it.

`.github/workflows/ci.yml` runs `npm test` and the Chromium end-to-end pass on
every pull request. Both must pass.

---

## Things that have bitten, and the shape of the fix

Kept here because each one looked like a small local choice and turned out to be
structural.

- **A test aimed at a fraction of the width tests something else tomorrow.**
  The generator moves the basin, the lane and the shelves. Three tests silently
  ended up asserting that the *safe* route fails. Ask the geometry where the
  material is: `sim.geometry` in Node, `window.__subsurface.geometry` in the
  browser.
- **Sand slumps into any diagonal channel and seals it.** The lane must cross
  the sand band vertically, and shelves must stay above the band. Every
  unwinnable late level turned out to be a plugged diagonal.
- **Fluid's lateral reach is 10 cells**, so a flat cavern floor forgives almost
  any aim — which made every plan, exact or wild, score within a point of every
  other. The crown (`floorSlope`) is what makes aim matter.
- **The crown has to be built upward.** Dropping the flanks below the crystal
  pushes them past the bottom of the grid, the floor-drawing loop runs zero
  times, and the drains vanish — leaving a sump that funnels everything home. A
  crown meant to punish a miss rewarded it.
- **A shelf must reach far enough to roof the crystal.** Gating that on leaving
  a corridor-wide gap meant no mid-level basin could ever be roofed, so the
  levels that most needed a puzzle were the ones that got a straight drop. What
  has to fit through a gap is a shaft, not the corridor.
- **`levels.js` is precached by the service worker**, and `cache.addAll` rejects
  wholesale if any entry 404s. Removing the bank file means removing it from
  `SHELL` too.
- **A worker pool that deals round-robin can deal every expensive job to one
  worker.** The sampled levels are evenly spaced by construction, so their
  spacing lines up with the core count whenever one divides the other — four
  samples over sixteen levels on four cores put all four on one worker, and the
  wall clock went *up* when the total work went down. Deal the known-expensive
  jobs first, one per worker, then fill in around them.
- **A browser drag has two ends, and both of them move.** Four end-to-end tests
  started their stroke at a fixed 0.3 of the height; a level whose clay seal
  sits at 0.265 leaves three rows of unbroken clay above that, so the shaft
  never reached the reservoir. Each failure reported something that sounded like
  a game bug rather than a test aimed at the wrong row. Drags now take both ends
  from the geometry.
- **The pick stream comes off the seed, and used to not.** `withDefaults()`
  rebuilt it only when the merged spec had no `pick` — which never happened,
  because the curve copied in above always brings one. A spec asking for a
  different seed got the placements belonging to the level of that number, and
  the seed reached nothing but the cosmetic noise.

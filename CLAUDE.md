# Subsurface — working notes

Read `ARCHITECTURE.md` for how the system is put together and `docs/design-spec.md`
for why the game is the way it is. This file is the standing guidance: how to
work in this repo, and the traps that have already cost somebody an afternoon.

## Workflow

- **One branch per change**, and **always a PR** — however small, however green
  it already is locally. Nothing lands on `main` by direct push.
- **Merge as soon as the checks pass.** Do not leave a green PR sitting open at
  the end of a session. If CI fails, fix it and push again rather than merging
  around it.
- **One change per PR.** Scope is judged by *what changed for the player*, not
  by how many files moved: a fix and the test that pins it are one change; a fix
  and an unrelated tidy-up found along the way are two. A PR that does one thing
  can be reviewed, reverted and bisected on its own.
- After a merge, start the next change from a freshly updated `main`.
- CI is `.github/workflows/ci.yml`: `npm test` plus the Chromium end-to-end
  pass. Both must pass.

**You cannot write to `.github/workflows/`** — the OAuth scope forbids it. A
check that needs to run in CI has to reach CI through `npm test`; that is why
`test/levels.test.js` forks the level verifier rather than living in a workflow
of its own. If a change genuinely needs new YAML, hand the owner the YAML to
paste rather than trying to commit it.

## Commands

```sh
npm test                    # rules, levels, the bank, the judge. ~8 min.
npm run test:e2e            # the game in a real browser
node tools/solve.js 4 13    # profile levels: the full plan table, tier by tier
node tools/verify-levels.js 1 16
node tools/generate-levels.js 1 24 --tries 8 --keep 2 --seed 1
```

End-to-end runs need a browser. In this environment:

```sh
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

The generator is **minutes per level** and deliberately not in CI. Run it in the
background and check on it; do not wrap it in a foreground command with a
timeout.

## Conventions

- **`docs/design-spec.md` is the source of truth for *why*.** Code comments
  reference its section numbers (§4.1, §5, …) so any decision can be traced back
  to the reason for it. Keep doing this; update the doc when a decision changes.
- **`sim.js` has zero browser dependencies.** It must keep running unchanged
  under Node — that is what lets the solver play a level with the real rules
  instead of a model of them.
- **The sim is pure and deterministic.** Randomness comes from the seeded PRNG
  in `mulberry32`; wall-clock time is never read inside `sim.js`.
- **Levels are authored in fractions of the grid**, so a spec builds at any
  resolution. Anything expressed in cells is a bug waiting for a resolution
  change.
- **Every gameplay number belongs in a spec dial**, not in a branch. If you find
  yourself writing `if (level > 12)` inside `buildLevel`, it belongs in
  `difficultyFor` or in the generator's sample ranges.
- Comments explain the decision and what went wrong without it. A comment that
  restates the line below it is noise; a comment that says "this used to be X
  and here is what broke" is the most valuable thing in the file.

## Traps

These are all measured, not theoretical. Each one shipped.

- **Never aim a test at a fixed fraction of the width.** The generator moves the
  basin, the lane and the shelves, and three tests silently ended up asserting
  that the *safe* route fails. Ask the geometry where the material is:
  `sim.geometry` in Node, `window.__subsurface.geometry` in the browser.
- **Verify at the play resolution, 120 × 200.** Levels build at any size but do
  not behave identically across sizes, so a cheaper verification is a
  verification of a different game.
- **Sand slumps into any diagonal channel and seals it.** The lane must cross
  the sand band vertically, and shelves must stay above the band. Every
  unwinnable late level turned out to be a plugged diagonal.
- **Fluid's lateral reach is 10 cells**, so a flat cavern floor forgives almost
  any aim. `floorSlope` — the crown on the cavern floor — is what makes aim
  matter, and without it every plan scores the same and the star tiers are
  decoration.
- **A crowned floor must be built upward**, with the crest rising above the
  outer floor. Dropping the flanks instead pushes them past the bottom of the
  grid, the floor-drawing loop runs zero times, and the drains silently vanish.
- **A membrane seam is how a diagonal survives the sand band.** Grains rest on
  one, fluid goes through it. Nothing else in the game lifts the "lane must
  cross the band vertically" rule — measured, an unlined diagonal delivers 0%
  and a lined one 73%. The material exists and is tested; no level places one
  yet.
- **Capping a drain does not rescue a miss.** A rigid body over a drain mouth
  genuinely stops it taking anything — that primitive works and is pinned in
  `test/bodies.test.js`. But on a crowned floor the flank is downhill of the
  crystal, so capping converts fluid that was *lost* into fluid that is *stuck*
  and the score barely moves. Any "plug the drain" mechanic needs an answer to
  that first, not more terrain.
- **A hazard that removes fluid counts it as `lost`**, never as a new bucket.
  `released = inPlay + collected + lost + heldBySand` is asserted after every
  step of every run, and `lost` already means "removed from play and not
  collected". Adding a bucket would mean touching every conservation test and
  the solver's ceiling calculation, to express something the existing one
  already says.
- **`levels.js` is precached by the service worker**, and `cache.addAll` rejects
  wholesale if any entry 404s. If the bank file goes, take it out of `SHELL`.
- **A browser drag has two ends and both of them move.** Start above the clay
  seal and finish above the cavern floor, taken from
  `window.__subsurface.geometry` — `digDown` does this for you. Four tests once
  started at a fixed 0.3 of the height, which on a level whose seal sits at
  0.265 never reached the reservoir at all; every one of them then reported
  something that sounded like a game bug.
- **A round-robin worker pool can deal every expensive job to one worker.** The
  sampled levels are evenly spaced, so the spacing collides with the core count.
  Deal the expensive jobs first, one per worker.
- **`npm test` is dominated by level verification** — around eight minutes of a
  nine-minute suite on a four-core box, and about five minutes of the CI job's
  ten-minute timeout. Before adding work to it, measure what it costs; the
  timeout itself lives in a file you cannot edit.

## Levels

The game has two sources of levels and they meet at one builder: the curve
(`difficultyFor(n)`) and the bank (`docs/play/levels.js`). **The bank wins where
it has an entry.** Both go through `tools/bank.js#specFor(n)`, so there is one
answer to "what is level 7".

Levels may be **regenerated freely** — the game is in early development and
changing an existing level is fine. What is not fine is changing what a level
*means* without re-verifying it: a banked entry carries the numbers the solver
measured, and those numbers are a claim about terrain that has to still exist.

A level is good when five things hold at once — the first three bound the
bottom of the distribution, the last two bound the top, and the first bank
proved that bounding only the bottom ships levels where a median of five plans
ace and 3★ means "you found the area":

- **ace** — some plan reaches 3★ (97%). There is a line, and finding it pays.
- **forgiving** — some plan lands in 85–92%. A near miss still gets home; a
  level without this is a lock, not a puzzle.
- **hard** — every naive straight drop is under 85%.
- **crisp** — at most 2 plans ace, so the line is special.
- **graded** — at least two plans land between 85 and 97: a ladder, not a
  cliff.

The best find is `mechanicRequired`: the lane alone cannot reach 2★ and the
dam-then-lane aces. The judge can only find these because a failed route is a
fork (try the collapses) rather than a rejection — keep it that way.

Levels 1–3 are the exception: they teach the basic move and are *supposed* to
fall to a straight drop.

When a level is wrong, `node tools/solve.js <n>` prints the whole table. The
distribution says *which way* it is wrong; the pass/fail from the test suite
cannot.

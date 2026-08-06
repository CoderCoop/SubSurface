# SubSurface

A level-based 2D physics puzzle game for mobile. The player is a subterranean
pathfinder: guide a volume of viscous fluid from a starting chamber down to a
crystalline collector by carving pathways through reactive geological layers —
watertight clay, collapsing sand, and shattering fractured rock.

The simulation is a hybrid of a cellular-automata particle grid (fluid, sand, clay)
and a rigid-body engine layered on top for rock debris.

## Documentation

- [Game Design & Technical Specification](docs/design-spec.md) — gameplay mechanics,
  material behaviours, art and audio direction, simulation architecture, level data
  format, and progression.
- **Project website** — `docs/index.html`. Plain static HTML and CSS with no build
  step; open it straight from a checkout, or view it on GitHub Pages once Pages is
  enabled for the repository. Deployed by
  [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on pushes to `main`
  that touch `docs/`.

Every illustration on the website is a mockup of the intended design, labelled as
such throughout. There is no game build to screenshot — the prototype below is a
bare development harness, not the game the mockups depict.

## Simulation prototype

`src/` holds a working prototype of the cellular-automata grid from §4.1 of the
spec: fluid flow and pressure, sand at its angle of repose, absorption and
pressure release, digging, and the collector.

```sh
open src/index.html         # drag to dig; or xdg-open / start
node --test test/sim.test.js
```

- `src/sim.js` — the simulation. DOM-free, so it runs headlessly under Node.
- `src/app.js`, `src/index.html` — canvas rendering, input and HUD.
- `test/sim.test.js` — 19 tests, no dependencies.

**Fluid is strictly conserved.** Every unit released is, at every instant, in
exactly one of four places:

```
released = in play + collected + drained + held by sand
```

Sand absorbs fluid into wet sand, which *holds* that unit rather than destroying
it, and gives it back once enough pressure builds against the band — so a
saturated band is a delay and a reservoir, not a leak. The test suite asserts
that invariant after every step of a full run.

Not implemented: the rigid-body layer for fractured rock, chunk sleeping,
multithreading, the PNG level loader, audio and haptics.

## Status

Pre-production. The design specification is the current source of truth; no engine
code has been written yet.

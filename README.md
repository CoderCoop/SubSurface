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

`src/` holds a working prototype of both simulation systems from §4.1 of the
spec: the cellular grid (fluid flow and pressure, sand at its angle of repose,
absorption and pressure release, digging, the collector) and the rigid-body
layer for fractured rock, coupled to each other.

```sh
npm install                 # fetches Box2D (planck)
open src/index.html         # drag to dig; or xdg-open / start
npm test
```

- `src/sim.js` — the cellular simulation. DOM-free, so it runs under Node.
- `src/bodies.js` — rigid bodies and the interaction layer between the two.
- `src/app.js`, `src/index.html` — canvas rendering, input and HUD.
- `test/` — 32 tests.

Physics is [planck](https://piqnt.com/planck.js/), Erin Catto's Box2D ported to
JS. We do not implement collision response, friction, restitution or solvers —
the library does. What is written here is the part no library provides: the
two-way contract between a particle grid and a rigid-body world, which the spec
states as *grid particles exert buoyancy/pressure forces on the rigid bodies*
and *rigid bodies act as collision masks masking out grid cells*. Both
directions are implemented; everything else is delegated.

**Fluid is strictly conserved.** Every unit released is, at every instant, in
exactly one of four places:

```
released = in play + collected + drained + held by sand
```

Sand absorbs fluid into wet sand, which *holds* that unit rather than destroying
it, and gives it back once enough pressure builds against the band — so a
saturated band is a delay and a reservoir, not a leak. The test suite asserts
that invariant after every step of a full run.

Not implemented: chunk sleeping, multithreading, the PNG level loader, audio and
haptics.

## Status

Pre-production. The design specification is the current source of truth; no engine
code has been written yet.

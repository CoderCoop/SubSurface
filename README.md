# SubSurface

A level-based 2D physics puzzle game for mobile. The player is a subterranean
pathfinder: guide a volume of viscous fluid from a starting chamber down to a
crystalline collector by carving pathways through reactive geological layers —
watertight clay, collapsing sand, and shattering fractured rock.

The simulation is a hybrid of a cellular-automata particle grid (fluid, sand, clay)
and a rigid-body engine layered on top for rock debris.

**→ [Play the early build](https://codercoop.github.io/SubSurface/play/)** —
runs in any browser, installs to a phone home screen, works offline.

**→ [About the project](https://codercoop.github.io/SubSurface/)** — what the
game is, why it exists, and how to use it.

## Documentation

- [Game Design & Technical Specification](docs/design-spec.md) — gameplay mechanics,
  material behaviours, art and audio direction, simulation architecture, level data
  format, and progression.
- **Project website** — live at
  [codercoop.github.io/SubSurface](https://codercoop.github.io/SubSurface/),
  source in `docs/index.html`. Plain static HTML and CSS with no build step, so
  you can also open it straight from a checkout. Deployed by
  [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on pushes to
  `main` that touch `docs/`.

Every illustration on the website is a mockup of the intended design, labelled as
such throughout. They depict the finished game, which the early build below is
not — one level, raw grid, no art pass, no audio.

## Simulation proof of concept

`docs/play/` holds a working proof of concept of both simulation systems from
§4.1 of the spec: the cellular grid (fluid flow and pressure, sand at its angle
of repose, absorption and pressure release, digging, the collector) and the
rigid-body layer for fractured rock, coupled to each other.

It ships as a **progressive web app** — a set of static files served from the
same GitHub Pages site, with a manifest and a service worker, so it installs to
a home screen and runs offline with no store listing, no signing and no review
queue. That is why it lives under `docs/` rather than a `src/` directory: Pages
publishes `docs/`, and the game is part of the site rather than something built
alongside it.

**It is a proof of concept, not a committed engine choice.** Its job is to
answer design questions cheaply — and it has answered the two that mattered:
the hybrid grid/rigid-body architecture works, and absorption reconciles with
volume conservation. Whether the shipping game is built on this or ported to a
game engine is deliberately still open.

If it is ported, the durable artefact is `test/` rather than the implementation.
Those tests are written as behavioural claims about the rules — grains conserve,
saturated sand conducts pressure, a chunk lodged above a narrow passage blocks
it — so they transfer to any implementation and serve as the contract the port
has to satisfy.

```sh
open docs/play/index.html   # drag to dig; no install needed

npm install                 # only for the tests
npm test                    # simulation rules, no browser
npm run test:e2e            # the game in a real browser (needs Chromium)
npm run test:all
```

`npm run test:e2e` drives Chromium against a local server. If Playwright has no
browser yet, `npx playwright install chromium`; to point it at one you already
have, set `CHROMIUM_PATH`.

- `docs/play/sim.js` — the cellular simulation. DOM-free, so it runs under Node.
- `docs/play/bodies.js` — rigid bodies and the interaction layer between the two.
- `docs/play/app.js`, `index.html` — canvas rendering, input and HUD.
- `docs/play/sw.js`, `manifest.webmanifest`, `icons/` — the PWA shell.
- `docs/play/vendor/planck.min.js` — the physics engine, committed so the game
  is self-contained. Refresh with `npm run vendor` after bumping the dependency;
  a test fails if the committed copy and the installed one drift apart.
- `test/` — 35 rule tests, plus 17 end-to-end tests in `test/e2e/` that drive a
  real browser. The rule tests cannot see a dead button or a service worker
  serving a stale script, and both of those have shipped, so the browser tests
  cover the title screen, playing, restarting, the level jump, installability,
  offline, and cache staleness.

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

Pre-production. The design specification is the source of truth for intent; the
proof of concept in `docs/play/` is the source of truth for how the rules actually
behave. No shipping build exists for any platform.

## Licence

[MIT](LICENSE). Use, modify and redistribute it for any purpose, commercial
included; the one condition is that the copyright notice and licence text travel
with copies or substantial portions.

MIT is OSI-approved and about as widely understood as a licence gets, which
means nobody consuming this has to think about it. The one dependency,
[planck](https://piqnt.com/planck.js/), is MIT as well, so the whole tree is
under a single familiar set of terms.

Subsurface is intended to stay open regardless of what happens to the engine
question above, which is worth remembering when that call comes up: it rules
some engines in and others out.

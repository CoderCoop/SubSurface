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

Every illustration on the website is a mockup of the intended design. There is no
build to screenshot yet, and the mockups are labelled as such throughout.

## Status

Pre-production. The design specification is the current source of truth; no engine
code has been written yet.

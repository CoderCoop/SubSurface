'use strict';

/*
 * The level bank: reading it, writing it, and deciding what a level IS.
 *
 * A level used to be a number, and difficultyFor() turned that number into a
 * cross-section. That is a curve, and a curve cannot be told that one of its
 * points is bad — every dial moves together, so tightening the basin on level 6
 * tightens it on level 40 too. The generator searches instead: it samples
 * specs, plays them, and keeps the ones that come out well. What it keeps has
 * to live somewhere, and this is the format.
 *
 * The bank is authoritative where it has an entry and silent everywhere else,
 * so the curve stays as the fallback: an un-banked level still builds, and the
 * game still works if the file never loaded at all.
 *
 * ---------------------------------------------------------------------------
 * Why the bank is a script and not JSON
 *
 * The game is a handful of plain <script> tags with no build step and no
 * runtime network calls — that is what makes it a PWA that works offline from
 * the first load. Fetching JSON would make level building asynchronous, which
 * would reach into reset(), the service worker and the end-to-end tests, all to
 * express the same array of numbers. So the bank is a UMD module like sim.js
 * and bodies.js: `require`-able in Node, a global in the browser, precached by
 * the same list as everything else.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

const S = require('../docs/play/sim.js');

const BANK_PATH = path.join(__dirname, '..', 'docs', 'play', 'levels.js');

/*
 * The dials a banked level records. Everything difficultyFor() produces except
 * `pick`, which is a function rebuilt from the seed, and the two derived flags
 * that just restate the level number.
 *
 * All of them are written, not only the ones the generator varied. A spec that
 * inherits half its values from difficultyFor() is a spec that changes meaning
 * when the curve is edited, and then a banked level is no longer the level that
 * was verified. Freezing every dial is what makes the bank a record rather than
 * a diff.
 */
const DIALS = [
  'level', 'seed',
  'sand', 'fractured',
  'corridor', 'sandDepth', 'fracDepth', 'basin', 'apron',
  'wander', 'sealAt', 'sandAt', 'fracAt', 'cavernAt',
  'ribAt', 'ribReach', 'tone',
  'baffles', 'baffleReach',
  'floorSlope', 'tuck',
  'digBudget', 'seconds', 'gravel', 'vents', 'pillar'
];

// A plain, fully-specified spec — no `pick`, so the builder rebuilds it from
// the seed exactly as it will when the bank is loaded back. Judging a spec with
// a pick the banked copy will not have is judging a different level.
function plainSpec(src) {
  const out = {};
  for (const k of DIALS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function load(file) {
  const p = file || BANK_PATH;
  if (!fs.existsSync(p)) return null;
  // eslint-disable-next-line global-require
  const bank = require(p);
  return bank && bank.levels ? bank : null;
}

/*
 * The spec for a level: the banked one if there is one, otherwise the curve.
 * Every tool goes through here so that "what level 7 is" has exactly one
 * answer, whichever side of the bank it comes from.
 */
function specFor(n, bank) {
  const b = bank === undefined ? load() : bank;
  if (b && b.levels[n]) return b.levels[n];
  return Object.assign(S.difficultyFor(n), { level: n, seed: n });
}

const round = (v, dp) =>
  typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(dp)) : v;

function format(bank) {
  const nums = Object.keys(bank.levels)
    .map(Number)
    .sort((a, b) => a - b);
  const body = nums
    .map((n) => {
      const s = bank.levels[n];
      const lines = DIALS.filter((k) => s[k] !== undefined).map(
        (k) => '      ' + k + ': ' + JSON.stringify(round(s[k], 5))
      );
      const r = s.report;
      if (r) {
        /*
         * What the solver measured when this level was accepted, carried in the
         * file rather than only in the commit that added it. It is the level's
         * provenance: par is derived from it, and a level whose behaviour has
         * drifted from these numbers is a level to regenerate rather than to
         * argue with.
         */
        lines.push(
          '      report: { best: ' + round(r.best, 2) +
            ', plan: ' + JSON.stringify(r.plan) +
            ', naiveBest: ' + round(r.naiveBest, 2) +
            ', bands: ' + JSON.stringify(r.bands) +
            ', maxDug: ' + r.maxDug + ' }'
        );
      }
      const note = r
        ? `    // ${r.best.toFixed(1)}% by ${r.plan}; best naive drop ${r.naiveBest.toFixed(1)}%; ` +
          `plans by tier ${r.bands[3]}★★★/${r.bands[2]}★★/${r.bands[1]}★/${r.bands[0]}✗\n`
        : '';
      return note + '    ' + n + ': {\n' + lines.join(',\n') + '\n    }';
    })
    .join(',\n');

  return `/*
 * Subsurface — the level bank. GENERATED; do not edit by hand.
 *
 * Regenerate with:
 *
 *     node tools/generate-levels.js <first> <last> [--seed N] [--tries N]
 *
 * The last run to touch this file was ${bank.from}–${bank.to} at seed ${bank.seed}. A run
 * replaces only the range it is given and merges over the rest, so a bank is
 * usually the product of several — a level the search could not fill on the
 * first pass gets another go at a wider budget. The git history is the record
 * of which run produced which entry.
 *
 * Each entry is a fully-specified level spec: every dial frozen, so a banked
 * level cannot change meaning when the difficulty curve is edited. The comment
 * above each one is what the solver measured when the level was accepted; see
 * tools/solve.js for what the numbers mean, and tools/generate-levels.js for
 * how they were arrived at.
 *
 * Levels with no entry here fall back to difficultyFor(n), so a missing or
 * stale bank degrades to the procedural game rather than to no game.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubsurfaceLevels = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    version: ${JSON.stringify(bank.version)},
    seed: ${JSON.stringify(bank.seed)},
    // The resolution the levels were verified at. They build at any size but do
    // not behave identically across sizes, so this is a claim about where the
    // measurements hold, not a requirement.
    grid: { w: ${bank.grid.w}, h: ${bank.grid.h} },
    levels: {
${body}
    }
  };
});
`;
}

function save(bank, file) {
  fs.writeFileSync(file || BANK_PATH, format(bank));
}

module.exports = { BANK_PATH, DIALS, plainSpec, load, save, format, specFor };

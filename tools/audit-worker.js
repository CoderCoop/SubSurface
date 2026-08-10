'use strict';

/*
 * One worker in the bank-audit pool: re-measure a banked level with the
 * current solver and report whether it still meets the criterion it is gated
 * on in CI. Used after solver changes to find entries whose acceptance ran
 * against older code — the generator searches for minutes per level, so an
 * audit that says WHICH entries drifted is the difference between re-running
 * three searches and re-running thirty.
 */

const { profile } = require('./solve.js');
const { specFor } = require('./bank.js');

process.on('message', (msg) => {
  for (const n of msg.levels) {
    const v = profile(specFor(n), { full: true });
    const meets = v.error
      ? false
      : n <= 3
        ? v.winnable
        : n <= 10
          ? v.fun && v.crisp && v.graded
          : v.ace && v.crisp && v.hard;
    process.send({
      row: { level: n, meets, reasons: v.error || (v.reasons || []).join('; ') }
    });
  }
  process.send({ done: true });
});

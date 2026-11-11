// The log split into runs at longer stops and silences, and what each run
// holds, on made-up speeds and on a real drift run.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Recording, parseCsv, streamOf } from '../src/replay.js';
import { LEAD_MS, STOP_MS, TAIL_MS, findRuns, runTotals } from '../src/runs.js';
import { findDrifts } from '../src/summary.js';
import { unzip } from '../src/zip.js';

const T0 = Date.UTC(2026, 10, 11, 18, 0, 0);

/** A GPS speed once a second: `parts` are [seconds, m/s] one after another; null seconds of speed is a silence. */
function speeds(parts) {
  const times = [];
  const values = [];
  let t = 0;
  for (const [seconds, speed] of parts) {
    for (let step = 0; step < seconds; step += 1) {
      if (speed !== null) {
        times.push(T0 + (t + step) * 1000);
        values.push(speed);
      }
    }
    t += seconds;
  }
  return [times, values];
}

const at = (seconds) => T0 + seconds * 1000;

test('a wait longer than the stop between two goes makes two runs, each from a moment before it moves to a moment after', () => {
  const runs = findRuns(...speeds([[20, 0], [60, 12], [60, 0.2], [40, 15], [10, 0]]));
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].from, runs[0].to], [at(20) - LEAD_MS, at(79) + TAIL_MS]);
  assert.deepEqual([runs[1].from, runs[1].to], [at(140) - LEAD_MS, at(179) + TAIL_MS]);
  assert.ok(Math.abs(runs[0].distanceM - 59 * 12 - 6) < 10, `${runs[0].distanceM} m`);
  assert.equal(runs[0].movingMs, 59000);
  assert.ok(Math.abs(runs[1].topKmh - 54) < 1e-9);
  // The data ends ten seconds after the second run: it may still go on.
  assert.deepEqual(runs.map(({ open }) => open), [false, true]);
});

test('standing at lights does not cut a drive in two', () => {
  const runs = findRuns(...speeds([[60, 10], [STOP_MS / 1000 - 5, 0], [60, 10]]));
  assert.equal(runs.length, 1);
});

test('a silence of the recording ends a run even without a stop', () => {
  const runs = findRuns(...speeds([[60, 10], [40, null], [60, 10]]));
  assert.equal(runs.length, 2);
  // The second is shown from where the recording starts again, not from before the silence.
  assert.equal(runs[1].from, at(100));
});

test('moving the car a few metres is not a run', () => {
  assert.deepEqual(findRuns(...speeds([[30, 0], [5, 3], [30, 0]])), []);
  assert.deepEqual(findRuns([], []), []);
});

test('the run the data ends in is still going, unless the car has stood long enough since', () => {
  const going = findRuns(...speeds([[10, 0], [60, 10], [5, 0]]));
  assert.equal(going.at(-1).open, true);
  const over = findRuns(...speeds([[10, 0], [60, 10], [STOP_MS / 1000 + 5, 0]]));
  assert.equal(over.at(-1).open, false);
});

test('a real drift run is one run, and its totals are those of the replay', async () => {
  const decoder = new TextDecoder();
  const tables = [];
  const file = new URL('../examples/drifthing_log_20261110_202207.zip', import.meta.url);
  for (const entry of await unzip(new Blob([readFileSync(file)]))) {
    if (/\.csv$/i.test(entry.name)) tables.push({ stream: streamOf(entry.name), ...parseCsv(decoder.decode(entry.bytes)) });
  }
  const { times, values } = new Recording(tables).series('gps.speed_ms');
  const runs = findRuns(times, values);
  assert.equal(runs.length, 1);
  const [totals] = runTotals(tables, runs);
  assert.ok(totals.drifts >= 4, `${totals.drifts} drifts`);
  assert.ok(Math.abs(totals.bestAngle) > 20 && Math.abs(totals.bestAngle) < 40, `best ${totals.bestAngle}`);
  assert.ok(totals.topGrip > 0.4 && totals.topGrip < 1, `grip ${totals.topGrip}`);
  assert.ok(totals.topSlipPct > 100);
  // A run without positions or angle tells what it can.
  const carOnly = [{ stream: 'obd', columns: ['timestamp_ms', 'speed_kmh'], data: Float64Array.from([T0, 30, T0 + 1000, 40]) }];
  assert.deepEqual(runTotals(carOnly, [{ from: T0, to: T0 + 1000 }]), [{ drifts: null, bestAngle: null, longestMs: null, topGrip: null, topSlipPct: null }]);
  assert.equal(findDrifts(new Recording(carOnly)).length, 0);
});

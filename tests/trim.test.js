// Which part of a recording is shown.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recording } from '../src/replay.js';
import { AFTER_DRIFT_MS, BEFORE_DRIFT_MS, trimSpan, trimTables } from '../src/trim.js';

const T0 = 1_794_340_000_000;
const table = (stream, columns, rows) => ({ stream, columns, data: Float64Array.from(rows.flat()) });

/** Two minutes: standing for 30 s, then driving; the phone is picked up at 100 s, still driving; standing from 110 s. */
function drive() {
  const gps = [];
  const drift = [];
  for (let second = 0; second <= 120; second += 1) gps.push([T0 + second * 1000, second >= 30 && second < 110 ? 12 : 0]);
  for (let tenth = 0; tenth <= 1200; tenth += 1) drift.push([T0 + tenth * 100, tenth >= 400 && tenth < 1000 ? 1 : 0]);
  return [table('gps', ['timestamp_ms', 'speed_ms'], gps), table('drift', ['timestamp_ms', 'calibrated'], drift)];
}

test('a drift run is shown from a second before the first action to a moment after the last', () => {
  const recording = new Recording(drive());
  const drifts = [
    { from: T0 + 50000, to: T0 + 53000 },
    { from: T0 + 70000, to: T0 + 72000 },
  ];
  assert.deepEqual(trimSpan(recording, 'drifts', drifts), [T0 + 50000 - BEFORE_DRIFT_MS, T0 + 72000 + AFTER_DRIFT_MS]);
  // Wheels spinning before the first drift are action too; wheels turning slower than the car moves are not.
  const spans = [
    { from: T0 + 40000, to: T0 + 42000, kind: 'spin' },
    { from: T0 + 90000, to: T0 + 91000, kind: 'lock' },
  ];
  assert.deepEqual(trimSpan(recording, 'drifts', drifts, spans), [T0 + 40000 - BEFORE_DRIFT_MS, T0 + 72000 + AFTER_DRIFT_MS]);
  // Never beyond the recording, and without any action all of it.
  assert.deepEqual(trimSpan(recording, 'drifts', [{ from: T0 + 500, to: T0 + 119000 }]), [recording.start, recording.end]);
  assert.deepEqual(trimSpan(recording, 'drifts', []), [recording.start, recording.end]);
});

test('a drive is shown while the car moves, and only until the phone was picked up', () => {
  const recording = new Recording(drive());
  assert.deepEqual(trimSpan(recording, 'moving'), [T0 + 29000, T0 + 100000]);
  assert.deepEqual(trimSpan(recording, null), [recording.start, recording.end]);
  // Without a position there is nothing to go by.
  const engine = new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 800], [T0 + 1000, 900]])]);
  assert.deepEqual(trimSpan(engine, 'moving'), [T0, T0 + 1000]);
});

test('every table is cut to the stretch by the time of its rows, and one that fits is kept as it is', () => {
  const [gps, drift] = drive();
  const [shortGps, shortDrift] = trimTables([gps, drift], T0 + 30000, T0 + 40000);
  assert.equal(shortGps.data.length / 2, 11);
  assert.equal(shortGps.data[0], T0 + 30000);
  assert.equal(shortGps.data.at(-2), T0 + 40000);
  assert.deepEqual(shortGps.columns, gps.columns);
  assert.equal(shortDrift.data.length / 2, 101);
  assert.equal(trimTables([gps], T0 - 1, T0 + 999999)[0], gps);
});

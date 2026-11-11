// Drifts and totals of a recording, on made-up drives: the drift angle ten
// times a second, as the app writes it, with GPS and the car next to it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { powerHp, powerTable } from '../src/engine.js';
import { Recording } from '../src/replay.js';
import { DriftTracker, findDrifts, summarize } from '../src/summary.js';

const T0 = new Date(2026, 10, 10, 20, 30, 0).getTime();
const table = (stream, columns, rows) => ({ stream, columns, data: Float64Array.from(rows.flat().map((value) => value ?? NaN)) });

/**
 * A recording of `seconds` with the drift angle `angle(t)` in degrees (null:
 * not known) and the speed `speed(t)` in m/s. `extra` are more tables.
 */
function recordingOf({ seconds, angle, speed = () => 12, extra = [] }) {
  const drift = [];
  const gps = [];
  for (let step = 0; step <= seconds * 10; step += 1) {
    const t = step / 10;
    drift.push([T0 + t * 1000, angle(t), speed(t)]);
    if (step % 10 === 0) gps.push([T0 + t * 1000, speed(t)]);
  }
  return new Recording([
    table('drift', ['timestamp_ms', 'drift_angle_deg', 'speed_ms'], drift),
    table('gps', ['timestamp_ms', 'speed_ms'], gps),
    ...extra,
  ]);
}

const between = (from, to, value) => (t) => (t >= from && t < to ? value : 0);
const seconds = (drift) => [(drift.from - T0) / 1000, (drift.to - T0) / 1000];

test('a stretch at an angle is one drift, with its side, its largest angle and its speed', () => {
  const [drift, ...more] = findDrifts(recordingOf({ seconds: 30, angle: (t) => (t >= 10 && t < 13 ? 20 + (t === 11 ? 8 : 0) : 1) }));
  assert.deepEqual(more, []);
  assert.deepEqual(seconds(drift), [10, 12.9]);
  assert.equal(drift.peak, 28);
  assert.equal(drift.side, 'R');
  assert.ok(Math.abs(drift.speedKmh - 43.2) < 0.01);
  assert.equal(drift.slipPct, null);
  // To the left the angle is negative.
  const [left] = findDrifts(recordingOf({ seconds: 30, angle: between(10, 13, -25) }));
  assert.equal(left.peak, -25);
  assert.equal(left.side, 'L');
});

test('small angles, twitches and walking pace are not drifts', () => {
  assert.deepEqual(findDrifts(recordingOf({ seconds: 30, angle: () => 8 })), []);
  assert.deepEqual(findDrifts(recordingOf({ seconds: 30, angle: between(10, 10.5, 30) })), []);
  assert.deepEqual(findDrifts(recordingOf({ seconds: 30, angle: between(10, 15, 40), speed: () => 2 })), []);
  // Where the angle is not known there is nothing to find.
  assert.deepEqual(findDrifts(recordingOf({ seconds: 30, angle: () => null })), []);
  assert.deepEqual(findDrifts(new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 900]])])), []);
});

test('a drift lasts until the angle has clearly fallen, and a short dip does not split it', () => {
  // 25 degrees, easing to 7 (still a drift), and a dip to 2 for three tenths of a second in the middle.
  const angle = (t) => {
    if (t < 10 || t >= 16) return 0;
    if (t >= 12 && t < 12.3) return 2;
    return t < 14 ? 25 : 7;
  };
  const drifts = findDrifts(recordingOf({ seconds: 30, angle }));
  assert.equal(drifts.length, 1);
  assert.deepEqual(seconds(drifts[0]), [10, 15.9]);
});

test('a change of side makes two drifts', () => {
  const angle = (t) => (t >= 10 && t < 12 ? -25 : t >= 12 && t < 14.5 ? 22 : 0);
  const drifts = findDrifts(recordingOf({ seconds: 30, angle }));
  assert.deepEqual(drifts.map(({ side }) => side), ['L', 'R']);
  assert.deepEqual(seconds(drifts[0]), [10, 11.9]);
  assert.deepEqual(seconds(drifts[1]), [12, 14.4]);
});

test('a drift ends where the car slows to walking pace or the angle falls silent', () => {
  const slowing = findDrifts(recordingOf({ seconds: 30, angle: between(10, 20, 30), speed: (t) => (t < 14 ? 12 : 1) }));
  assert.deepEqual(seconds(slowing[0]), [10, 13.9]);
  // The phone was handled from 13 s on: no angle after that.
  const silent = findDrifts(recordingOf({ seconds: 30, angle: (t) => (t >= 10 && t < 13 ? 30 : t >= 13 && t < 20 ? null : 0) }));
  assert.deepEqual(seconds(silent[0]), [10, 12.9]);
});

/**
 * Feed the drift stream of `recording` to a DriftTracker row by row, as the drift view does ten times a
 * second, with `tick` where the angle is not known: `[{ drift, told }]` with the time each drift was told.
 */
function live(recording) {
  const told = [];
  let now = null;
  const tracker = new DriftTracker((drift) => told.push({ drift, told: now }));
  const { times } = recording.series('drift.speed_ms');
  for (const time of times) {
    now = time;
    const angle = recording.value('drift.drift_angle_deg', time, 0);
    const speed = recording.value('drift.speed_ms', time, 1500) ?? recording.value('gps.speed_ms', time, 3000);
    if (angle === null) tracker.tick(time);
    else tracker.add(time, angle, speed);
  }
  return told;
}

test('told as they happen, the drifts are the ones the replay finds, each within 0.8 s of its end', () => {
  // A drift to the right with a dip that does not split it, a twitch, a drift to the left, one cut short by
  // slowing down, one at walking pace and one that ends where the angle falls silent.
  const angle = (t) => {
    if (t >= 5 && t < 8) return t >= 6 && t < 6.3 ? 2 : 24;
    if (t >= 10 && t < 10.4) return 30;
    if (t >= 12 && t < 15) return -18;
    if (t >= 17 && t < 22) return 27;
    if (t >= 24 && t < 27) return 35;
    if (t >= 29 && t < 31) return -31;
    if (t >= 31 && t < 34) return null;
    return 1;
  };
  const speed = (t) => (t >= 19 && t < 23 ? 1 : t >= 24 && t < 27 ? 3 : 12);
  const recording = recordingOf({ seconds: 40, angle, speed });
  const found = findDrifts(recording);
  const told = live(recording);
  assert.deepEqual(found.map((drift) => seconds(drift)), [[5, 7.9], [12, 14.9], [17, 18.9], [29, 30.9]]);
  assert.deepEqual(
    told.map(({ drift }) => drift),
    found.map(({ slipPct, gripG, ...drift }) => drift),
  );
  for (const { drift, told: at } of told) {
    assert.ok(at > drift.to && at - drift.to <= 800, `told ${at - drift.to} ms after the end of the drift at ${seconds(drift)[0]} s`);
  }
});

test('a drift followed at once by one to the other side is told without waiting', () => {
  const told = live(recordingOf({ seconds: 30, angle: (t) => (t >= 10 && t < 12 ? -25 : t >= 12 && t < 14.5 ? 22 : 0) }));
  assert.deepEqual(told.map(({ drift }) => drift.side), ['L', 'R']);
  // The first is over the moment the car swings to the other side.
  assert.equal(told[0].told - T0, 12000);
});

test('the wheels running ahead during a drift are put next to it', () => {
  const wheels = table('wheels', ['timestamp_ms', 'slip_pct'], [
    [T0 + 9000, 2],
    [T0 + 10500, 40],
    [T0 + 11400, 95],
    // The car tells its speed late: this reading belongs to the end of the drift.
    [T0 + 13400, 60],
    [T0 + 15000, 150],
  ]);
  const [drift] = findDrifts(recordingOf({ seconds: 30, angle: between(10, 13, 20), extra: [wheels] }));
  assert.equal(drift.slipPct, 95);
});

test('the totals of a drive', () => {
  const extra = [
    table('obd', ['timestamp_ms', 'rpm', 'speed_kmh', 'coolant_c'], [
      [T0, 900, 0, 80],
      [T0 + 10000, 6400, 96, 92],
      [T0 + 20000, 3000, 50, 99],
    ]),
  ];
  const angle = (t) => (t >= 10 && t < 13 ? -31 : t >= 20 && t < 22 ? 18 : 0);
  const recording = recordingOf({ seconds: 60, angle, speed: (t) => (t < 30 ? 10 : 20), extra });
  const drifts = findDrifts(recording);
  const spans = [
    { from: T0 + 10000, to: T0 + 13500, kind: 'spin', peak: 120 },
    { from: T0 + 20000, to: T0 + 21500, kind: 'spin', peak: 45 },
    { from: T0 + 40000, to: T0 + 42000, kind: 'lock', peak: -90 },
  ];
  const totals = summarize(recording, drifts, spans);
  assert.equal(totals.recordedMs, 60000);
  // Thirty seconds at 10 m/s and thirty at 20, with one second of going from one to the other.
  assert.ok(Math.abs(totals.distanceM - 900) < 6, `${totals.distanceM} m`);
  assert.equal(totals.topSpeedKmh, 72);
  assert.equal(totals.topWheelKmh, 96);
  assert.equal(totals.topRpm, 6400);
  assert.equal(totals.topCoolantC, 99);
  assert.equal(totals.drifts, 2);
  assert.equal(totals.driftMs, 2900 + 1900);
  assert.equal(totals.longestMs, 2900);
  assert.equal(totals.bestAngle, -31);
  assert.ok(Math.abs(totals.driftSpeedKmh - 36) < 0.01);
  assert.equal(totals.spinMs, 5000);
  assert.equal(totals.topSlipPct, 120);
});

test('a recording of the car alone has totals without drifts or distance', () => {
  const recording = new Recording([table('obd', ['timestamp_ms', 'rpm', 'speed_kmh'], [[T0, 900, 0], [T0 + 1000, 2500, 40]])]);
  const totals = summarize(recording, findDrifts(recording));
  assert.equal(totals.distanceM, null);
  assert.equal(totals.topSpeedKmh, null);
  assert.equal(totals.topWheelKmh, 40);
  assert.equal(totals.topCoolantC, null);
  assert.equal(totals.drifts, 0);
  assert.equal(totals.bestAngle, null);
  assert.equal(totals.driftSpeedKmh, null);
  assert.equal(totals.topSlipPct, null);
});

test('engine power is estimated from the air flow', () => {
  // The same figure as another scan tool shows for the same idle: 3.43 g/s, about 4.1 hp.
  assert.ok(Math.abs(powerHp(3.43) - 4.12) < 0.01);
  assert.ok(Math.abs(powerHp(132.5) - 159) < 0.1);
  const recording = new Recording([table('obd', ['timestamp_ms', 'rpm', 'maf_gs'], [[T0, 750, 3.43], [T0 + 1000, 760, null], [T0 + 2000, 5000, 100]])]);
  const { columns, data } = powerTable(recording);
  assert.deepEqual(columns, ['timestamp_ms', 'power_hp']);
  assert.equal(data.length, 4);
  assert.deepEqual([data[0], data[2]], [T0, T0 + 2000]);
  assert.ok(Math.abs(data[3] - 120) < 1e-9);
  assert.equal(powerTable(new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 750]])])), null);
});

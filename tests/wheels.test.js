// Wheels against the ground, on made-up drives: GPS speed once a second and
// the car's speed as a K-line car gives it, a whole number of km/h roughly
// every 0.9 s that is half a second old when it arrives.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recording } from '../src/replay.js';
import { WHEEL_LAG_MS, wheelSlip } from '../src/wheels.js';

const T0 = new Date(2026, 10, 10, 20, 0, 0).getTime();

const table = (stream, columns, rows) => ({ stream, columns, data: Float64Array.from(rows.flat()) });

/**
 * A drive of `seconds`. `ground(t)` is the speed over ground in km/h at t
 * seconds. `wheels(t)` is what the wheels do, in km/h of road speed; left out,
 * they grip. The car reads `scale` times the wheels and tells it late.
 */
function drive({ seconds, ground, wheels = ground, scale = 1, carEvery = 0.9, late = WHEEL_LAG_MS / 1000 }) {
  const gps = [];
  for (let t = 0; t <= seconds; t += 1) gps.push([T0 + t * 1000, ground(t) / 3.6]);
  const car = [];
  for (let t = 1; t <= seconds; t += carEvery) car.push([T0 + Math.round(t * 1000), Math.round(scale * wheels(t - late))]);
  return new Recording([table('gps', ['timestamp_ms', 'speed_ms'], gps), table('obd', ['timestamp_ms', 'speed_kmh'], car)]);
}

const rows = ({ columns, data }) => {
  const out = [];
  for (let offset = 0; offset < data.length; offset += columns.length) out.push(Object.fromEntries(columns.map((name, index) => [name, data[offset + index]])));
  return out;
};

const seconds = (span) => [(span.from - T0) / 1000, (span.to - T0) / 1000];

test('on a steady drive the scale between the car and GPS is measured and nothing is marked', () => {
  // A speedometer that reads three percent high.
  const result = wheelSlip(drive({ seconds: 120, ground: (t) => 50 + 10 * Math.sin(t / 15), scale: 1.03 }));
  assert.ok(Math.abs(result.factor - 1.03) < 0.01, `factor ${result.factor}`);
  assert.ok(result.steady > 50);
  assert.deepEqual(result.spans, []);
  assert.deepEqual(result.columns, ['timestamp_ms', 'ground_kmh', 'excess_kmh', 'slip_pct']);
  // With the scale taken out the car is within its own rounding of the ground.
  assert.ok(rows(result).every((row) => Math.abs(row.excess_kmh) < 1.5), 'excess');
});

test('wheels that run away from the car are marked for as long as they do', () => {
  // A steady 40 km/h, and from 60 s to 64 s the wheels turn at 80.
  const result = wheelSlip(drive({ seconds: 120, ground: () => 40, wheels: (t) => (t >= 60 && t < 64 ? 80 : 40), scale: 1.03 }));
  assert.equal(result.spans.length, 1);
  const [span] = result.spans;
  assert.equal(span.kind, 'spin');
  // The band sits where the car's readings are: half a second after the wheels, as the readings arrive.
  const [from, to] = seconds(span);
  assert.ok(from > 59.5 && from < 61.5, `from ${from}`);
  assert.ok(to > 63.5 && to < 65.5, `to ${to}`);
  assert.ok(Math.abs(span.peak - 100) < 5, `peak ${span.peak}`);
  // The scale of the speedometer was not taken for slip, nor the slip for the scale.
  assert.ok(Math.abs(result.factor - 1.03) < 0.01);
});

test('hard acceleration and braking with grip are not marked, although the car tells its speed late', () => {
  // Up to 90 km/h at 0.4 g and down again at 0.8 g, three times over, then up to a steady 60.
  const ground = (t) => {
    const phase = t % 30;
    if (t >= 90) return Math.min((t - 90) * 14.1, 60);
    if (phase < 6.4) return phase * 14.1;
    if (phase < 9.6) return 90 - (phase - 6.4) * 28.2;
    return 0;
  };
  const result = wheelSlip(drive({ seconds: 140, ground }));
  assert.deepEqual(result.spans, []);
  // The largest difference is at the instant the car goes from full throttle to full brake, where GPS
  // once a second cuts the corner. Everywhere else the two agree within the rounding of the car.
  const excess = rows(result).map((row) => Math.abs(row.excess_kmh)).filter(Number.isFinite).sort((a, b) => a - b);
  assert.ok(excess.at(-1) < 10, `worst excess ${excess.at(-1).toFixed(1)} km/h`);
  assert.ok(excess[Math.floor(excess.length * 0.9)] < 2, `nine in ten within ${excess[Math.floor(excess.length * 0.9)].toFixed(1)} km/h`);
});

test('wheels that stand while the car moves are marked as slower', () => {
  // The handbrake at 60 km/h for three seconds.
  const result = wheelSlip(drive({ seconds: 100, ground: () => 60, wheels: (t) => (t >= 50 && t < 53 ? 0 : 60) }));
  assert.equal(result.spans.length, 1);
  assert.equal(result.spans[0].kind, 'lock');
  assert.ok(result.spans[0].peak < -90);
});

test('pulling away, a reading that starts late and low is not taken for locked wheels', () => {
  // The car reads nothing until 8 km/h and then half the truth up to 18: seen on the real car.
  const ground = (t) => Math.min(t * 3, 50);
  const wheels = (t) => (ground(t) < 8 ? 0 : ground(t) < 18 ? ground(t) / 2 : ground(t));
  assert.deepEqual(wheelSlip(drive({ seconds: 80, ground, wheels })).spans, []);
});

test('one reading a little off is not a span, one far off is', () => {
  const blip = (size) => (t) => (t >= 30 && t < 30.9 ? 50 * size : 50);
  assert.deepEqual(wheelSlip(drive({ seconds: 60, ground: () => 50, wheels: blip(1.22) })).spans, []);
  const strong = wheelSlip(drive({ seconds: 60, ground: () => 50, wheels: blip(1.6) })).spans;
  assert.equal(strong.length, 1);
  assert.ok(strong[0].peak > 50);
});

test('spin and lock next to each other are two spans', () => {
  const wheels = (t) => (t >= 40 && t < 44 ? 100 : t >= 44 && t < 47 ? 5 : 60);
  const spans = wheelSlip(drive({ seconds: 90, ground: () => 60, wheels })).spans;
  assert.deepEqual(spans.map(({ kind }) => kind), ['spin', 'lock']);
  assert.ok(spans[0].to <= spans[1].from + 1000);
});

test('without steady driving the scale stays at one and slides are still found', () => {
  // Ten seconds, all of it a slide: nothing to measure the scale on.
  const result = wheelSlip(drive({ seconds: 10, ground: (t) => 30 + t * 2, wheels: (t) => (t > 3 ? 90 : 30 + t * 2) }));
  assert.equal(result.factor, 1);
  assert.equal(result.steady, 0);
  assert.equal(result.spans.length, 1);
});

test('a scale far from one is not a speedometer error: nothing is corrected and nothing marked', () => {
  // Miles an hour against kilometres an hour.
  const result = wheelSlip(drive({ seconds: 120, ground: () => 80, scale: 0.62 }));
  assert.equal(result.factor, 1);
  assert.equal(result.steady, 0);
  assert.deepEqual(result.spans, []);
});

test('a recording without the car or without GPS has nothing to compare', () => {
  const gps = table('gps', ['timestamp_ms', 'speed_ms'], [[T0, 10], [T0 + 1000, 10]]);
  const car = table('obd', ['timestamp_ms', 'speed_kmh'], [[T0, 36], [T0 + 900, 36]]);
  assert.equal(wheelSlip(new Recording([gps])), null);
  assert.equal(wheelSlip(new Recording([car])), null);
  assert.equal(wheelSlip(new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 800]]), gps])), null);
  // Where GPS has nothing to say for a reading, the reading is kept and its comparison left empty.
  const apart = wheelSlip(new Recording([car, table('gps', ['timestamp_ms', 'speed_ms'], [[T0 + 60000, 10]])]));
  assert.ok(rows(apart).every((row) => Number.isNaN(row.slip_pct)));
  assert.deepEqual(apart.spans, []);
});

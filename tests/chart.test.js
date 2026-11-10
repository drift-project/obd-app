// The arithmetic of a chart: where the points of a line go and how a value
// is written. The drawing itself needs a browser and is checked there.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chartRanges, formatValue, markBoxes, plotDots, plotPath, unitOf } from '../src/chart.js';

test('a value is written with the decimals its range calls for', () => {
  assert.equal(formatValue(3456.4, 700, 6500), '3456');
  assert.equal(formatValue(78.46, 60, 95), '78.5');
  assert.equal(formatValue(13.874, 11.9, 14.4), '13.87');
  assert.equal(formatValue(0.12345, -0.4, 0.4), '0.123');
  assert.equal(formatValue(52.2296756, 52.2291, 52.2299), '52.22968');
  assert.equal(formatValue(-12.3, -40, 35), '-12.3');
});

test('a signal that never changes is written plainly, and a missing value as dashes', () => {
  assert.equal(formatValue(14, 14, 14), '14');
  assert.equal(formatValue(0.5, 0.5, 0.5), '0.5');
  assert.equal(formatValue(null, 0, 100), '--');
  assert.equal(formatValue(NaN, 0, 100), '--');
});

test('a line runs from the left edge to the right and from the lowest value at the bottom to the highest at the top', () => {
  const path = plotPath(
    [
      [1000, 0],
      [1500, 50],
      [2000, 100],
    ],
    1000,
    2000,
    0,
    100,
  );
  // The plot is 1000 wide and 100 high, with a margin of 6 above and below.
  assert.equal(path, 'M0.0,94.0L500.0,50.0L1000.0,6.0');
});

test('points beyond the window are placed beyond its edges, so the line enters and leaves it', () => {
  const path = plotPath(
    [
      [500, 10],
      [1500, 10],
      [2500, 10],
    ],
    1000,
    2000,
    0,
    20,
  );
  assert.equal(path, 'M-500.0,50.0L500.0,50.0L1500.0,50.0');
});

test('the line is interrupted where the recording paused', () => {
  const points = [
    [1000, 0],
    [1100, 10],
    [5000, 20],
    [5100, 30],
  ];
  const path = plotPath(points, 1000, 6000, 0, 30, [5000]);
  assert.equal(path.match(/M/g).length, 2);
  assert.ok(path.includes('L20.0,64.7M800.0,35.3L'), path);
  // Without the pause it is one line.
  assert.equal(plotPath(points, 1000, 6000, 0, 30).match(/M/g).length, 1);
  // Pauses that lie before the first point or between no points change nothing.
  assert.equal(plotPath(points, 1000, 6000, 0, 30, [200, 300, 5000]).match(/M/g).length, 2);
});

test('a value on its own between two pauses is drawn as a dot', () => {
  const path = plotPath(
    [
      [1000, 5],
      [3000, 5],
      [5000, 5],
      [5500, 5],
    ],
    1000,
    6000,
    0,
    10,
    [3000, 5000],
  );
  // A piece with a single point gets a line of no length, which a round line end shows as a dot.
  assert.equal(path, 'M0.0,50.0h0M400.0,50.0h0M800.0,50.0L900.0,50.0');
  assert.equal(plotPath([[1000, 5]], 1000, 6000, 0, 10), 'M0.0,50.0h0');
});

test('a signal that never changes runs through the middle, and no points give no line', () => {
  assert.equal(plotPath([[0, 7], [10, 7]], 0, 10, 7, 7), 'M0.0,50.0L1000.0,50.0');
  assert.equal(plotPath([], 0, 10, 0, 1), '');
});

test('marked stretches of time become boxes cut to the window', () => {
  const marks = [
    { from: 500, to: 900, kind: 'spin' }, // before the window
    { from: 900, to: 1100, kind: 'spin' }, // reaches into it
    { from: 1400, to: 1600, kind: 'lock' }, // inside
    { from: 1900, to: 2500, kind: 'spin' }, // runs out of it
    { from: 2100, to: 2200, kind: 'spin' }, // after it
  ];
  assert.deepEqual(markBoxes(marks, 1000, 2000), [
    { x: 0, width: 100, kind: 'spin' },
    { x: 400, width: 200, kind: 'lock' },
    { x: 900, width: 100, kind: 'spin' },
  ]);
  assert.deepEqual(markBoxes([], 1000, 2000), []);
});

test('a dot is drawn at every point, at the places the line goes through', () => {
  const points = [
    [1000, 0],
    [1500, 50],
    [2000, 100],
  ];
  assert.equal(plotDots(points, 1000, 2000, 0, 100), 'M0.0,94.0h0M500.0,50.0h0M1000.0,6.0h0');
  assert.equal(plotDots([], 0, 1, 0, 1), '');
});

test('signals of one unit share a scale on a chart, signals of different units keep their own', () => {
  assert.equal(unitOf('speed_kmh'), 'kmh');
  assert.equal(unitOf('ground_kmh'), 'kmh');
  assert.equal(unitOf('drift_angle_deg'), 'deg');
  assert.equal(unitOf('rpm'), 'rpm');
  // The speed of the wheels and the speed over ground, both in km/h: one scale from the lowest to the highest.
  assert.deepEqual(chartRanges([
    { column: 'speed_kmh', min: 0, max: 97 },
    { column: 'ground_kmh', min: 2, max: 72 },
  ]), [
    { min: 0, max: 97, shared: true },
    { min: 0, max: 97, shared: true },
  ]);
  // Revs and speed: each its own.
  assert.deepEqual(chartRanges([
    { column: 'rpm', min: 500, max: 6500 },
    { column: 'speed_kmh', min: 0, max: 97 },
  ]), [
    { min: 500, max: 6500, shared: false },
    { min: 0, max: 97, shared: false },
  ]);
  // One signal alone is never called shared.
  assert.deepEqual(chartRanges([{ column: 'speed_kmh', min: 0, max: 97 }]), [{ min: 0, max: 97, shared: false }]);
});

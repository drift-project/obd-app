// The g-g diagram: where a push lands on the circle, how it is put in words,
// and which rows of a recording it is drawn from.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { G, dotPaths, gripPoints, gripText, hasGrip, mostGrip, toPlot } from '../src/grip-chart.js';
import { angleShade } from '../src/map.js';
import { Recording } from '../src/replay.js';

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

/** A drift stream of five rows a tenth of a second apart, the third without acceleration. */
function recording() {
  const columns = ['timestamp_ms', 'drift_angle_deg', 'ahead_ms2', 'right_ms2'];
  const rows = [
    [T0, 0, 0, 0],
    [T0 + 100, 12, 2, -3],
    [T0 + 200, 20, NaN, NaN],
    [T0 + 300, 30, -4.9, 4.9],
    [T0 + 400, NaN, 1, 1],
  ];
  return new Recording([{ stream: 'drift', columns, data: Float64Array.from(rows.flat()) }]);
}

test('the middle of the circle is no push, up is speeding up and right is right', () => {
  assert.deepEqual(toPlot(0, 0), [120, 120]);
  assert.deepEqual(toPlot(G, 0), [120, 20]);
  assert.deepEqual(toPlot(-G / 2, 0), [120, 170]);
  assert.deepEqual(toPlot(0, G / 2), [170, 120]);
  assert.deepEqual(toPlot(0, -G), [20, 120]);
});

test('a push off the scale is drawn on the edge, in its own direction', () => {
  const [x, y] = toPlot(3 * G, 4 * G);
  assert.ok(Math.abs(Math.hypot(x - 120, y - 120) - 115) < 1e-9);
  assert.ok(Math.abs((x - 120) / (120 - y) - 4 / 3) < 1e-9);
});

test('the push of a moment is put in words, with its parts', () => {
  assert.equal(gripText(0.28 * G, 0.31 * G), '0.42 g: 0.31 g right, 0.28 g speeding up');
  assert.equal(gripText(-0.5 * G, -0.1 * G), '0.51 g: 0.10 g left, 0.50 g braking');
  assert.equal(gripText(null, null), 'No acceleration at this moment');
});

test('the rows of a stretch are taken with their drift angle, and rows without acceleration are left out', () => {
  const points = gripPoints(recording(), T0 + 50, T0 + 400);
  assert.deepEqual(
    points.map(({ time, ahead, right, angle }) => [time - T0, ahead, right, angle]),
    [
      [100, 2, -3, 12],
      [300, -4.9, 4.9, 30],
      [400, 1, 1, null],
    ],
  );
  assert.deepEqual(gripPoints(recording(), T0 + 410, T0 + 900), []);
  assert.equal(hasGrip(recording()), true);
  assert.equal(hasGrip(new Recording([{ stream: 'drift', columns: ['timestamp_ms', 'drift_angle_deg'], data: Float64Array.from([T0, 1]) }])), false);
});

test('the hardest push of a stretch is told in g', () => {
  const points = gripPoints(recording(), T0, T0 + 400);
  assert.ok(Math.abs(mostGrip(points) - Math.hypot(4.9, 4.9) / G) < 1e-9);
  assert.equal(mostGrip([]), null);
});

test('dots are grouped by the shade of their drift angle, as the line on the map', () => {
  const points = gripPoints(recording(), T0, T0 + 400);
  const paths = dotPaths(points);
  assert.equal(paths.get(angleShade(30)), `M${toPlot(-4.9, 4.9).map((value) => value.toFixed(1)).join(',')}h0`);
  // No angle and no drift share the first shade.
  assert.equal((paths.get(0).match(/M/g) ?? []).length, 2);
  assert.equal([...paths.values()].join('').match(/M/g).length, points.length);
});

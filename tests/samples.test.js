import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SampleLog } from '../src/samples.js';

const STREAMS = [
  { name: 'gyroscope', columns: ['x_rads', 'y_rads', 'z_rads'], digits: 5 },
  { name: 'gps', columns: ['fix_ms', 'latitude_deg', 'altitude_m'], digits: [0, 7, 1] },
];

const T0 = 1_793_916_437_000;

test('a stream becomes CSV with its own columns and precision', () => {
  const log = new SampleLog(STREAMS);
  log.add('gyroscope', [T0 + 0.12345, 0.0123456, -1.5, 0]);
  log.add('gyroscope', [T0 + 16.7, 1e-7, 2, -0.000004]);
  assert.equal(
    log.csv('gyroscope'),
    ['timestamp_ms,x_rads,y_rads,z_rads', '1793916437000.1,0.01235,-1.5,0', '1793916437016.7,0,2,0', ''].join('\r\n'),
  );
});

test('a missing value is an empty cell, a zero is a zero', () => {
  const log = new SampleLog(STREAMS);
  log.add('gps', [T0, T0 - 250, 52.2296756, null]);
  log.add('gps', [T0 + 1000, T0 + 750, 0, undefined]);
  assert.deepEqual(log.csv('gps').split('\r\n').slice(1, 3), ['1793916437000.0,1793916436750,52.2296756,', '1793916438000.0,1793916437750,0,']);
});

test('a stream without samples has no CSV', () => {
  const log = new SampleLog(STREAMS);
  log.add('gps', [T0, T0, 1, 2]);
  assert.equal(log.csv('gyroscope'), null);
  assert.equal(log.count('gyroscope'), 0);
  assert.equal(log.count('gps'), 1);
  assert.equal(log.total, 1);
});

test('samples are handed over for storage once, in blocks of plain numbers', () => {
  const log = new SampleLog(STREAMS);
  assert.equal(log.take(), null);
  log.add('gyroscope', [T0, 1, 2, 3]);
  log.add('gyroscope', [T0 + 17, 4, 5, 6]);
  const batch = log.take();
  assert.deepEqual(Object.keys(batch), ['gyroscope']);
  assert.ok(batch.gyroscope instanceof Float64Array);
  assert.deepEqual([...batch.gyroscope], [T0, 1, 2, 3, T0 + 17, 4, 5, 6]);
  assert.equal(log.take(), null);
  // Taking a batch does not drop it from the log.
  assert.equal(log.count('gyroscope'), 2);
  assert.equal(log.csv('gyroscope').split('\r\n').length, 4);
});

test('stored batches restore the log, in order, with newer samples after them', () => {
  const first = new SampleLog(STREAMS);
  first.add('gyroscope', [T0, 1, 2, 3]);
  const one = first.take();
  first.add('gyroscope', [T0 + 17, 4, 5, 6]);
  first.add('gps', [T0 + 20, T0, 52, 110]);
  const two = first.take();

  const restored = new SampleLog(STREAMS);
  restored.load([one, two]);
  restored.add('gyroscope', [T0 + 34, 7, 8, 9]);
  assert.equal(restored.count('gyroscope'), 3);
  assert.equal(restored.total, 4);
  assert.deepEqual(
    restored.csv('gyroscope').split('\r\n').slice(1, 4).map((line) => line.split(',')[1]),
    ['1', '4', '7'],
  );
  assert.equal(restored.csv('gps'), first.csv('gps'));
});

test('stored data that does not fit is skipped instead of breaking the log', () => {
  const log = new SampleLog(STREAMS);
  log.load([{ compass: new Float64Array(4) }, { gyroscope: new Float64Array(7) }, { gyroscope: [1, 2, 3, 4] }, null]);
  assert.equal(log.total, 0);
});

test('span covers every stream, stored or not yet', () => {
  const log = new SampleLog(STREAMS);
  assert.equal(log.span(), null);
  log.add('gps', [T0 + 500, T0, 1, 2]);
  log.take();
  log.add('gyroscope', [T0 + 100, 1, 2, 3]);
  log.add('gyroscope', [T0 + 900, 1, 2, 3]);
  assert.deepEqual(log.span(), [T0 + 100, T0 + 900]);
});

test('clear empties every stream', () => {
  const log = new SampleLog(STREAMS);
  log.add('gyroscope', [T0, 1, 2, 3]);
  log.take();
  log.add('gps', [T0, T0, 1, 2]);
  log.clear();
  assert.equal(log.total, 0);
  assert.equal(log.take(), null);
  assert.equal(log.csv('gyroscope'), null);
});

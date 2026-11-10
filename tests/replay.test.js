import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recording, parseCsv, skipGap, streamOf } from '../src/replay.js';

const T0 = 1_794_327_542_000;

/** A table as the app keeps it: column names and the rows flattened into one array of numbers. */
function table(stream, columns, rows) {
  return { stream, columns, data: Float64Array.from(rows.flat().map((value) => value ?? NaN)) };
}

test('a CSV file becomes columns and numbers, with empty cells as missing values', () => {
  const { columns, data } = parseCsv('timestamp_ms,rpm,speed_kmh\r\n1794327542018,746,0\r\n1794327542883,,12.5\r\n');
  assert.deepEqual(columns, ['timestamp_ms', 'rpm', 'speed_kmh']);
  assert.equal(data.length, 6);
  assert.deepEqual([...data.slice(0, 3)], [1794327542018, 746, 0]);
  assert.ok(Number.isNaN(data[4]));
  assert.equal(data[5], 12.5);
});

test('CSV parsing copes with other line ends, blank lines and stray text', () => {
  const { columns, data } = parseCsv('timestamp_ms, x ,y\n\n1794327542018, 1.5 ,abc\n  \n1794327542118,2\n');
  assert.deepEqual(columns, ['timestamp_ms', 'x', 'y']);
  assert.equal(data.length, 6);
  assert.equal(data[1], 1.5);
  assert.ok(Number.isNaN(data[2]), 'text is a missing value');
  assert.ok(Number.isNaN(data[5]), 'a short row is filled with missing values');
  assert.deepEqual(parseCsv('').columns, ['']);
  assert.equal(parseCsv('a,b').data.length, 0);
});

test('the name of a log file tells which stream it holds', () => {
  assert.equal(streamOf('obd_data_20261110_173958.csv'), 'obd');
  assert.equal(streamOf('obd_demo_20261110_173958.csv'), 'obd');
  assert.equal(streamOf('phone_gyroscope_20261110_174900.csv'), 'gyroscope');
  assert.equal(streamOf('phone_linear_acceleration_20261110_174900.csv'), 'linear_acceleration');
  assert.equal(streamOf('folder/phone_drift_20261110_174900.csv'), 'drift');
  assert.equal(streamOf('phone_gps.csv'), 'gps');
  assert.equal(streamOf('my notes.csv'), 'my notes');
  assert.equal(streamOf('readings_20261110_173958.csv'), 'readings');
});

test('a log file is still recognised after a download or a chat app changed its name', () => {
  assert.equal(streamOf('816d153b-obd_data_20261110_173958.csv'), 'obd');
  assert.equal(streamOf('obd_data_20261110_173958 (1).csv'), 'obd');
  assert.equal(streamOf('phone_gps_20261110_174900 (2).csv'), 'gps');
  assert.equal(streamOf('3f9a-phone_relative_orientation_20261110_174900.csv'), 'relative_orientation');
  assert.equal(streamOf('PHONE_GYROSCOPE_20261110_174900-1.CSV'), 'gyroscope');
  // Not the app's files, although the words are in the name.
  assert.equal(streamOf('microphone_test.csv'), 'microphone_test');
});

test('every column becomes a signal, and a sparse table loses nothing', () => {
  // The car's table on a K-line: one value in each row.
  const recording = new Recording([
    table('obd', ['timestamp_ms', 'rpm', 'speed_kmh', 'pedal_pct'], [
      [T0, 800, null, null],
      [T0 + 250, null, 12, null],
      [T0 + 500, 900, null, null],
      [T0 + 750, null, 14, null],
    ]),
  ]);
  assert.deepEqual(
    recording.signals.map(({ id, count, min, max }) => ({ id, count, min, max })),
    [
      { id: 'obd.rpm', count: 2, min: 800, max: 900 },
      { id: 'obd.speed_kmh', count: 2, min: 12, max: 14 },
    ],
  );
  assert.equal(recording.has('obd.pedal_pct'), false);
  assert.equal(recording.start, T0);
  assert.equal(recording.end, T0 + 750);
});

test('a value is the newest one at that time and can go stale', () => {
  const recording = new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 800], [T0 + 1000, 900], [T0 + 2000, 1000]])]);
  assert.equal(recording.value('obd.rpm', T0 - 1), null);
  assert.equal(recording.value('obd.rpm', T0), 800);
  assert.equal(recording.value('obd.rpm', T0 + 999), 800);
  assert.equal(recording.value('obd.rpm', T0 + 1000), 900);
  assert.equal(recording.value('obd.rpm', T0 + 60000), 1000);
  assert.equal(recording.value('obd.rpm', T0 + 60000, 5000), null);
  assert.equal(recording.value('obd.none', T0), null);
});

test('between two values the interpolated value lies on the line from one to the next', () => {
  const recording = new Recording([
    table('gps', ['timestamp_ms', 'latitude_deg'], [[T0, 52.0], [T0 + 1000, 52.001], [T0 + 2000, 52.003], [T0 + 60000, 53]]),
  ]);
  const at = (time, hold) => recording.interpolate('gps.latitude_deg', time, hold);
  assert.equal(at(T0 - 1), null);
  assert.equal(at(T0), 52.0);
  assert.ok(Math.abs(at(T0 + 250) - 52.00025) < 1e-9);
  assert.ok(Math.abs(at(T0 + 1500) - 52.002) < 1e-9);
  // Across a pause the two sides are not joined: the last value is held, then it goes stale.
  assert.equal(at(T0 + 2500, 3000), 52.003);
  assert.equal(at(T0 + 30000, 3000), null);
  assert.equal(at(T0 + 60000, 3000), 53);
  assert.equal(at(T0 + 90000, 3000), null);
  assert.equal(at(T0 + 90000), 53);
  assert.equal(recording.interpolate('gps.none', T0), null);
});

test('the whole of a signal can be taken out, for the line on the map', () => {
  const recording = new Recording([
    table('drift', ['timestamp_ms', 'latitude_deg', 'longitude_deg'], [
      [T0, null, null],
      [T0 + 100, 52.1, 21.1],
      [T0 + 200, 52.2, 21.2],
    ]),
  ]);
  const latitude = recording.series('drift.latitude_deg');
  assert.deepEqual([...latitude.times], [T0 + 100, T0 + 200]);
  assert.deepEqual([...latitude.values], [52.1, 52.2]);
  assert.deepEqual([...recording.series('drift.longitude_deg').values], [21.1, 21.2]);
  assert.equal(recording.series('drift.none').values.length, 0);
});

test('full columns of a table share its times, columns with gaps keep their own', () => {
  // The phone's tables are long and have no gaps: a copy of the times for every column would double the memory.
  const recording = new Recording([
    table('gyroscope', ['timestamp_ms', 'x_rads', 'y_rads', 'z_rads'], [
      [T0, 1, 2, null],
      [T0 + 16, 3, 4, 5],
      [T0 + 32, 6, 7, 8],
    ]),
  ]);
  const x = recording.series('gyroscope.x_rads');
  const y = recording.series('gyroscope.y_rads');
  const z = recording.series('gyroscope.z_rads');
  assert.equal(x.times, y.times);
  assert.deepEqual([...x.values], [1, 3, 6]);
  assert.deepEqual([...y.values], [2, 4, 7]);
  assert.deepEqual([...z.times], [T0 + 16, T0 + 32]);
  assert.deepEqual([...z.values], [5, 8]);
  assert.equal(recording.value('gyroscope.y_rads', T0 + 20), 4);
});

test('rows that are out of order or have no time are put right', () => {
  const recording = new Recording([
    table('obd', ['timestamp_ms', 'rpm', 'speed_kmh'], [
      [T0 + 2000, 3, 30],
      [null, 9, 90],
      [T0, 1, 10],
      [T0 + 1000, 2, null],
    ]),
  ]);
  assert.deepEqual([...recording.series('obd.rpm').values], [1, 2, 3]);
  assert.deepEqual([...recording.series('obd.speed_kmh').times], [T0, T0 + 2000]);
  assert.equal(recording.start, T0);
  assert.equal(recording.end, T0 + 2000);
  assert.deepEqual(recording.stretches(), [[T0, T0 + 2000]]);
});

test('tables from several files share one time axis', () => {
  const recording = new Recording([
    table('obd', ['timestamp_ms', 'rpm'], [[T0 + 500, 800]]),
    table('gyroscope', ['timestamp_ms', 'x_rads', 'z_rads'], [[T0, 0.1, 0.5], [T0 + 16, 0.1, 0.6]]),
    table('gps', ['timestamp_ms', 'speed_ms'], [[T0 + 3000, 12]]),
  ]);
  assert.deepEqual(recording.signals.map(({ id }) => id), ['obd.rpm', 'gyroscope.x_rads', 'gyroscope.z_rads', 'gps.speed_ms']);
  assert.equal(recording.start, T0);
  assert.equal(recording.end, T0 + 3000);
});

test('two files of the same stream are joined in order of time', () => {
  const recording = new Recording([
    table('obd', ['timestamp_ms', 'rpm'], [[T0 + 2000, 3], [T0 + 3000, 4]]),
    table('obd', ['timestamp_ms', 'rpm'], [[T0, 1], [T0 + 1000, 2]]),
  ]);
  assert.equal(recording.signals[0].count, 4);
  assert.equal(recording.value('obd.rpm', T0 + 1500), 2);
  assert.equal(recording.value('obd.rpm', T0 + 2500), 3);
});

test('a table without real times is left out and named', () => {
  const recording = new Recording([
    table('notes', ['row', 'value'], [[1, 5], [2, 6]]),
    table('obd', ['timestamp_ms', 'rpm'], [[T0, 800]]),
    table('empty', ['timestamp_ms'], [[T0]]),
  ]);
  assert.deepEqual(recording.skipped, ['notes', 'empty']);
  assert.deepEqual(recording.signals.map(({ id }) => id), ['obd.rpm']);
  assert.equal(new Recording([]).empty, true);
});

test('points for drawing reach just beyond the window', () => {
  const rows = Array.from({ length: 10 }, (_, index) => [T0 + index * 1000, index]);
  const recording = new Recording([table('obd', ['timestamp_ms', 'rpm'], rows)]);
  const points = recording.points('obd.rpm', T0 + 2500, T0 + 5500);
  // From the point before the window to the one after it.
  assert.deepEqual(points.map(([, value]) => value), [2, 3, 4, 5, 6]);
  assert.deepEqual(recording.points('obd.rpm', T0 - 5000, T0 - 4000).map(([, value]) => value), [0]);
  assert.deepEqual(recording.points('obd.none', T0, T0 + 1000), []);
});

test('thinning a long signal keeps every peak and dip', () => {
  // A minute at 60 Hz: a slow wave with one sharp spike up and one down.
  const rows = [];
  for (let index = 0; index < 3600; index += 1) rows.push([T0 + index * 16.667, Math.sin(index / 300)]);
  rows[1234][1] = 9;
  rows[2345][1] = -7;
  const recording = new Recording([table('gyroscope', ['timestamp_ms', 'z_rads'], rows)]);
  const points = recording.points('gyroscope.z_rads', T0, T0 + 60000, 200);
  assert.ok(points.length <= 200, `${points.length} points`);
  const values = points.map(([, value]) => value);
  assert.equal(Math.max(...values), 9);
  assert.equal(Math.min(...values), -7);
  // In order of time, so a line can be drawn through them.
  assert.ok(points.every(([time], index) => index === 0 || time >= points[index - 1][0]));
});

test('pauses in a recording split it into stretches', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => [T0 + index * 1000, index]),
    // The page was in the background for a minute.
    ...Array.from({ length: 5 }, (_, index) => [T0 + 64000 + index * 1000, index]),
  ];
  const recording = new Recording([
    table('obd', ['timestamp_ms', 'rpm'], rows),
    // The phone sensors ran half a second longer at the end of the first stretch.
    table('gyroscope', ['timestamp_ms', 'z_rads'], [[T0 + 4200, 1], [T0 + 4500, 1]]),
  ]);
  assert.deepEqual(recording.stretches(), [
    [T0, T0 + 4500],
    [T0 + 64000, T0 + 68000],
  ]);
  // With a tolerance longer than the pause it is one stretch.
  assert.deepEqual(recording.stretches(120000), [[T0, T0 + 68000]]);
});

test('a replay jumps over the pauses', () => {
  const stretches = [
    [T0, T0 + 4500],
    [T0 + 64000, T0 + 68000],
  ];
  assert.equal(skipGap(stretches, T0 + 1000), T0 + 1000);
  assert.equal(skipGap(stretches, T0 - 5000), T0);
  assert.equal(skipGap(stretches, T0 + 10000), T0 + 64000);
  assert.equal(skipGap(stretches, T0 + 68000), T0 + 68000);
  assert.equal(skipGap(stretches, T0 + 70000), null);
});

test('the log of the first drive loads as it was written', () => {
  // The first lines of the file recorded in the car on 2026-11-10, with its thirteen columns.
  const text = [
    'timestamp_ms,rpm,speed_kmh,throttle_pct,pedal_pct,engine_load_pct,coolant_c,intake_air_c,maf_gs,map_kpa,oil_c,ambient_c,catalyst_c',
    '1794327542018,746,0,0,,11.8,,,,,,,',
    '1794327542883,756,0,0,,,,,,,,,',
    '1794327543771,754,0,0,,,77,,,,,,',
    '',
  ].join('\r\n');
  const { columns, data } = parseCsv(text);
  const recording = new Recording([{ stream: streamOf('obd_data_20261110_173958.csv'), columns, data }]);
  assert.deepEqual(recording.signals.map(({ id }) => id), ['obd.rpm', 'obd.speed_kmh', 'obd.throttle_pct', 'obd.engine_load_pct', 'obd.coolant_c']);
  assert.equal(recording.value('obd.coolant_c', 1794327544000), 77);
  assert.equal(recording.value('obd.rpm', 1794327543000), 756);
});

test('the values of a signal in a stretch of time are counted, both ends included', () => {
  const rows = Array.from({ length: 10 }, (_, index) => [T0 + index * 1000, index]);
  const recording = new Recording([table('obd', ['timestamp_ms', 'rpm'], rows)]);
  assert.equal(recording.count('obd.rpm', T0, T0 + 9000), 10);
  assert.equal(recording.count('obd.rpm', T0 + 500, T0 + 2500), 2);
  assert.equal(recording.count('obd.rpm', T0 + 2000, T0 + 2000), 1);
  assert.equal(recording.count('obd.rpm', T0 - 5000, T0 - 1000), 0);
  assert.equal(recording.count('obd.none', T0, T0 + 9000), 0);
});

test('an angle is interpolated the short way round', () => {
  const recording = new Recording([
    table('drift', ['timestamp_ms', 'heading_deg', 'drift_angle_deg'], [
      [T0, 350, 170],
      [T0 + 1000, 10, -170],
    ]),
  ]);
  assert.ok(Math.abs(recording.interpolateAngle('drift.heading_deg', T0 + 500) - 0) < 1e-9 || Math.abs(recording.interpolateAngle('drift.heading_deg', T0 + 500) - 360) < 1e-9);
  assert.ok(Math.abs(recording.interpolateAngle('drift.heading_deg', T0 + 250) - 355) < 1e-9);
  // A signal with negative values stays between -180 and 180.
  assert.ok(Math.abs(Math.abs(recording.interpolateAngle('drift.drift_angle_deg', T0 + 500)) - 180) < 1e-9);
  assert.ok(Math.abs(recording.interpolateAngle('drift.drift_angle_deg', T0 + 750) - -175) < 1e-9);
  assert.equal(recording.interpolateAngle('drift.none', T0), null);
});

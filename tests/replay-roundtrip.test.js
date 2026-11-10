// A log saved by the app and opened again for replay is the same recording.
// This follows the files from Save to the replay without the screen: rows and
// samples to CSV, CSV into the archive, the archive back into tables, the
// tables into a recording.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileName, toCsv } from '../src/csv.js';
import { DRIFT_STREAM } from '../src/drift.js';
import { FIELDS } from '../src/pids.js';
import { Recording, parseCsv, streamOf } from '../src/replay.js';
import { SampleLog } from '../src/samples.js';
import { STREAMS } from '../src/sensors.js';
import { unzip, zip } from '../src/zip.js';

const T0 = new Date(2026, 10, 10, 18, 5, 0).getTime();
const decoder = new TextDecoder();

/** A car row with one value, as a K-line car gives them. */
function carRow(time, field, value) {
  const row = FIELDS.map(() => null);
  row[0] = time;
  row[FIELDS.indexOf(field)] = value;
  return row;
}

/** Twenty seconds of a drive, a pause of a minute and ten seconds more. */
function drive() {
  const rows = [];
  const samples = new SampleLog([...STREAMS, DRIFT_STREAM]);
  const fields = ['rpm', 'speed_kmh', 'throttle_pct'];
  for (const [from, seconds] of [
    [T0, 20],
    [T0 + 80000, 10],
  ]) {
    for (let ms = 0; ms <= seconds * 1000; ms += 20) {
      const time = from + ms;
      if (ms % 240 === 0) rows.push(carRow(time, fields[(ms / 240) % 3], 1000 + ms / 10));
      samples.add('gyroscope', [time + 0.4, 0.001, -0.002, ms / 20000]);
      if (ms % 1000 === 0) samples.add('gps', [time, time - 300, 52.4737 + ms * 1e-8, 13.4017 + ms * 2e-8, null, 3, null, 45, 12.5]);
      if (ms % 100 === 0) samples.add('drift', [time, 50, 45, 5, 2.5, 12.5, 52.4737 + ms * 1e-8, 13.4017 + ms * 2e-8, 10, 1, 0, 1, 300]);
    }
  }
  return { rows, samples };
}

/** What Save writes: the car's CSV, one CSV per phone stream that has samples, and a description. */
async function saved({ rows, samples }) {
  const stamp = new Date(T0 + 90000);
  const entries = [{ name: fileName(stamp, 'obd_data'), data: toCsv(rows) }];
  for (const name of samples.names) {
    const data = samples.csv(name);
    if (data) entries.push({ name: fileName(stamp, `phone_${name}`), data });
  }
  entries.push({ name: fileName(stamp, 'log_info', 'txt'), data: 'described here\r\n' });
  return zip(entries, { date: stamp });
}

/** What the replay does with an archive. */
async function opened(archive) {
  const tables = [];
  for (const entry of await unzip(archive)) {
    if (!/\.csv$/i.test(entry.name)) continue;
    tables.push({ stream: streamOf(entry.name), ...parseCsv(decoder.decode(entry.bytes)) });
  }
  return new Recording(tables);
}

test('a saved archive opens as one recording: every stream, nothing left out', async () => {
  const recording = await opened(await saved(drive()));
  assert.deepEqual(recording.skipped, []);
  const streams = [...new Set(recording.signals.map(({ stream }) => stream))];
  assert.deepEqual(streams, ['obd', 'gyroscope', 'gps', 'drift']);
  assert.equal(recording.start, T0);
  assert.equal(recording.end, T0 + 90000.4);
  // The pause is found, and the half millisecond between the streams is not one.
  assert.deepEqual(recording.stretches(), [
    [T0, T0 + 20000.4],
    [T0 + 80000, T0 + 90000.4],
  ]);
});

test('the car values come back each at the time of its own request', async () => {
  const { rows, samples } = drive();
  const recording = await opened(await saved({ rows, samples }));
  const rpm = recording.series('obd.rpm');
  const speed = recording.series('obd.speed_kmh');
  const expected = rows.filter((row) => row[FIELDS.indexOf('rpm')] !== null);
  assert.equal(rpm.times.length, expected.length);
  assert.deepEqual([...rpm.times.slice(0, 3)], [T0, T0 + 720, T0 + 1440]);
  assert.deepEqual([...speed.times.slice(0, 3)], [T0 + 240, T0 + 960, T0 + 1680]);
  assert.equal(recording.value('obd.rpm', T0 + 1000), 1072);
  assert.equal(recording.value('obd.speed_kmh', T0 + 1000), 1096);
  // Columns the car never filled are no signals.
  assert.equal(recording.has('obd.oil_c'), false);
});

test('the phone samples come back with the precision they were written with', async () => {
  const recording = await opened(await saved(drive()));
  const gyroscope = recording.series('gyroscope.z_rads');
  assert.equal(gyroscope.times.length, 1001 + 501);
  assert.equal(gyroscope.times[1], T0 + 20.4);
  assert.equal(recording.value('gyroscope.z_rads', T0 + 10000.4), 0.5);
  assert.equal(recording.value('gps.latitude_deg', T0 + 5000), 52.47375);
  assert.equal(recording.value('gps.fix_ms', T0 + 5000), T0 + 4700);
  // A value the phone never gave (altitude) is no signal; one that is always the same still is.
  assert.equal(recording.has('gps.altitude_m'), false);
  assert.equal(recording.value('gps.accuracy_m', T0 + 5000), 3);
  // Between two fixes the position moves on a straight line.
  assert.ok(Math.abs(recording.interpolate('gps.latitude_deg', T0 + 5500, 3000) - 52.473755) < 1e-9);
  assert.equal(recording.value('drift.drift_angle_deg', T0 + 85000), 5);
});

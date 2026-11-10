// The drift angle of a recording is worked out again from its sensors. The
// recordings here are the made-up demo drive, written into tables the way a
// log holds them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMO_START, demoDrive, demoPhone } from '../src/demo-drive.js';
import { driftTable } from '../src/drift-replay.js';
import { DRIFT_STREAM, wrap180 } from '../src/drift.js';
import { metersBetween, offsetBy } from '../src/geo.js';
import { Recording } from '../src/replay.js';

const T0 = new Date(2026, 10, 10, 20, 0, 0).getTime();
const GPS_DELAY_MS = 300;
const GPS_COLUMNS = ['timestamp_ms', 'fix_ms', 'latitude_deg', 'longitude_deg', 'altitude_m', 'accuracy_m', 'altitude_accuracy_m', 'heading_deg', 'speed_ms'];

const table = (stream, columns, rows) => ({ stream, columns, data: Float64Array.from(rows.flat().map((value) => value ?? NaN)) });

/** Quaternion [x, y, z, w] turned about the vertical axis by `degrees`, counter-clockwise. */
function turned(q, degrees) {
  const half = (degrees * Math.PI) / 360;
  const [s, c] = [Math.sin(half), Math.cos(half)];
  return [c * q[0] - s * q[1], c * q[1] + s * q[0], c * q[2] + s * q[3], c * q[3] - s * q[2]];
}

/**
 * The demo drive as a log holds it. `start` is the time of its first sample
 * and `compass` adds the attitude with the compass, which swings by that many
 * degrees and whose samples come a tenth of a millisecond before the others.
 */
function drive({ seconds = 40, start = T0, compass = null, relative = true, gps = true, wheels = null } = {}) {
  const attitude = [];
  const withCompass = [];
  const acceleration = [];
  const fixes = [];
  const car = [];
  for (let step = 0; step <= seconds * 60; step += 1) {
    const t = step / 60;
    const time = start + t * 1000;
    const phone = demoPhone(demoDrive(t));
    attitude.push([time, ...phone.attitude]);
    if (compass !== null) withCompass.push([time - 0.1, ...turned(phone.attitude, compass * Math.sin(t / 3))]);
    acceleration.push([time, ...phone.acceleration]);
    if (step % 60 === 0 && t >= 1) {
      const then = demoDrive(t - GPS_DELAY_MS / 1000);
      const place = offsetBy(DEMO_START, then.east, then.north);
      fixes.push([time, time - GPS_DELAY_MS, place.latitude, place.longitude, null, 3, null, then.course, then.speed]);
      if (wheels) car.push([time - 100, wheels(then)]);
    }
  }
  const tables = [table('linear_acceleration', ['timestamp_ms', 'x_ms2', 'y_ms2', 'z_ms2'], acceleration)];
  if (relative) tables.push(table('relative_orientation', ['timestamp_ms', 'qx', 'qy', 'qz', 'qw'], attitude));
  if (compass !== null) tables.push(table('orientation', ['timestamp_ms', 'qx', 'qy', 'qz', 'qw'], withCompass));
  if (gps) tables.push(table('gps', GPS_COLUMNS, fixes));
  if (car.length) tables.push(table('obd', ['timestamp_ms', 'speed_kmh'], car));
  return tables;
}

/** The rows of a worked-out table as objects. */
function rows({ columns, data }) {
  const out = [];
  for (let offset = 0; offset < data.length; offset += columns.length) {
    out.push(Object.fromEntries(columns.map((column, index) => [column, data[offset + index]])));
  }
  return out;
}

const errors = (worked, from = 14) =>
  rows(worked)
    .filter((row) => row.timestamp_ms >= T0 + from * 1000)
    .map((row) => Math.abs(wrap180(row.drift_angle_deg - demoDrive((row.timestamp_ms - T0) / 1000).slip)));

test('the drift angle of a recording is worked out again from its sensors', () => {
  const worked = driftTable(new Recording(drive()));
  assert.deepEqual(worked.columns, ['timestamp_ms', ...DRIFT_STREAM.columns]);
  const all = rows(worked);
  // Ten rows a second from the first sample to the last.
  assert.equal(all.length, 401);
  assert.equal(all[0].timestamp_ms, T0);
  assert.ok(Math.abs(all[1].timestamp_ms - all[0].timestamp_ms - 100) < 1e-6);
  // Before the car has driven straight nothing is claimed; later the angle is the slip of the demo car.
  assert.equal(all[0].calibrated, 0);
  assert.ok(Number.isNaN(all[0].drift_angle_deg));
  assert.equal(all.at(-1).calibrated, 1);
  const worst = Math.max(...errors(worked));
  assert.ok(worst < 3, `worst error ${worst.toFixed(1)} degrees`);
  // The position follows the car between the fixes as well.
  const last = all.at(-1);
  const truth = demoDrive((last.timestamp_ms - T0) / 1000);
  const off = metersBetween(offsetBy(DEMO_START, truth.east, truth.north), { latitude: last.latitude_deg, longitude: last.longitude_deg });
  assert.ok(Math.hypot(off.east, off.north) < 3, `${Math.hypot(off.east, off.north).toFixed(1)} m off`);
});

test('a compass that swings does not reach the angle when the attitude without it was recorded too', () => {
  // On the first real drive the samples with the compass came first and the heading wandered with it.
  const plain = driftTable(new Recording(drive()));
  const swinging = driftTable(new Recording(drive({ compass: 40 })));
  assert.equal(swinging.data.length, plain.data.length);
  // Row by row the same angle; the rows themselves start a tenth of a millisecond earlier.
  const expected = rows(plain);
  const apart = rows(swinging)
    .map((row, index) => Math.abs(wrap180(row.drift_angle_deg - expected[index].drift_angle_deg)))
    .filter((difference) => !Number.isNaN(difference));
  assert.ok(apart.length > 250);
  assert.ok(Math.max(...apart) < 0.05, `${Math.max(...apart)} degrees apart`);
});

test('a phone that has only the attitude with the compass is worked out from that', () => {
  const worked = driftTable(new Recording(drive({ compass: 0, relative: false })));
  const worst = Math.max(...errors(worked));
  assert.ok(worst < 3, `worst error ${worst.toFixed(1)} degrees`);
});

test('without positions or without an attitude there is nothing to work out', () => {
  assert.equal(driftTable(new Recording(drive({ gps: false }))), null);
  assert.equal(driftTable(new Recording(drive({ relative: false }))), null);
  assert.equal(driftTable(new Recording([table('obd', ['timestamp_ms', 'rpm'], [[T0, 800]])])), null);
});

test('a second recording session starts from nothing', () => {
  // Five minutes later the phone may sit differently in its holder.
  const later = T0 + 340000;
  const both = [...drive({ seconds: 30 }), ...drive({ seconds: 30, start: later })];
  const all = rows(driftTable(new Recording(both)));
  const second = all.filter((row) => row.timestamp_ms >= later);
  assert.equal(all.length, 301 + 301);
  // No rows in the silence between the two.
  assert.ok(all.every((row) => row.timestamp_ms <= T0 + 30000 || row.timestamp_ms >= later));
  assert.equal(all[300].calibrated, 1);
  assert.equal(second[0].calibrated, 0);
  assert.ok(Number.isNaN(second[0].heading_deg));
  assert.equal(second.at(-1).calibrated, 1);
});

test('the speed of the wheels from the car is used as in the live view', () => {
  // Wheels that turn much faster than the car moves: no fix counts as driving straight, so the heading is never set.
  const spinning = driftTable(new Recording(drive({ seconds: 12, wheels: (car) => car.speed * 3.6 * 1.6 })));
  assert.ok(rows(spinning).every((row) => row.calibrated === 0));
  const gripping = driftTable(new Recording(drive({ seconds: 12, wheels: (car) => car.speed * 3.6 })));
  assert.equal(rows(gripping).at(-1).calibrated, 1);
});

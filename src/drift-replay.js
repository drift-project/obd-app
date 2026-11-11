// Works out the drift angle of a recording again, from the sensors that were
// recorded, with the estimator of this version.
//
// What the drift view showed during the drive is in the log as `phone_drift`,
// worked out by the version that recorded it. A replay should not be stuck
// with the mistakes of that version, and a log from a version without the
// drift view has no such stream at all. So the attitude, the acceleration
// and the fixes are fed to the estimator once more, in the order and with the
// rules of the live view, and the result is a table of the same shape.

import { DRIFT_STREAM, DriftEstimator, pickAttitude } from './drift.js';

const STEP_MS = 100; // the live view logs ten times a second
const WHEEL_HOLD_MS = 2500; // how long a speed read from the car counts as the speed of the wheels, as in the live view
// A longer silence of the attitude sensor means another recording session: the
// phone may sit differently in its holder, so nothing is carried over.
const NEW_SESSION_MS = 30000;
const ATTITUDE = ['qx', 'qy', 'qz', 'qw'];
const ACCELERATION = ['x_ms2', 'y_ms2', 'z_ms2'];
const ROTATION = ['x_rads', 'y_rads', 'z_rads'];

/** The columns of a stream row by row, or null when it is absent or has gaps (then its columns do not line up). */
function rowsOf(recording, stream, columns) {
  const all = columns.map((column) => recording.series(`${stream}.${column}`));
  const { times } = all[0];
  if (!times.length || all.some((series) => series.times.length !== times.length)) return null;
  return { stream, times, values: all.map((series) => series.values) };
}

/**
 * The `drift` stream of a recording worked out again: `{ columns, data }` in
 * the shape of the recorded one, or null when the recording has no attitude
 * of the phone or no positions.
 */
export function driftTable(recording) {
  const attitudes = ['orientation', 'relative_orientation'].map((stream) => rowsOf(recording, stream, ATTITUDE)).filter(Boolean);
  const fixes = recording.series('gps.latitude_deg').times;
  if (!attitudes.length || !fixes.length) return null;
  const acceleration = rowsOf(recording, 'linear_acceleration', ACCELERATION);
  // With gravity, and the gyroscope: from these the estimator tells when the phone was handled.
  const accelerometer = rowsOf(recording, 'accelerometer', ACCELERATION);
  const gyroscope = rowsOf(recording, 'gyroscope', ROTATION);

  // The samples are taken in the order they reached the app. At the same instant the attitude comes first.
  const feeds = [
    ...attitudes.map((rows) => ({ kind: 'attitude', rows, times: rows.times, at: 0 })),
    ...(acceleration ? [{ kind: 'acceleration', rows: acceleration, times: acceleration.times, at: 0 }] : []),
    ...(accelerometer ? [{ kind: 'accelerometer', rows: accelerometer, times: accelerometer.times, at: 0 }] : []),
    ...(gyroscope ? [{ kind: 'gyroscope', rows: gyroscope, times: gyroscope.times, at: 0 }] : []),
    { kind: 'fix', rows: null, times: fixes, at: 0 },
  ];
  const exact = (id, time) => recording.value(id, time, 0);
  const out = [];
  let estimator = new DriftEstimator();
  let current = null; // the attitude stream in use
  let attitudeAt = -Infinity;
  let next = null; // time of the next row
  const write = (time) => {
    const seen = estimator.at(time);
    out.push(
      time,
      seen.heading ?? NaN,
      seen.course ?? NaN,
      seen.driftAngle ?? NaN,
      seen.yawRate ?? NaN,
      seen.speed ?? NaN,
      seen.position?.latitude ?? NaN,
      seen.position?.longitude ?? NaN,
      seen.offset ?? NaN,
      seen.calibrated ? 1 : 0,
      seen.corrected ? 1 : 0,
      seen.aided ? 1 : 0,
      seen.gpsDelay ?? NaN,
      seen.ahead ?? NaN,
      seen.right ?? NaN,
    );
  };

  for (;;) {
    let feed = null;
    for (const candidate of feeds) {
      if (candidate.at < candidate.times.length && (!feed || candidate.times[candidate.at] < feed.times[feed.at])) feed = candidate;
    }
    if (!feed) break;
    const index = feed.at;
    const time = feed.times[index];
    feed.at += 1;

    // Rows are written up to this sample, as long as the sensors were running: no row once the attitude has been silent for a step.
    while (next !== null && next <= time && next - attitudeAt < STEP_MS) {
      write(next);
      next += STEP_MS;
    }
    if (feed.kind === 'attitude') {
      if (time - attitudeAt > NEW_SESSION_MS) {
        estimator = new DriftEstimator();
        current = null;
        next = time;
      } else if (next < time) {
        // The sensors paused for a moment: the rows go on from here.
        next = time;
      }
      const picked = pickAttitude(current, feed.rows.stream);
      if (!picked) continue;
      const restart = current !== null && current !== picked;
      current = picked;
      attitudeAt = time;
      estimator.attitude(time, feed.rows.values.map((values) => values[index]), restart);
    } else if (feed.kind === 'acceleration') {
      estimator.acceleration(time, feed.rows.values.map((values) => values[index]));
    } else if (feed.kind === 'accelerometer') {
      estimator.accelerometer(time, feed.rows.values.map((values) => values[index]));
    } else if (feed.kind === 'gyroscope') {
      estimator.gyroscope(time, feed.rows.values.map((values) => values[index]));
    } else {
      const wheel = recording.value('obd.speed_kmh', time, WHEEL_HOLD_MS);
      estimator.fix(time, {
        latitude: exact('gps.latitude_deg', time),
        longitude: exact('gps.longitude_deg', time),
        accuracy: exact('gps.accuracy_m', time),
        course: exact('gps.heading_deg', time),
        speed: exact('gps.speed_ms', time),
        wheelSpeed: wheel === null ? null : wheel / 3.6,
      });
    }
  }
  if (!out.length) return null;
  return { columns: ['timestamp_ms', ...DRIFT_STREAM.columns], data: Float64Array.from(out) };
}

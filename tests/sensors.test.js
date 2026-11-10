// The phone sensors run here against fake sensor classes and a fake
// Geolocation, shaped like the ones in Chrome.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAGNETOMETER_HZ, MOTION_HZ, PhoneSensors, STREAMS } from '../src/sensors.js';

const OFFSET = 1_793_916_000_000; // epoch time of the page's clock zero

/** A sensor class like Chrome's; every instance is kept in `made`. */
function sensorClass(made, { failOnStart = null, failOnCreate = null } = {}) {
  return class extends EventTarget {
    constructor(options) {
      super();
      if (failOnCreate) throw failOnCreate;
      this.options = options;
      this.started = false;
      made.push(this);
    }

    start() {
      this.started = true;
      if (failOnStart) queueMicrotask(() => this.fail(failOnStart));
    }

    stop() {
      this.started = false;
    }

    read(timestamp, values) {
      this.timestamp = timestamp;
      Object.assign(this, values);
      this.dispatchEvent(new Event('reading'));
    }

    fail(error) {
      this.dispatchEvent(Object.assign(new Event('error'), { error }));
    }
  };
}

function fakeGeolocation() {
  return {
    watches: new Map(),
    nextId: 7,
    watchPosition(success, failure, options) {
      this.nextId += 1;
      this.watches.set(this.nextId, { success, failure, options });
      return this.nextId;
    },
    clearWatch(id) {
      this.watches.delete(id);
    },
  };
}

function setup(overrides = {}) {
  const made = { Accelerometer: [], LinearAccelerationSensor: [], Gyroscope: [], Magnetometer: [], AbsoluteOrientationSensor: [], RelativeOrientationSensor: [] };
  const geolocation = fakeGeolocation();
  const page = { now: 5000 }; // the page's steady clock, in ms
  const scope = { performance: { now: () => page.now }, navigator: { geolocation } };
  for (const [name, list] of Object.entries(made)) scope[name] = sensorClass(list);
  Object.assign(scope, overrides);
  const samples = [];
  let changes = 0;
  const sensors = new PhoneSensors({
    scope,
    toEpochMs: (ticks) => OFFSET + ticks,
    onSample: (name, values) => samples.push([name, ...values]),
    onChange: () => {
      changes += 1;
    },
  });
  const state = (name) => sensors.states.find((stream) => stream.name === name);
  return { sensors, made, geolocation, samples, state, page, changes: () => changes };
}

test('every motion sensor is asked for the highest rate Chrome allows', () => {
  const { sensors, made } = setup();
  sensors.start();
  for (const [name, list] of Object.entries(made)) {
    assert.equal(list.length, 1, name);
    assert.equal(list[0].started, true, name);
    assert.deepEqual(list[0].options, { frequency: name === 'Magnetometer' ? MAGNETOMETER_HZ : MOTION_HZ }, name);
  }
  assert.equal(MOTION_HZ, 60);
  assert.equal(MAGNETOMETER_HZ, 10);
});

test('a reading becomes a sample with the time it was taken and the three axes', () => {
  const { sensors, made, samples, state, page } = setup();
  sensors.start();
  assert.equal(state('gyroscope').state, 'starting');
  // Taken at 4994.5 ms, delivered to the page 5.5 ms later.
  made.Gyroscope[0].read(page.now - 5.5, { x: 0.1, y: -0.2, z: 0.3 });
  assert.deepEqual(samples, [['gyroscope', OFFSET + 4994.5, 0.1, -0.2, 0.3]]);
  assert.equal(state('gyroscope').state, 'on');
  assert.deepEqual(sensors.clockShifts, { gyroscope: 0 });
});

test('orientation is recorded as a quaternion', () => {
  const { sensors, made, samples, page } = setup();
  sensors.start();
  made.AbsoluteOrientationSensor[0].read(page.now - 2, { quaternion: [0, 0, 0.7071, 0.7071] });
  made.RelativeOrientationSensor[0].read(page.now - 1, { quaternion: [0, 0, 0, 1] });
  assert.deepEqual(samples, [
    ['orientation', OFFSET + 4998, 0, 0, 0.7071, 0.7071],
    ['relative_orientation', OFFSET + 4999, 0, 0, 0, 1],
  ]);
});

test('a sensor clock that runs apart from the page clock is moved onto it', () => {
  // Android can count the time the phone slept in the sensor clock and not in the page clock.
  const AHEAD = 3 * 3600 * 1000;
  const { sensors, made, samples, page } = setup();
  sensors.start();
  const gyro = made.Gyroscope[0];
  const reading = (takenAt, deliveredAt) => {
    page.now = deliveredAt;
    gyro.read(AHEAD + takenAt, { x: 0, y: 0, z: 0 });
    // Epoch milliseconds leave a double about a quarter of a microsecond of precision.
    return Math.round((samples.at(-1)[1] - OFFSET) * 100) / 100;
  };
  // The first reading arrives late (30 ms), so it is all that is known about the difference.
  assert.equal(reading(5000, 5030), 5030);
  // A reading that arrives after 4 ms shows the clocks are at most 4 ms further apart.
  assert.equal(reading(5016, 5020), 5030.1); // never behind the reading before it
  assert.equal(reading(5033, 5040), 5037);
  assert.equal(reading(5050, 5054), 5054);
  // From here the spacing is the sensor's own: 16.5 ms, whatever the delivery jitter.
  assert.equal(reading(5066.5, 5090), 5070.5);
  assert.deepEqual(sensors.clockShifts, { gyroscope: -AHEAD + 4 });
});

test('a reading without its own timestamp is stamped with the current time', () => {
  const { sensors, made, samples } = setup();
  sensors.start();
  made.Accelerometer[0].read(undefined, { x: 0, y: 9.81, z: 0 });
  assert.deepEqual(samples, [['accelerometer', OFFSET + 5000, 0, 9.81, 0]]);
});

test('a position fix keeps its own time and every field the phone gives', () => {
  const { sensors, geolocation, samples, state } = setup();
  sensors.start();
  const [watch] = [...geolocation.watches.values()];
  assert.deepEqual(watch.options, { enableHighAccuracy: true, maximumAge: 0 });
  assert.equal(state('gps').state, 'starting');
  watch.success({
    timestamp: OFFSET + 4200,
    coords: { latitude: 52.2296756, longitude: 21.0122287, altitude: 113.4, accuracy: 3.9, altitudeAccuracy: null, heading: 271.5, speed: 13.9 },
  });
  assert.deepEqual(samples, [['gps', OFFSET + 5000, OFFSET + 4200, 52.2296756, 21.0122287, 113.4, 3.9, null, 271.5, 13.9]]);
  assert.equal(state('gps').state, 'on');
});

test('a sensor the browser does not offer is reported as missing, the rest still run', () => {
  const { sensors, made, state } = setup({ Magnetometer: undefined });
  sensors.start();
  assert.equal(state('magnetometer').state, 'missing');
  assert.match(state('magnetometer').detail, /switched off in Chrome/);
  assert.equal(made.Gyroscope[0].started, true);
});

test('a magnetometer that Chrome offers but refuses to start is not blamed on the phone', async () => {
  // With experimental web features on, the class exists while the sensor itself stays switched off.
  const refused = Object.assign(new Error('not available'), { name: 'NotReadableError' });
  const { sensors, state } = setup({ Magnetometer: sensorClass([], { failOnStart: refused }), Gyroscope: sensorClass([], { failOnStart: refused }) });
  sensors.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(state('magnetometer').detail, /switched off in Chrome/);
  // The same answer for a gyroscope does mean the phone has none.
  assert.equal(state('gyroscope').detail, 'this device has no such sensor');
});

test('a blocked sensor and a phone without the chip are told apart', async () => {
  const blocked = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const noChip = Object.assign(new Error('no sensor'), { name: 'NotReadableError' });
  const { sensors, state } = setup({
    Gyroscope: sensorClass([], { failOnStart: blocked }),
    Accelerometer: sensorClass([], { failOnStart: noChip }),
    LinearAccelerationSensor: sensorClass([], { failOnCreate: Object.assign(new Error('policy'), { name: 'SecurityError' }) }),
  });
  sensors.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state('gyroscope').state, 'blocked');
  assert.equal(state('accelerometer').state, 'missing');
  assert.equal(state('linear_acceleration').state, 'blocked');
});

test('a refused location permission is reported, a missing fix keeps waiting', () => {
  const { sensors, geolocation, state } = setup();
  sensors.start();
  const [watch] = [...geolocation.watches.values()];
  watch.failure({ code: 2, message: 'unavailable' });
  assert.equal(state('gps').state, 'waiting');
  watch.failure({ code: 1, message: 'denied' });
  assert.deepEqual(state('gps'), { name: 'gps', state: 'blocked', detail: 'location permission was not given' });
});

test('a browser without geolocation still records motion', () => {
  const { sensors, made, state } = setup({ navigator: {} });
  sensors.start();
  assert.equal(state('gps').state, 'missing');
  assert.equal(made.Accelerometer[0].started, true);
});

test('stop ends every sensor and the position watch', () => {
  const { sensors, made, geolocation, state } = setup({ Magnetometer: undefined });
  sensors.start();
  made.Gyroscope[0].read(1, { x: 0, y: 0, z: 0 });
  sensors.stop();
  assert.ok(Object.values(made).every((list) => list.every((sensor) => sensor.started === false)));
  assert.equal(geolocation.watches.size, 0);
  assert.equal(state('gyroscope').state, 'off');
  assert.equal(state('gps').state, 'off');
  // What could not run keeps its reason.
  assert.equal(state('magnetometer').state, 'missing');
  sensors.stop();
});

test('the screen is told only when a state changes, not on every reading', () => {
  const { sensors, made, changes } = setup();
  sensors.start();
  const afterStart = changes();
  made.Gyroscope[0].read(1, { x: 0, y: 0, z: 0 });
  made.Gyroscope[0].read(2, { x: 0, y: 0, z: 0 });
  made.Gyroscope[0].read(3, { x: 0, y: 0, z: 0 });
  assert.equal(changes(), afterStart + 1);
});

test('every stream names its columns and precision', () => {
  for (const stream of STREAMS) {
    assert.ok(stream.columns.length > 0, stream.name);
    const digits = Array.isArray(stream.digits) ? stream.digits : [stream.digits];
    assert.ok(digits.every((value) => Number.isInteger(value) && value >= 0), stream.name);
    if (Array.isArray(stream.digits)) assert.equal(stream.digits.length, stream.columns.length, stream.name);
  }
  assert.deepEqual(STREAMS.map((stream) => stream.name), ['accelerometer', 'linear_acceleration', 'gyroscope', 'magnetometer', 'orientation', 'relative_orientation', 'gps']);
});

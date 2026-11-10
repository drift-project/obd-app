// Phone sensors recorded next to the car data: motion through the Generic
// Sensor API and position through the Geolocation API.
//
// The rates are the highest Chrome gives a web page: 60 Hz for the motion
// sensors and 10 Hz for the magnetometer (both are limits in Chrome, the chips
// are faster), and whatever the phone reports for position, usually one fix a
// second. A sensor that is asked for less runs at Chrome's default of 10 Hz.

export const MOTION_HZ = 60;
export const MAGNETOMETER_HZ = 10;

const XYZ = (unit) => [`x_${unit}`, `y_${unit}`, `z_${unit}`];
const QUATERNION = ['qx', 'qy', 'qz', 'qw'];

/**
 * What is recorded. `columns` follow the timestamp in every sample and
 * `digits` is the precision written to the CSV. Axes are those of the phone:
 * x to the right of the screen, y to its top, z out of the screen.
 */
export const STREAMS = [
  { name: 'accelerometer', source: 'Accelerometer', hz: MOTION_HZ, columns: XYZ('ms2'), digits: 4, about: 'acceleration including gravity, m/s2' },
  { name: 'linear_acceleration', source: 'LinearAccelerationSensor', hz: MOTION_HZ, columns: XYZ('ms2'), digits: 4, about: 'acceleration without gravity, m/s2' },
  { name: 'gyroscope', source: 'Gyroscope', hz: MOTION_HZ, columns: XYZ('rads'), digits: 5, about: 'rotation rate, rad/s' },
  { name: 'magnetometer', source: 'Magnetometer', hz: MAGNETOMETER_HZ, columns: XYZ('ut'), digits: 2, about: 'magnetic field, microtesla' },
  { name: 'orientation', source: 'AbsoluteOrientationSensor', hz: MOTION_HZ, columns: QUATERNION, digits: 5, about: 'phone attitude against the Earth (uses the compass), unit quaternion' },
  { name: 'relative_orientation', source: 'RelativeOrientationSensor', hz: MOTION_HZ, columns: QUATERNION, digits: 5, about: 'phone attitude without the compass, unit quaternion' },
  {
    name: 'gps',
    source: 'geolocation',
    columns: ['fix_ms', 'latitude_deg', 'longitude_deg', 'altitude_m', 'accuracy_m', 'altitude_accuracy_m', 'heading_deg', 'speed_ms'],
    digits: [0, 7, 7, 1, 1, 1, 1, 2],
    about: 'position fix; fix_ms is the time of the fix, timestamp_ms the time it reached the app',
  },
];

const MISSING_HINT = {
  Magnetometer: 'off in Chrome by default: turn on chrome://flags/#enable-generic-sensor-extra-classes',
};

const GEOLOCATION_PROBLEMS = {
  1: ['blocked', 'location permission was not given'],
  2: ['waiting', 'no position yet (is location turned on?)'],
  3: ['waiting', 'no position yet'],
};

// A sensor reading carries the time it was taken on the sensor's own clock.
// Chrome reports it on the clock of the page, but on Android the two can run
// apart (one counts the time the phone slept, the other does not). A reading
// can only reach the page after it was taken, so the smallest delay seen is
// the difference between the clocks; beyond this limit it is removed.
const CLOCKS_AGREE_MS = 250;

function sensorProblem(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return ['blocked', 'motion sensors are blocked for this site'];
  if (error?.name === 'NotReadableError') return ['missing', 'this device has no such sensor'];
  return ['failed', error?.message || error?.name || 'unknown error'];
}

/**
 * Starts every sensor the browser offers and hands each reading to
 * `onSample(name, [timestamp_ms, ...values])`.
 *
 * `toEpochMs` turns a time on the page's steady clock (`performance.now()`)
 * into epoch milliseconds. `scope` is the global object; tests pass a
 * fake one. A stream is in one of the states `starting`, `on`, `waiting`
 * (position not found yet), `missing`, `blocked`, `failed` or `off`.
 */
export class PhoneSensors {
  #scope;
  #toEpochMs;
  #onSample;
  #onChange;
  #states = new Map();
  #clocks = new Map(); // stream name -> { shift, last } of its sensor clock
  #sensors = [];
  #watch = null;

  constructor({ scope = globalThis, toEpochMs, onSample, onChange = () => {} }) {
    this.#scope = scope;
    this.#toEpochMs = toEpochMs;
    this.#onSample = onSample;
    this.#onChange = onChange;
    for (const { name } of STREAMS) this.#states.set(name, { state: 'off', detail: '' });
  }

  /**
   * Time of a reading on the page clock, in milliseconds. The sensor's own
   * timestamp is used as it is while it agrees with the page clock, and
   * shifted by the measured difference when it does not.
   */
  #pageTime(name, sensorTime) {
    const now = this.#scope.performance.now();
    if (typeof sensorTime !== 'number' || !Number.isFinite(sensorTime)) return now;
    const clock = this.#clocks.get(name) ?? { shift: Infinity, last: -Infinity };
    this.#clocks.set(name, clock);
    clock.shift = Math.min(clock.shift, now - sensorTime);
    if (Math.abs(clock.shift) <= CLOCKS_AGREE_MS) return sensorTime;
    // While the difference is still settling a reading must not jump behind the one before it.
    clock.last = Math.max(sensorTime + clock.shift, clock.last + 0.1);
    return clock.last;
  }

  /** How far each sensor clock was moved to match the page clock, in ms (0 when they agree). */
  get clockShifts() {
    const shifts = {};
    for (const [name, { shift }] of this.#clocks) shifts[name] = Math.abs(shift) <= CLOCKS_AGREE_MS ? 0 : Math.round(shift);
    return shifts;
  }

  /** `[{ name, state, detail }]` in the order of STREAMS. */
  get states() {
    return STREAMS.map(({ name }) => ({ name, ...this.#states.get(name) }));
  }

  #set(name, state, detail = '') {
    const current = this.#states.get(name);
    if (current.state === state && current.detail === detail) return;
    this.#states.set(name, { state, detail });
    this.#onChange();
  }

  start() {
    for (const stream of STREAMS) {
      if (stream.source === 'geolocation') this.#startPosition(stream);
      else this.#startSensor(stream);
    }
  }

  #startSensor({ name, source, hz }) {
    const Sensor = this.#scope[source];
    if (typeof Sensor !== 'function') {
      this.#set(name, 'missing', MISSING_HINT[source] ?? 'not offered by this browser');
      return;
    }
    let sensor;
    try {
      sensor = new Sensor({ frequency: hz });
    } catch (error) {
      this.#set(name, ...sensorProblem(error));
      return;
    }
    sensor.addEventListener('reading', () => {
      const values = sensor.quaternion ?? [sensor.x, sensor.y, sensor.z];
      this.#onSample(name, [this.#toEpochMs(this.#pageTime(name, sensor.timestamp)), ...values]);
      this.#set(name, 'on');
    });
    sensor.addEventListener('error', (event) => this.#set(name, ...sensorProblem(event.error)));
    this.#set(name, 'starting');
    try {
      sensor.start();
      this.#sensors.push(sensor);
    } catch (error) {
      this.#set(name, ...sensorProblem(error));
    }
  }

  #startPosition({ name }) {
    const geolocation = this.#scope.navigator?.geolocation;
    if (!geolocation) {
      this.#set(name, 'missing', 'not offered by this browser');
      return;
    }
    this.#set(name, 'starting');
    const now = () => this.#scope.performance.now();
    this.#watch = geolocation.watchPosition(
      ({ coords, timestamp }) => {
        this.#onSample(name, [
          this.#toEpochMs(now()),
          timestamp,
          coords.latitude,
          coords.longitude,
          coords.altitude,
          coords.accuracy,
          coords.altitudeAccuracy,
          coords.heading,
          coords.speed,
        ]);
        this.#set(name, 'on');
      },
      (error) => this.#set(name, ...(GEOLOCATION_PROBLEMS[error?.code] ?? ['failed', error?.message || 'unknown error'])),
      // The newest fix every time, from the satellite receiver and not from the network.
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  stop() {
    for (const sensor of this.#sensors.splice(0)) {
      try {
        sensor.stop();
      } catch {
        // already stopped
      }
    }
    if (this.#watch !== null) {
      this.#scope.navigator.geolocation.clearWatch(this.#watch);
      this.#watch = null;
    }
    for (const { name } of STREAMS) {
      const { state } = this.#states.get(name);
      if (state === 'on' || state === 'starting' || state === 'waiting') this.#set(name, 'off');
    }
  }
}

// The drift estimator is driven here by made-up cars: a phone fixed in the
// car at an odd angle, attitude and acceleration 60 times a second and a GPS
// fix once a second that arrives late, as on a real phone.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMO_START, demoDrive } from '../src/demo-drive.js';
import { DRIFT_STREAM, DriftEstimator, wrap180, wrap360, yawBetween } from '../src/drift.js';
import { metersBetween, offsetBy } from '../src/geo.js';

const RADIANS = Math.PI / 180;

/** Quaternion [x, y, z, w] of a rotation about an axis, in degrees. */
function rotation(axis, degrees) {
  const half = (degrees * RADIANS) / 2;
  const sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

function multiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const inverse = (q) => [-q[0], -q[1], -q[2], q[3]];
const turnVector = (q, v) => multiply(multiply(q, [...v, 0]), inverse(q)).slice(0, 3);

const UP = [0, 0, 1];
// The phone leans back in its holder and is turned towards the driver.
const MOUNT = multiply(rotation([1, 0, 0], 65), rotation([0, 1, 0], -20));

/** Attitude of the phone when the car points `heading` degrees clockwise from north. */
const attitude = (heading) => multiply(rotation(UP, -heading), MOUNT);

/**
 * Drive the estimator with attitudes and fixes only: `car(t)` gives heading,
 * course and speed at t seconds (and wheelSpeed if the car reports it). The
 * fixes arrive without delay. For the rules that decide when the heading is
 * taken from GPS.
 */
function drive(estimator, car, { from = 0, to, gyroDrift = 0 }) {
  const steps = Math.round((to - from) * 60);
  for (let step = 0; step <= steps; step += 1) {
    const t = from + step / 60;
    const state = car(t);
    estimator.attitude(t * 1000, attitude(state.heading + gyroDrift * t));
    // A fix once a second; step counts avoid the rounding of t.
    if (step % 60 === 0) estimator.fix(t * 1000, state);
  }
  return estimator;
}

const instant = () => new DriftEstimator({ delay: 0 });

/** Repeatable noise, roughly normal, with standard deviation 1. */
function noiseSource(seed = 12345) {
  let state = seed;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return () => (uniform() + uniform() + uniform() + uniform() - 2) * Math.sqrt(3);
}

/**
 * Drive the estimator as a phone in a moving car does. `car(t)` gives the
 * place (metres north and east) and the heading at t seconds; speed, course
 * and acceleration follow from the motion. `frame` is how far the attitude's
 * own north is turned from true north, which the phone cannot know.
 * `each(t, shown, truth)` is called after every sensor sample.
 */
function ride(estimator, car, { to, frame = 0, gpsDelay = 300, noise = null, accelerometer = true, pause = null, each = () => {} }) {
  const random = noiseSource();
  const frameTurn = rotation(UP, -frame);
  const velocity = (t) => {
    const before = car(t - 0.01);
    const after = car(t + 0.01);
    return { north: (after.north - before.north) / 0.02, east: (after.east - before.east) / 0.02 };
  };
  const truth = (t) => {
    const { north, east } = velocity(t);
    const course = wrap360(Math.atan2(east, north) / RADIANS);
    return { ...car(t), speed: Math.hypot(north, east), course, slip: wrap180(car(t).heading - course) };
  };
  for (let step = 0; step <= Math.round(to * 60); step += 1) {
    const t = step / 60;
    const paused = pause && t > pause[0] && t < pause[1];
    const state = car(t);
    const inMap = multiply(rotation(UP, -state.heading), MOUNT);
    if (!paused) {
      estimator.attitude(t * 1000, multiply(frameTurn, inMap));
      if (accelerometer) {
        const before = car(t - 0.02);
        const after = car(t + 0.02);
        const east = (after.east - 2 * state.east + before.east) / 0.0004;
        const north = (after.north - 2 * state.north + before.north) / 0.0004;
        const inPhone = turnVector(inverse(inMap), [east, north, 0]);
        estimator.acceleration(t * 1000, noise ? inPhone.map((value) => value + noise.acceleration * random()) : inPhone);
      }
    }
    if (step % 60 === 0 && t >= gpsDelay / 1000) {
      // What arrives now was measured a moment ago.
      const then = truth(t - gpsDelay / 1000);
      const place = offsetBy(DEMO_START, then.east + (noise ? noise.position * random() : 0), then.north + (noise ? noise.position * random() : 0));
      estimator.fix(t * 1000, {
        ...place,
        accuracy: 3,
        course: wrap360(then.course + (noise ? noise.course * random() : 0)),
        speed: Math.max(0, then.speed + (noise ? noise.speed * random() : 0)),
      });
    }
    if (!paused) each(t, estimator.at(t * 1000), truth(t));
  }
  return estimator;
}

/** Worst and mean error of the shown drift angle after `from` seconds. */
function angleErrors(car, options, from = 14) {
  const errors = [];
  let aidedSamples = 0;
  const estimator = ride(new DriftEstimator(), car, {
    ...options,
    each: (t, shown, truth) => {
      if (t < from) return;
      assert.notEqual(shown.driftAngle, null, `no angle at ${t.toFixed(2)} s`);
      errors.push(Math.abs(wrap180(shown.driftAngle - truth.slip)));
      if (shown.aided) aidedSamples += 1;
    },
  });
  return {
    estimator,
    worst: Math.max(...errors),
    mean: errors.reduce((sum, error) => sum + error, 0) / errors.length,
    aidedShare: aidedSamples / errors.length,
  };
}

const near = (actual, expected, tolerance, message) => {
  assert.ok(actual !== null && Math.abs(wrap180(actual - expected)) <= tolerance, `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);
};

// --- Angles ---------------------------------------------------------------------------

test('angles wrap into their ranges', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap360(725), 5);
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(-190), 170);
  assert.equal(wrap180(180), -180);
  assert.equal(wrap180(0), 0);
});

test('a turn is measured about the vertical axis, however the phone is mounted', () => {
  // Turning left is counter-clockwise seen from above, so the heading falls.
  near(yawBetween(attitude(90), attitude(60)), 30, 1e-9);
  near(yawBetween(attitude(350), attitude(20)), -30, 1e-9);
  near(yawBetween(MOUNT, MOUNT), 0, 1e-9);
  near(yawBetween(attitude(0), attitude(180)), 180, 1e-9);
  // A phone lying flat gives the same answer as one in the holder.
  near(yawBetween(rotation(UP, -90), rotation(UP, -60)), 30, 1e-9);
});

test('body roll in a corner does not count as turning', () => {
  const rolled = multiply(rotation([0, 1, 0], 4), attitude(90));
  near(yawBetween(attitude(90), rolled), 0, 0.2);
});

// --- When the heading is taken from GPS ------------------------------------------------

test('nothing is claimed before the car has driven straight', () => {
  const estimator = drive(instant(), () => ({ heading: 45, course: 45, speed: 0 }), { to: 5 });
  const state = estimator.at(5000);
  assert.equal(state.calibrated, false);
  assert.equal(state.heading, null);
  assert.equal(state.driftAngle, null);
  assert.equal(state.course, null);
  near(state.yawRate, 0, 1e-6);
});

test('driving straight sets the heading from GPS', () => {
  const estimator = drive(instant(), () => ({ heading: 45, course: 45, speed: 10 }), { to: 3 });
  const state = estimator.at(3000);
  assert.equal(state.calibrated, true);
  assert.equal(state.corrected, true);
  near(state.heading, 45, 0.01, 'heading');
  near(state.driftAngle, 0, 0.01, 'drift angle');
});

test('a slide shows as the angle between body and travel, with its side', () => {
  // Straight north-east, then the tail steps out to the left: the nose points 30 degrees right of travel.
  const car = (t) => (t < 4 ? { heading: 45, course: 45, speed: 12 } : { heading: 75, course: 45, speed: 12 });
  const estimator = drive(instant(), car, { to: 8 });
  near(estimator.at(8000).driftAngle, 30, 0.5);
  assert.equal(estimator.at(8000).corrected, false);
  const mirrored = (t) => (t < 4 ? { heading: 45, course: 45, speed: 12 } : { heading: 15, course: 45, speed: 12 });
  near(drive(instant(), mirrored, { to: 8 }).at(8000).driftAngle, -30, 0.5);
});

test('a slide in a straight line does not pull the heading back to the course', () => {
  // No wheel speed to tell: the body just sits 30 degrees off a steady course for five seconds.
  const car = (t) => (t < 4 ? { heading: 45, course: 45, speed: 12 } : { heading: 75, course: 45, speed: 12 });
  near(drive(instant(), car, { to: 9 }).at(9000).driftAngle, 30, 0.5);
});

test('a heading that was set during a slide is put right by a long straight', () => {
  // The first two quiet seconds were a slide, so the heading starts 30 degrees wrong.
  const car = (t) => (t < 3 ? { heading: 75, course: 45, speed: 12 } : { heading: 45, course: 45, speed: 12 });
  const estimator = drive(instant(), car, { to: 3 });
  // The car now points 45 degrees and the estimator says 15.
  near(estimator.at(3000).heading, 15, 0.5, 'heading right after the slide');
  drive(estimator, car, { from: 3, to: 30 });
  near(estimator.at(30000).heading, 45, 1, 'heading after the straight');
  near(estimator.at(30000).driftAngle, 0, 1, 'drift angle after the straight');
});

test('a long slide in a straight line is not taken for driving straight when the wheels spin', () => {
  // Body 25 degrees off a steady course, no turning at all: only the wheels give it away.
  const car = (t) => (t < 4 ? { heading: 0, course: 0, speed: 15, wheelSpeed: 15.3 } : { heading: 25, course: 0, speed: 15, wheelSpeed: 21 });
  near(drive(instant(), car, { to: 12 }).at(12000).driftAngle, 25, 0.5);
});

test('walking pace does not calibrate: the GPS course is too noisy there', () => {
  const estimator = drive(instant(), () => ({ heading: 200, course: 200, speed: 3 }), { to: 6 });
  assert.equal(estimator.calibrated, false);
  // The course itself is still known.
  near(estimator.at(6000).course, 200, 0.01);
});

test('a steady corner does not calibrate', () => {
  // 10 degrees a second with the body 20 degrees inside the path.
  const car = (t) => ({ heading: 10 * t + 20, course: 10 * t, speed: 12 });
  assert.equal(drive(instant(), car, { to: 10 }).calibrated, false);
});

test('the quiet instant of a transition does not calibrate', () => {
  // Calibrated on a straight, then the car swings from one side to the other and back.
  const car = (t) => {
    if (t < 4) return { heading: 90, course: 90, speed: 14 };
    return { heading: 90 + 35 * Math.sin((t - 4) * 1.6), course: 90, speed: 14 };
  };
  const estimator = drive(instant(), car, { to: 14 });
  near(estimator.at(14000).driftAngle, 35 * Math.sin(10 * 1.6), 1.5);
});

test('gyroscope creep is taken out again on every straight', () => {
  // The attitude creeps by 0.2 degrees a second; the car drives straight the whole time.
  const car = () => ({ heading: 300, course: 300, speed: 20 });
  const estimator = drive(instant(), car, { to: 120, gyroDrift: 0.2 });
  // Without correction the heading would be off by 24 degrees by now.
  near(estimator.at(120000).heading, 300, 1.5, 'heading');
  near(estimator.at(120000).driftAngle, 0, 1.5, 'drift angle');
});

test('a fix without a course leaves the angle unknown instead of stale', () => {
  const estimator = drive(instant(), () => ({ heading: 45, course: 45, speed: 10 }), { to: 3 });
  estimator.fix(4000, { course: NaN, speed: 0 });
  const state = estimator.at(4100);
  assert.equal(state.course, null);
  assert.equal(state.driftAngle, null);
  // The heading is still known: it comes from the phone, not from GPS.
  near(state.heading, 45, 0.01);
});

test('an old fix is not used', () => {
  const estimator = drive(instant(), () => ({ heading: 45, course: 45, speed: 10 }), { to: 3 });
  assert.equal(estimator.at(3000 + 3500).course, null);
});

// --- Between the fixes -----------------------------------------------------------------

test('without an accelerometer a steady donut still reads right between fixes', () => {
  // 60 degrees a second to the right, body 40 degrees inside the circle.
  const circle = (t) => (t < 4 ? { heading: 0, course: 0, speed: 8 } : { heading: 60 * (t - 4) + 40, course: 60 * (t - 4), speed: 8 });
  const estimator = drive(instant(), circle, { to: 10.5 });
  // Half a second after the last fix the course has moved 30 degrees on.
  near(estimator.at(10500).course, 60 * 6.5, 1, 'course');
  near(estimator.at(10500).driftAngle, 40, 1.5, 'drift angle');
  near(estimator.at(10500).yawRate, 60, 1, 'rate of turn');
  assert.equal(estimator.at(10500).aided, false);
});

test('with the accelerometer the angle is right between the fixes as well', (t) => {
  // The phone sits at an odd angle and its own north is 137 degrees off: neither may matter.
  const { estimator, worst, mean, aidedShare } = angleErrors(demoDrive, { to: 60, frame: 137, gpsDelay: 300 });
  t.diagnostic(`worst ${worst.toFixed(2)} degrees, mean ${mean.toFixed(2)} degrees`);
  assert.ok(worst < 4, `worst error ${worst.toFixed(1)} degrees`);
  assert.ok(mean < 1, `mean error ${mean.toFixed(2)} degrees`);
  assert.equal(aidedShare, 1);
  assert.equal(estimator.at(60000).gpsDelay, 300);
});

test('how late the fixes arrive is found from the data', () => {
  for (const gpsDelay of [0, 300, 800]) {
    const { estimator, worst } = angleErrors(demoDrive, { to: 60, frame: -50, gpsDelay });
    assert.equal(estimator.at(60000).gpsDelay, gpsDelay);
    assert.ok(worst < 4, `worst error ${worst.toFixed(1)} degrees with fixes ${gpsDelay} ms late`);
  }
});

test('speed and position are carried on between the fixes', () => {
  let worstSpeed = 0;
  let worstPlace = 0;
  ride(new DriftEstimator(), demoDrive, {
    to: 40,
    frame: 20,
    each: (t, shown, truth) => {
      if (t < 14) return;
      worstSpeed = Math.max(worstSpeed, Math.abs(shown.speed - truth.speed));
      const off = metersBetween(offsetBy(DEMO_START, truth.east, truth.north), shown.position);
      worstPlace = Math.max(worstPlace, Math.hypot(off.east, off.north));
    },
  });
  assert.ok(worstSpeed < 0.3, `speed off by ${worstSpeed.toFixed(2)} m/s`);
  assert.ok(worstPlace < 0.5, `place off by ${worstPlace.toFixed(2)} m`);
});

test('the driven line gets points between the fixes that follow the corner', () => {
  const estimator = ride(new DriftEstimator(), demoDrive, { to: 40, frame: 20 });
  const line = estimator.path;
  // Five points a second once the accelerometer is lined up, one a second before.
  assert.ok(line.length > 150, `${line.length} points`);
  const start = offsetBy(DEMO_START, 0, 0);
  let worst = 0;
  for (const [latitude, longitude] of line.slice(-100)) {
    const point = metersBetween(start, { latitude, longitude });
    let nearest = Infinity;
    for (let t = 15; t <= 40; t += 0.02) {
      const car = demoDrive(t);
      nearest = Math.min(nearest, Math.hypot(car.east - point.east, car.north - point.north));
    }
    worst = Math.max(worst, nearest);
  }
  // Straight lines between fixes a second apart would cut the corners by more than a metre.
  assert.ok(worst < 0.4, `a point is ${worst.toFixed(2)} m off the driven line`);
});

test('noisy sensors still give a usable angle', (t) => {
  const noise = { acceleration: 0.5, course: 2, speed: 0.2, position: 0.5 };
  const { worst, mean, aidedShare } = angleErrors(demoDrive, { to: 90, frame: 137, noise });
  t.diagnostic(`worst ${worst.toFixed(1)} degrees, mean ${mean.toFixed(1)} degrees, accelerometer used ${Math.round(aidedShare * 100)}% of the time`);
  assert.ok(mean < 4, `mean error ${mean.toFixed(1)} degrees`);
  assert.ok(worst < 20, `worst error ${worst.toFixed(1)} degrees`);
  assert.ok(aidedShare > 0.95, `accelerometer used ${Math.round(aidedShare * 100)}% of the time`);
});

test('without an accelerometer the angle between fixes is a guess that stays within reason', (t) => {
  const { worst, mean, aidedShare } = angleErrors(demoDrive, { to: 60, accelerometer: false, gpsDelay: 250 });
  t.diagnostic(`worst ${worst.toFixed(1)} degrees, mean ${mean.toFixed(1)} degrees`);
  assert.equal(aidedShare, 0);
  assert.ok(mean < 5, `mean error ${mean.toFixed(1)} degrees`);
  assert.ok(worst < 25, `worst error ${worst.toFixed(1)} degrees`);
});

test('nothing is carried across a pause of the sensors', () => {
  // The page was in the background for two seconds.
  const seen = [];
  ride(new DriftEstimator(), demoDrive, {
    to: 40,
    pause: [20.1, 22.1],
    each: (t, shown, truth) => {
      if (t > 22.1 && t < 30) seen.push({ t, aided: shown.aided, error: shown.driftAngle === null ? null : Math.abs(wrap180(shown.driftAngle - truth.slip)) });
    },
  });
  // Right after the pause the sums are fresh, so the fix from before it cannot be carried on.
  assert.equal(seen[0].aided, false);
  // Two fixes later the accelerometer is in use again and the angle is right.
  const later = seen.filter(({ t }) => t > 25);
  assert.ok(later.every(({ aided }) => aided));
  assert.ok(later.every(({ error }) => error !== null && error < 5), `worst ${Math.max(...later.map(({ error }) => error)).toFixed(1)}`);
  assert.ok(seen.every(({ error }) => error === null || Number.isFinite(error)));
});

test('the recorded stream names every value it writes', () => {
  assert.equal(DRIFT_STREAM.name, 'drift');
  assert.equal(DRIFT_STREAM.columns.length, DRIFT_STREAM.digits.length);
  assert.deepEqual(DRIFT_STREAM.columns.slice(0, 3), ['heading_deg', 'course_deg', 'drift_angle_deg']);
});

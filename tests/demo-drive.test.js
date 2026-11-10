// The demo drive must look like driving to the drift estimator: a straight
// that sets the heading, then slides it can measure.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMO_START, demoDrive, demoPhone } from '../src/demo-drive.js';
import { DriftEstimator, wrap180 } from '../src/drift.js';
import { offsetBy } from '../src/geo.js';

test('the drive starts with a straight at a steady speed', () => {
  const start = demoDrive(0);
  const later = demoDrive(5);
  assert.equal(start.slip, 0);
  assert.ok(Math.abs(start.heading - start.course) < 1e-6);
  assert.ok(Math.abs(wrap180(later.course - start.course)) < 0.01);
  assert.ok(Math.abs(later.speed - start.speed) < 0.01);
  assert.ok(start.speed > 10 && start.speed < 20, `speed ${start.speed}`);
});

test('the run-in meets the eight without a jump', () => {
  const before = demoDrive(5.99);
  const after = demoDrive(6.01);
  assert.ok(Math.hypot(after.north - before.north, after.east - before.east) < 0.5);
  assert.ok(Math.abs(wrap180(after.course - before.course)) < 2);
  assert.ok(Math.abs(after.speed - before.speed) < 0.3);
});

test('the eight stays within its size and comes back to the crossing', () => {
  const lap = (2 * Math.PI) / 0.35;
  for (let t = 6; t < 6 + lap; t += 0.25) {
    const car = demoDrive(t);
    assert.ok(Math.abs(car.north) <= 15.01 && Math.abs(car.east) <= 30.01, `outside at ${t}`);
    assert.ok(car.speed > 5 && car.speed < 20, `speed ${car.speed} at ${t}`);
  }
  const home = demoDrive(6 + lap);
  assert.ok(Math.hypot(home.north, home.east) < 0.01);
});

test('the car slides to both sides, nose into the turn', () => {
  const slips = [];
  for (let t = 6; t < 30; t += 0.1) slips.push(demoDrive(t).slip);
  assert.ok(Math.max(...slips) > 25 && Math.min(...slips) < -25);
  assert.ok(slips.every((slip) => Math.abs(slip) <= 38));
});

test('the phone in the demo car measures what its motion implies', () => {
  // Heading east and speeding up: the acceleration points out of the top of the phone.
  const phone = demoPhone({ heading: 90, accelEast: 3, accelNorth: 0 });
  assert.ok(Math.abs(phone.acceleration[0]) < 1e-9 && Math.abs(phone.acceleration[1] - 3) < 1e-9);
  // Heading north and turning right: the acceleration points to the right edge.
  const turning = demoPhone({ heading: 0, accelEast: 5, accelNorth: 0 });
  assert.ok(Math.abs(turning.acceleration[0] - 5) < 1e-9 && Math.abs(turning.acceleration[1]) < 1e-9);
  // Pointing north the phone is in its reference attitude; pointing south it is turned half way round.
  const [, , z, w] = demoPhone({ heading: 0, accelEast: 0, accelNorth: 0 }).attitude;
  assert.ok(Math.abs(z) < 1e-12 && w === 1);
  const south = demoPhone({ heading: 180, accelEast: 0, accelNorth: 0 }).attitude;
  assert.ok(Math.abs(Math.abs(south[2]) - 1) < 1e-12 && Math.abs(south[3]) < 1e-12);
});

test('the estimator follows the demo drive fed the way the app feeds it', () => {
  const estimator = new DriftEstimator();
  let worst = 0;
  let fixes = 0;
  for (let step = 0; step <= 60 * 60; step += 1) {
    const t = step / 60;
    const car = demoDrive(t);
    const phone = demoPhone(car);
    estimator.attitude(t * 1000, phone.attitude);
    estimator.acceleration(t * 1000, phone.acceleration);
    if (t >= fixes) {
      fixes += 1;
      // A fix once a second that describes the car of 300 ms ago.
      const then = demoDrive(t - 0.3);
      estimator.fix(t * 1000, { ...offsetBy(DEMO_START, then.east, then.north), accuracy: 3, course: then.course, speed: then.speed });
    }
    if (t > 14) {
      const shown = estimator.at(t * 1000);
      assert.notEqual(shown.driftAngle, null, `no angle at ${t}`);
      assert.equal(shown.aided, true, `no accelerometer at ${t}`);
      worst = Math.max(worst, Math.abs(wrap180(shown.driftAngle - car.slip)));
    }
  }
  assert.equal(estimator.calibrated, true);
  assert.equal(estimator.at(60000).gpsDelay, 300);
  assert.ok(worst < 2, `worst error ${worst.toFixed(1)} degrees`);
});

test('the demo starts at a real place in Poland, where the pictures from the air reach', () => {
  // The bounds of Moto Park Ułęż as OpenStreetMap gives them.
  assert.ok(DEMO_START.latitude > 51.6130 && DEMO_START.latitude < 51.6269);
  assert.ok(DEMO_START.longitude > 22.0837 && DEMO_START.longitude < 22.1102);
});

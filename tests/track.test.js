// The smoothed line through the GPS fixes, checked on made-up drives where
// the true path is known.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { metersBetween, offsetBy } from '../src/geo.js';
import { MAX_GAP_MS, SmoothTrack, curve } from '../src/track.js';

const START = { latitude: 51.61758, longitude: 22.0999 };
const T0 = 1_794_340_000_000;
const RADIANS = Math.PI / 180;

/** A car going round a circle of `radius` m at `speed` m/s, counter-clockwise, one fix a second. */
function circle({ radius, speed, seconds = 20, noise = () => 0 }) {
  const fixes = [];
  const truth = (t) => {
    const angle = (speed * t) / radius;
    return {
      east: radius * Math.cos(angle),
      north: radius * Math.sin(angle),
      // The velocity of a point going counter-clockwise: course measured clockwise from north.
      course: ((Math.atan2(-Math.sin(angle), Math.cos(angle)) / RADIANS) % 360 + 360) % 360,
    };
  };
  for (let t = 0; t <= seconds; t += 1) {
    const at = truth(t);
    const place = offsetBy(START, at.east + noise(), at.north + noise());
    fixes.push({ time: T0 + t * 1000, ...place, speed, course: at.course });
  }
  return { fixes, truth };
}

const distanceFromCircle = (place, radius) => {
  const { east, north } = metersBetween(START, place);
  return Math.abs(Math.hypot(east, north) - radius);
};

test('round a tight corner the smoothed line keeps to the circle, where straight lines between fixes cut it', () => {
  // 10 m radius at 36 km/h: a quarter turn every 1.6 s, the kind of corner a drift is made of.
  const { fixes } = circle({ radius: 10, speed: 10 });
  const track = new SmoothTrack(fixes);
  let worst = 0;
  for (let ms = 0; ms <= 20000; ms += 50) worst = Math.max(worst, distanceFromCircle(track.at(T0 + ms), 10));
  assert.ok(worst < 0.25, `smoothed line ${worst.toFixed(2)} m off`);
  // Half way between two fixes a straight line is more than a metre inside the circle.
  const middle = offsetBy(START, ...Object.values((() => {
    const a = metersBetween(START, fixes[3]);
    const b = metersBetween(START, fixes[4]);
    return { east: (a.east + b.east) / 2, north: (a.north + b.north) / 2 };
  })()));
  assert.ok(distanceFromCircle(middle, 10) > 1, 'a straight line cuts the corner');
});

test('the line passes through every fix, and its direction there is the course GPS gave', () => {
  const { fixes } = circle({ radius: 30, speed: 12 });
  const track = new SmoothTrack(fixes);
  for (const fix of fixes.slice(0, -1)) {
    const at = track.at(fix.time);
    const off = metersBetween(fix, at);
    assert.ok(Math.hypot(off.east, off.north) < 1e-6);
    assert.ok(Math.abs(((at.course - fix.course + 540) % 360) - 180) < 0.01, `${at.course} against ${fix.course}`);
    assert.ok(Math.abs(at.speed - 12) < 0.01);
  }
});

test('the line drawn has points about every two metres and ends on the fixes', () => {
  const { fixes } = circle({ radius: 30, speed: 12, seconds: 10 });
  const points = new SmoothTrack(fixes).points();
  // Twelve metres between fixes: six steps each.
  assert.equal(points.length, 10 * 6 + 1);
  assert.deepEqual(points[0], [fixes[0].latitude, fixes[0].longitude, T0]);
  assert.deepEqual(points.at(-1).slice(0, 2), [fixes.at(-1).latitude, fixes.at(-1).longitude]);
  assert.ok(points.every(([, , time], index) => index === 0 || time > points[index - 1][2]));
  // A long recording is thinned to the limit.
  const long = new SmoothTrack(circle({ radius: 30, speed: 12, seconds: 600 }).fixes).points(1000);
  assert.ok(long.length <= 1000, `${long.length} points`);
  assert.ok(long.length > 600);
});

test('standing still, noisy positions give no loops and no wandering', () => {
  // A car parked for twenty seconds, GPS wandering two metres either way, speed zero.
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 4;
  };
  const fixes = [];
  for (let t = 0; t <= 20; t += 1) fixes.push({ time: T0 + t * 1000, ...offsetBy(START, noise(), noise()), speed: 0, course: null });
  const track = new SmoothTrack(fixes);
  for (let ms = 0; ms <= 20000; ms += 100) {
    const off = metersBetween(START, track.at(T0 + ms));
    assert.ok(Math.hypot(off.east, off.north) < 3, `${ms} ms`);
  }
});

test('without a course from GPS the direction is taken from the neighbouring fixes', () => {
  // Crawling north at one metre a second: GPS gives no course below walking pace.
  const fixes = [0, 1, 2, 3, 4].map((t) => ({ time: T0 + t * 1000, ...offsetBy(START, 0, t), speed: 1, course: null }));
  const track = new SmoothTrack(fixes);
  const middle = track.at(T0 + 2500);
  assert.ok(Math.abs(metersBetween(START, middle).north - 2.5) < 0.01);
  assert.ok(Math.abs(metersBetween(START, middle).east) < 1e-6);
  assert.ok(middle.course < 0.5 || middle.course > 359.5, `course ${middle.course}`);
});

test('a course that disagrees with the positions does not make the line loop back', () => {
  // A fix that was thrown backwards by a few metres while GPS still says the car goes north.
  const fixes = [
    { time: T0, ...offsetBy(START, 0, 0), speed: 10, course: 0 },
    { time: T0 + 1000, ...offsetBy(START, 0, -3), speed: 10, course: 0 },
    { time: T0 + 2000, ...offsetBy(START, 0, 20), speed: 10, course: 0 },
  ];
  const track = new SmoothTrack(fixes);
  let lowest = 0;
  for (let ms = 0; ms <= 1000; ms += 20) lowest = Math.min(lowest, metersBetween(START, track.at(T0 + ms)).north);
  assert.ok(lowest > -3.01, `${lowest.toFixed(2)} m`);
});

test('fixes further apart than a gap are not joined, and the last one is held only for a while', () => {
  const fixes = [
    { time: T0, ...offsetBy(START, 0, 0), speed: 10, course: 90 },
    { time: T0 + 1000, ...offsetBy(START, 10, 0), speed: 10, course: 90 },
    { time: T0 + 1000 + MAX_GAP_MS + 5000, ...offsetBy(START, 500, 0), speed: 10, course: 90 },
    { time: T0 + 2000 + MAX_GAP_MS + 5000, ...offsetBy(START, 510, 0), speed: 10, course: 90 },
  ];
  const track = new SmoothTrack(fixes);
  assert.ok(Math.abs(metersBetween(START, track.at(T0 + 2000)).east - 10) < 1e-6, 'held');
  assert.equal(track.at(T0 + 1000 + MAX_GAP_MS + 1), null);
  assert.ok(track.at(T0 + 1500 + MAX_GAP_MS + 5000) !== null);
  assert.equal(track.at(T0 - 1), null);
  // The drawn line jumps the gap in one step.
  assert.equal(track.points().filter(([, , time]) => time > T0 + 1000 && time < T0 + 1000 + MAX_GAP_MS + 5000).length, 0);
});

test('fixes without a position are left out, and nothing gives an empty track', () => {
  const track = new SmoothTrack([{ time: T0, latitude: NaN, longitude: 22, speed: 1, course: 0 }]);
  assert.equal(track.empty, true);
  assert.equal(track.at(T0), null);
  assert.deepEqual(track.points(), []);
  assert.equal(new SmoothTrack([]).start, null);
});

test('the curve between two places starts and ends with the velocities it is given', () => {
  const join = curve({ east: 10, north: 0 }, { east: 0, north: 10 }, { east: 10, north: 0 }, 1);
  const start = join(0);
  const end = join(1);
  assert.deepEqual([start.east, start.north, start.ve, start.vn], [0, 0, 0, 10]);
  assert.deepEqual([end.east, end.north, end.ve, end.vn], [10, 0, 10, 0]);
  // Without velocities it is the straight way, at an even pace.
  const plain = curve({ east: 4, north: 2 }, null, null, 2)(0.5);
  assert.deepEqual([plain.east, plain.north, plain.ve, plain.vn], [2, 1, 2, 1]);
});

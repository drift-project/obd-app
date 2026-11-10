// A made-up drive for the Demo button, so the drift view can be seen without
// a car: a straight run-in and then a figure of eight, taken sideways.

const RADIANS = Math.PI / 180;

// The old runway of Tempelhof in Berlin: a wide stretch of tarmac that is a public park now.
export const DEMO_START = { latitude: 52.4737, longitude: 13.4017 };

const SIZE_M = 30; // half the length of the eight
const PACE = 0.35; // radians of the eight per second
const RUN_IN_S = 6; // the straight before it, long enough to set the heading
const MAX_SLIP_DEG = 38;
const SLIP_PER_TURN = 1.1; // degrees of slip for each deg/s of turning

/** Metres north and east of the start at `t` seconds. */
function place(t) {
  const s = PACE * (t - RUN_IN_S);
  if (s < 0) {
    // The run-in arrives at the crossing of the eight in the direction and at the speed the eight starts with.
    const along = SIZE_M * PACE * (t - RUN_IN_S);
    return { north: along, east: along };
  }
  return { north: SIZE_M * Math.sin(s) * Math.cos(s), east: SIZE_M * Math.sin(s) };
}

function motion(t) {
  const step = 0.005;
  const before = place(t - step);
  const after = place(t + step);
  const north = (after.north - before.north) / (2 * step);
  const east = (after.east - before.east) / (2 * step);
  return { speed: Math.hypot(north, east), course: (Math.atan2(east, north) / RADIANS + 360) % 360 };
}

const turn = (from, to) => ((to - from + 540) % 360) - 180;

/**
 * The car at `t` seconds: metres north and east of the start, speed in m/s,
 * course and heading in degrees clockwise from north and the acceleration
 * over ground in m/s². In the corners the nose points into the turn, as in a
 * drift.
 */
export function demoDrive(t) {
  const { north, east } = place(t);
  const { speed, course } = motion(t);
  const rate = turn(motion(t - 0.1).course, motion(t + 0.1).course) / 0.2;
  const slip = Math.max(-MAX_SLIP_DEG, Math.min(MAX_SLIP_DEG, SLIP_PER_TURN * rate));
  const step = 0.02;
  const before = place(t - step);
  const after = place(t + step);
  return {
    north,
    east,
    speed,
    course,
    heading: (course + slip + 360) % 360,
    slip,
    accelNorth: (after.north - 2 * north + before.north) / step ** 2,
    accelEast: (after.east - 2 * east + before.east) / step ** 2,
  };
}

/**
 * What a phone lying flat in that car, its top towards the nose, measures:
 * its attitude as a quaternion [x, y, z, w] and the acceleration without
 * gravity in its own coordinates.
 */
export function demoPhone(car) {
  const turn = -car.heading * RADIANS; // counter-clockwise from north
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return {
    attitude: [0, 0, Math.sin(turn / 2), Math.cos(turn / 2)],
    acceleration: [cos * car.accelEast + sin * car.accelNorth, -sin * car.accelEast + cos * car.accelNorth, 0],
  };
}

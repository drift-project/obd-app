// Drift angle from a phone: where the car points against where it moves.
//
// The direction the body points (heading) comes from the attitude of the
// phone: its rotation about the vertical axis is the rotation of the car,
// however the phone is mounted. The phone knows only how far it has turned,
// not where north is, so the heading needs a starting value. It is taken from
// GPS whenever the car drives straight, because then heading and course are
// the same, and it keeps being corrected that way, which also removes the
// slow creep of the gyroscope.
//
// The direction of travel (course) comes from GPS, but only once a second,
// and in a drift it changes a lot within a second. Between two fixes the
// velocity is therefore carried on with the accelerometer. For that the
// accelerations have to be turned into the north and east of the map and
// lined up in time with the fixes, which arrive late. Both the angle and the
// delay are found from the data itself: they are the ones for which the
// change of GPS velocity from fix to fix matches what the accelerometer saw.
// Until the car has changed its speed or direction enough for that, the
// course between fixes is a plain guess.
//
// The drift angle is heading minus course in the range -180 to 180 degrees,
// the same definition as in middle-math: positive when the nose points to the
// right of the direction of travel.

import { metersBetween, offsetBy } from './geo.js';
import { curve } from './track.js';

export const wrap360 = (degrees) => ((degrees % 360) + 360) % 360;
export const wrap180 = (degrees) => wrap360(degrees + 180) - 180;

const DEGREES = 180 / Math.PI;

/**
 * Rotation about the vertical axis that takes attitude `from` to attitude
 * `to`, in degrees, counter-clockwise seen from above. Both are unit
 * quaternions [x, y, z, w] of the Generic Sensor API, which turn phone
 * coordinates into world coordinates with z pointing up.
 */
export function yawBetween(from, to) {
  // z and w of `to` times the inverse of `from`: the turn between them in world coordinates.
  const z = -to[3] * from[2] - to[0] * from[1] + to[1] * from[0] + to[2] * from[3];
  const w = to[3] * from[3] + to[0] * from[0] + to[1] * from[1] + to[2] * from[2];
  return wrap180(2 * Math.atan2(z, w) * DEGREES);
}

/** The two horizontal world coordinates of a vector given in phone coordinates. */
function horizontal(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz)];
}

/**
 * Which attitude stream the heading is taken from. `current` is the stream in
 * use (null before the first sample) and `name` the stream a sample has just
 * come from. Returns the stream to use from now on, or null when the sample
 * is to be left out.
 *
 * The attitude without the compass wins as soon as it delivers: in a car the
 * compass is bent by the steel around it and by currents, and on a real drive
 * the heading taken from it wandered by tens of degrees. The attitude with
 * the compass serves until then, and on a phone that has no other.
 */
export function pickAttitude(current, name) {
  if (name === 'relative_orientation') return name;
  if (name === 'orientation' && current !== 'relative_orientation') return name;
  return null;
}

/** Columns of the recorded `drift` stream, after the timestamp. */
export const DRIFT_STREAM = {
  name: 'drift',
  columns: [
    'heading_deg',
    'course_deg',
    'drift_angle_deg',
    'yaw_rate_dps',
    'speed_ms',
    'latitude_deg',
    'longitude_deg',
    'offset_deg',
    'calibrated',
    'corrected',
    'aided',
    'gps_delay_ms',
  ],
  digits: [1, 1, 1, 1, 2, 7, 7, 1, 0, 0, 0, 0],
  about:
    'what the drift view showed: heading of the car, course over ground and their difference, the rate of turn ' +
    '(positive to the right), speed and position carried on between fixes, the heading correction taken from GPS, ' +
    'whether the heading was set at all, whether the newest fix corrected it (the car was driving straight), ' +
    'whether the accelerometer was used between fixes and the delay of the GPS fixes it was lined up with',
};

const HISTORY_MS = 5000;
const FIX_MAX_AGE_MS = 3000;
const GUESS_MS = 1500; // how far a plain guess of the course is carried
const GAP_MS = 300; // a longer pause in the sensors breaks the sums
// A gyroscope creeps by a fraction of a degree a second. A correction larger
// than this allowance, soon after the last one, is not creep: it is the car
// sliding in a straight line. Only a straight longer than any slide overrules.
const CREEP_DEG = 3;
const CREEP_DEG_PER_S = 0.3;
const LONG_STRAIGHT_FIXES = 6;
// Delays of a GPS fix that are tried, in ms, and how the evidence is weighed.
const DELAYS_MS = Array.from({ length: 16 }, (_, index) => index * 100);
const FORGET = 0.92; // older fixes count less, so a creeping gyroscope is followed
const MIN_CHANGE = 0.7; // a change of velocity below this, in m/s, says nothing
const MIN_EVIDENCE = 6; // summed squares of velocity changes, (m/s)^2
const MIN_MATCH = 0.75; // 1 means the accelerometer explains GPS exactly
const PATH_STEPS = 5; // points added to the line per fix
const PATH_LIMIT = 4000;
// A phone that is picked up or shifted in its holder no longer turns with the car, and the heading taken
// from it is worth nothing until it is set again. Being handled shows as tipping: rotation about
// horizontal axes, which a car barely does. On real drives the gyroscope showed up to about 14 degrees of
// it while drifting and over bumps, and 25 to 120 degrees whenever the phone was in a hand.
const TIP_LIMIT_DEG = 20;
const TIP_MEMORY_S = 5; // tipping is summed over about this long
// Where up is in the phone's own coordinates is learned from the accelerometer, but only while the phone is
// at rest or moving steadily: it reads gravity alone when it reads 9.81 m/s2 and nothing turns.
const GRAVITY = 9.81;
const AT_REST_MS2 = 0.4;
const AT_REST_RADS = 0.06;
const UP_SETTLE_S = 3;
// Gravity is taken out of the accelerometer here, not by Android. Android follows a sustained acceleration
// with its estimate of gravity, as if the phone had tipped, and on the first real drives its acceleration
// without gravity showed only 20 to 70% of the changes of velocity GPS measured. Gravity as the phone sits
// in its holder is learned only while GPS shows the car standing or going steadily straight on, and it
// explained those changes to 81 to 96%.
const STEADY_MS = 1500; // how long a fix that shows steady driving counts
const STEADY_SPEED_MS = 0.4; // change of speed between fixes, m/s
const STEADY_TURN = 3; // deg/s

export class DriftEstimator {
  #last = null; // newest attitude quaternion
  #yaw = 0; // degrees turned since the first attitude, counter-clockwise, not wrapped
  #turns = []; // [time, yaw] of the last seconds
  #sums = []; // [time, vx, vy, px, py]: summed acceleration and its sum, in the frame of the attitude
  #offset = 0; // heading = offset - yaw
  #calibrated = false;
  #correctedAt = 0; // time of the last accepted correction
  #corrected = false; // the newest fix was used to correct the heading
  #straightFixes = 0;
  #fix = null; // newest fix
  #match = DELAYS_MS.map(() => ({ re: 0, im: 0, energy: 0 })); // evidence per tried delay
  #angle = 0; // turns the frame of the attitude into east and north, radians
  #delay; // ms a fix is older than its arrival
  #aided = false;
  #path = [];
  #up = null; // unit vector: where up is in the phone's coordinates while it sits in its holder
  #upAt = null; // time of the accelerometer sample that last went into it
  #spin = Infinity; // newest rate of turn from the gyroscope, rad/s, any axis
  #spinAt = null;
  #tip = [0, 0, 0]; // rotation about horizontal axes over the last seconds, radians, phone coordinates
  #moved = false; // the phone was handled and the heading has not been set again since
  #gravity = null; // what the accelerometer reads while the car goes steadily, phone coordinates, m/s2
  #steadyAt = -Infinity; // arrival of the newest fix that showed the car standing or going steadily
  #source = null; // where the summed acceleration comes from: 'own' (gravity taken out here) or 'android'

  /**
   * `minSpeed` (m/s): below it GPS course is too noisy to calibrate on.
   * `maxTurn` (deg/s): faster turning than this is not "straight".
   * `gain`: how much of each new observation goes into the correction.
   * `delay` (ms): how much older than its arrival a fix is taken to be until
   * the accelerometer has shown the real delay.
   */
  constructor({ minSpeed = 5, maxTurn = 4, gain = 0.25, delay = 250 } = {}) {
    this.minSpeed = minSpeed;
    this.maxTurn = maxTurn;
    this.gain = gain;
    this.#delay = delay;
  }

  /**
   * Acceleration with gravity at `time` (ms), in phone coordinates, m/s². It tells where up is in the
   * phone's coordinates, which is what the gyroscope is judged against.
   */
  accelerometer(time, vector) {
    if (!vector.every(Number.isFinite)) return;
    const size = Math.hypot(...vector);
    const seconds = this.#upAt === null ? 0 : (time - this.#upAt) / 1000;
    this.#upAt = time;
    this.#ownAcceleration(time, vector, seconds);
    if (Math.abs(size - GRAVITY) > AT_REST_MS2 || this.#spin > AT_REST_RADS) return;
    const unit = vector.map((value) => value / size);
    if (!this.#up) {
      this.#up = unit;
      return;
    }
    const share = Math.min(Math.max(seconds, 0) / UP_SETTLE_S, 1);
    const mixed = this.#up.map((value, axis) => value + (unit[axis] - value) * share);
    const length = Math.hypot(...mixed) || 1;
    this.#up = mixed.map((value) => value / length);
  }

  /** Learn gravity where GPS vouches that nothing accelerates, and sum the rest as the car's acceleration. */
  #ownAcceleration(time, vector, seconds) {
    const steady = time - this.#steadyAt <= STEADY_MS && this.#spin <= AT_REST_RADS;
    if (steady && Math.abs(Math.hypot(...vector) - (this.#gravity ? Math.hypot(...this.#gravity) : GRAVITY)) <= AT_REST_MS2) {
      const share = this.#gravity ? Math.min(Math.max(seconds, 0) / UP_SETTLE_S, 1) : 1;
      this.#gravity = this.#gravity ? this.#gravity.map((value, axis) => value + (vector[axis] - value) * share) : [...vector];
    }
    if (this.#gravity) this.#feed('own', time, vector.map((value, axis) => value - this.#gravity[axis]));
  }

  /**
   * Rate of turn at `time` (ms) from the gyroscope, in phone coordinates, rad/s. Turning about the
   * vertical is the car; tipping over is somebody's hand. After that the heading is unknown until the
   * car has driven straight again.
   */
  gyroscope(time, vector) {
    if (!vector.every(Number.isFinite)) return;
    const seconds = this.#spinAt === null ? 0 : Math.min(Math.max((time - this.#spinAt) / 1000, 0), 0.1);
    this.#spinAt = time;
    this.#spin = Math.hypot(...vector);
    const up = this.#up;
    if (!up) return;
    const about = vector[0] * up[0] + vector[1] * up[1] + vector[2] * up[2];
    const keep = Math.exp(-seconds / TIP_MEMORY_S);
    this.#tip = this.#tip.map((value, axis) => value * keep + (vector[axis] - about * up[axis]) * seconds);
    if (Math.hypot(...this.#tip) * DEGREES < TIP_LIMIT_DEG) return;
    // Handled. Where up is has to be learned again, and so has everything that hung on how the phone sat.
    this.#up = null;
    this.#gravity = null;
    this.#tip = [0, 0, 0];
    this.#moved = true;
    this.#calibrated = false;
    this.#corrected = false;
    this.#straightFixes = 0;
    this.#sums.length = 0;
    this.#match = DELAYS_MS.map(() => ({ re: 0, im: 0, energy: 0 }));
    this.#aided = false;
    if (this.#fix) this.#fix.slip = null;
  }

  get calibrated() {
    return this.#calibrated;
  }

  /**
   * The driven line as [latitude, longitude, drift angle], with points between the fixes where the
   * accelerometer gave them. The angle is in degrees, or null where it was not known.
   */
  get path() {
    return this.#path;
  }

  /**
   * Attitude of the phone at `time` (ms): unit quaternion [x, y, z, w].
   * `restart` says that it comes from another sensor than the sample before.
   * The two sensors do not agree on where zero is, so the step between them
   * is not a turn of the car, and what was summed in the frame of the old
   * one cannot be carried into the new.
   */
  attitude(time, quaternion, restart = false) {
    if (!quaternion.every(Number.isFinite)) return;
    if (restart) {
      this.#sums.length = 0;
      this.#match = DELAYS_MS.map(() => ({ re: 0, im: 0, energy: 0 }));
      this.#aided = false;
    } else if (this.#last) {
      this.#yaw += yawBetween(this.#last, quaternion);
    }
    this.#last = quaternion;
    this.#turns.push([time, this.#yaw]);
    while (this.#turns.length > 2 && this.#turns[0][0] < time - HISTORY_MS) this.#turns.shift();
  }

  /**
   * Acceleration without gravity at `time` (ms) as Android works it out, in phone coordinates, m/s². It is
   * used only until gravity has been learned here from the accelerometer.
   */
  acceleration(time, vector) {
    if (vector.every(Number.isFinite)) this.#feed('android', time, vector);
  }

  /** Sum the acceleration of the car, from the source that is the better one at the moment. */
  #feed(source, time, vector) {
    if (!this.#last) return;
    if (source !== (this.#gravity ? 'own' : 'android')) return;
    if (this.#source !== source) {
      // The two sources do not read alike, so what was summed and learned from one is not carried over.
      this.#source = source;
      this.#sums.length = 0;
      this.#match = DELAYS_MS.map(() => ({ re: 0, im: 0, energy: 0 }));
      this.#aided = false;
    }
    const [ax, ay] = horizontal(this.#last, vector);
    const sums = this.#sums;
    const previous = sums.at(-1);
    const seconds = previous ? (time - previous[0]) / 1000 : 0;
    if (!previous || seconds <= 0 || seconds * 1000 > GAP_MS) {
      // The first sample, or the sensors paused: the sums start again and fixes before this cannot be carried on.
      sums.length = 0;
      sums.push([time, 0, 0, 0, 0]);
      return;
    }
    const vx = previous[1] + ax * seconds;
    const vy = previous[2] + ay * seconds;
    sums.push([time, vx, vy, previous[3] + ((previous[1] + vx) / 2) * seconds, previous[4] + ((previous[2] + vy) / 2) * seconds]);
    while (sums.length > 2 && sums[0][0] < time - HISTORY_MS) sums.shift();
  }

  /** A row of `rows` ([time, ...values]) at `time`, between its neighbours; null outside the rows. */
  #between(rows, time, slack = 0) {
    if (!rows.length || time < rows[0][0] - slack || time > rows.at(-1)[0] + slack) return null;
    let low = 0;
    let high = rows.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (rows[middle][0] <= time) low = middle;
      else high = middle;
    }
    const before = rows[low];
    const after = rows[high];
    const share = after[0] > before[0] ? Math.min(Math.max((time - before[0]) / (after[0] - before[0]), 0), 1) : 0;
    return before.map((value, index) => value + (after[index] - value) * share);
  }

  #yawAt(time) {
    return this.#between(this.#turns, time, HISTORY_MS)?.[1] ?? null;
  }

  /** Rate of turn at `time` in deg/s, counter-clockwise, over the last `spanMs`. */
  #turnRate(time, spanMs = 500) {
    if (!this.#turns.length || this.#turns[0][0] > time - spanMs) return null;
    return ((this.#yawAt(time) - this.#yawAt(time - spanMs)) * 1000) / spanMs;
  }

  /**
   * Weigh, for every tried delay, how well the accelerometer explains the
   * change of GPS velocity since the fix before. The products are summed as
   * complex numbers: their direction is the angle between the two frames and
   * their length says how consistent the fixes were.
   */
  #learn(previous, fix) {
    const east = fix.east - previous.east;
    const north = fix.north - previous.north;
    for (let index = 0; index < DELAYS_MS.length; index += 1) {
      const now = this.#between(this.#sums, fix.arrived - DELAYS_MS[index]);
      const then = this.#between(this.#sums, previous.arrived - DELAYS_MS[index]);
      if (!now || !then) continue;
      const x = now[1] - then[1];
      const y = now[2] - then[2];
      if (Math.hypot(east, north) < MIN_CHANGE && Math.hypot(x, y) < MIN_CHANGE) continue;
      const match = this.#match[index];
      // (east + i north) times the conjugate of (x + i y)
      match.re = FORGET * match.re + east * x + north * y;
      match.im = FORGET * match.im + north * x - east * y;
      match.energy = FORGET * match.energy + (east * east + north * north + x * x + y * y) / 2;
    }
    let best = -1;
    let bestScore = 0;
    for (let index = 0; index < DELAYS_MS.length; index += 1) {
      const { re, im, energy } = this.#match[index];
      const score = energy >= MIN_EVIDENCE ? Math.hypot(re, im) / energy : 0;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    this.#aided = bestScore >= MIN_MATCH;
    if (this.#aided) {
      this.#angle = Math.atan2(this.#match[best].im, this.#match[best].re);
      this.#delay = DELAYS_MS[best];
    }
  }

  /**
   * Velocity and distance covered since `fix`, in metres east and north, by
   * its GPS velocity and the accelerations after it. Null when that cannot be
   * done: no accelerometer, a pause, or the frames are not lined up yet.
   */
  #carry(fix, time) {
    if (!this.#aided || fix.east === null) return null;
    const taken = fix.arrived - this.#delay;
    const start = this.#between(this.#sums, taken);
    const end = this.#between(this.#sums, time, 50);
    if (!start || !end) return null;
    const seconds = (time - taken) / 1000;
    if (seconds < 0 || seconds * 1000 > FIX_MAX_AGE_MS + this.#delay) return null;
    const cos = Math.cos(this.#angle);
    const sin = Math.sin(this.#angle);
    const vx = end[1] - start[1];
    const vy = end[2] - start[2];
    const px = end[3] - start[3] - start[1] * seconds;
    const py = end[4] - start[4] - start[2] * seconds;
    return {
      east: fix.east + cos * vx - sin * vy,
      north: fix.north + sin * vx + cos * vy,
      movedEast: fix.east * seconds + cos * px - sin * py,
      movedNorth: fix.north * seconds + sin * px + cos * py,
    };
  }

  /**
   * Add the stretch from the fix before to this one to the line, bent to end exactly on the new fix: as the
   * accelerometer saw it where it can tell, else along the curve that leaves and reaches the two fixes with
   * the velocities GPS gave.
   */
  #extendPath(previous, fix) {
    if (previous?.position) {
      const taken = previous.arrived - this.#delay;
      const span = fix.arrived - previous.arrived;
      const end = this.#carry(previous, taken + span);
      const slipAt = (share) => (previous.slip !== null && fix.slip !== null ? previous.slip + wrap180(fix.slip - previous.slip) * share : fix.slip);
      if (!end) {
        const velocity = (from) => (from.east === null ? null : { east: from.east, north: from.north });
        const join = curve(metersBetween(previous.position, fix.position), velocity(previous), velocity(fix), span / 1000);
        for (let step = 1; step < PATH_STEPS; step += 1) {
          const share = step / PATH_STEPS;
          const point = join(share);
          const place = offsetBy(previous.position, point.east, point.north);
          this.#path.push([place.latitude, place.longitude, slipAt(share)]);
        }
      } else {
        const real = metersBetween(previous.position, fix.position);
        for (let step = 1; step < PATH_STEPS; step += 1) {
          const share = step / PATH_STEPS;
          const point = this.#carry(previous, taken + share * span);
          if (!point) continue;
          // What the accelerometer was off by at the end is spread over the stretch.
          const east = point.movedEast + share * (real.east - end.movedEast);
          const north = point.movedNorth + share * (real.north - end.movedNorth);
          const place = offsetBy(previous.position, east, north);
          this.#path.push([place.latitude, place.longitude, slipAt(share)]);
        }
      }
    }
    this.#path.push([fix.position.latitude, fix.position.longitude, fix.slip]);
    if (this.#path.length > PATH_LIMIT) this.#path = this.#path.slice(-Math.round(PATH_LIMIT * 0.8));
  }

  /**
   * A position fix that arrived at `time` (ms, same clock as the sensors):
   * `course` in degrees clockwise from north, `speed` over ground in m/s,
   * the position and its accuracy in metres and, when known, `wheelSpeed`
   * of the car in m/s.
   */
  fix(time, { latitude = null, longitude = null, accuracy = null, course = null, speed = null, wheelSpeed = null } = {}) {
    this.#corrected = false;
    const previous = this.#fix;
    const known = Number.isFinite(speed);
    const moving = known && Number.isFinite(course) && speed >= 1.5;
    const standing = known && speed < 0.5;
    const fix = {
      arrived: time,
      course: moving ? course : null,
      speed: known ? speed : null,
      rate: 0, // deg/s the course turned since the fix before
      slip: null, // drift angle at this fix
      // Velocity over ground: known when the car moves and GPS says where to, and when it stands.
      east: moving ? speed * Math.sin(course / DEGREES) : standing ? 0 : null,
      north: moving ? speed * Math.cos(course / DEGREES) : standing ? 0 : null,
      position: Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null,
    };
    this.#fix = fix;
    const seconds = previous ? (time - previous.arrived) / 1000 : 0;
    const consecutive = previous !== null && seconds > 0.2 && seconds < 2.5;
    // Standing, or going on at the same speed in the same direction: then the accelerometer reads gravity alone.
    const evenly =
      consecutive &&
      moving &&
      previous.speed !== null &&
      previous.course !== null &&
      Math.abs(speed - previous.speed) / seconds <= STEADY_SPEED_MS &&
      Math.abs(wrap180(course - previous.course)) / seconds <= STEADY_TURN;
    if (standing || evenly) this.#steadyAt = time;
    if (consecutive && previous.east !== null && fix.east !== null) this.#learn(previous, fix);
    // A fix that is tens of metres off would only scribble on the map. The line is extended last,
    // once the drift angle at this fix is known: the line carries it.
    const extend = () => {
      if (fix.position && !(accuracy > 50)) this.#extendPath(consecutive ? previous : null, fix);
    };
    if (!moving) {
      this.#straightFixes = 0;
      extend();
      return;
    }

    const taken = time - this.#delay;
    const turning = consecutive && previous.course !== null;
    fix.rate = turning ? wrap180(course - previous.course) / seconds : 0;
    const yaw = this.#yawAt(taken);
    const turn = this.#turnRate(taken, 1000);
    // Driven wheels that turn faster than the car moves mean it is sliding, whatever the gyroscope says.
    const gripping = !Number.isFinite(wheelSpeed) || (wheelSpeed >= 0.85 * speed && wheelSpeed <= 1.2 * speed);
    const straight = turning && speed >= this.minSpeed && turn !== null && Math.abs(turn) <= this.maxTurn && Math.abs(fix.rate) <= this.maxTurn && gripping;
    this.#straightFixes = straight ? this.#straightFixes + 1 : 0;
    // One quiet second can be the turning point of a transition; two in a row is a straight.
    if (this.#straightFixes >= 2 && yaw !== null) {
      const observed = course + yaw;
      const error = wrap180(observed - this.#offset);
      const creep = CREEP_DEG + (CREEP_DEG_PER_S * (time - this.#correctedAt)) / 1000;
      if (!this.#calibrated) {
        this.#offset = observed;
        this.#calibrated = true;
        this.#moved = false;
        this.#correctedAt = time;
        this.#corrected = true;
      } else if (Math.abs(error) <= creep || this.#straightFixes >= LONG_STRAIGHT_FIXES) {
        this.#offset += this.gain * error;
        this.#correctedAt = time;
        this.#corrected = true;
      }
    }
    if (this.#calibrated && yaw !== null) fix.slip = wrap180(this.#offset - yaw - course);
    extend();
  }

  /**
   * Course at `time` without the accelerometer. Two plain guesses are
   * averaged: that the course keeps turning as it did between the last two
   * fixes, and that the car keeps its angle to the course while the gyroscope
   * tells how far it has turned. Each is right where the other is wrong.
   */
  #guessCourse(fix, time, heading) {
    if (fix.course === null) return null;
    const ahead = Math.min(Math.max(time - (fix.arrived - this.#delay), 0), GUESS_MS) / 1000;
    const byRate = fix.course + fix.rate * ahead;
    if (heading === null || fix.slip === null) return wrap360(byRate);
    const bySlip = heading - fix.slip;
    return wrap360(byRate + wrap180(bySlip - byRate) / 2);
  }

  /**
   * What is known at `time`: heading and course in degrees clockwise from
   * north and their difference, the rate of turn in deg/s (positive to the
   * right), speed in m/s and position, the heading correction, whether the
   * heading was ever set, whether the newest fix corrected it, whether the
   * accelerometer carries the velocity between fixes, the delay of the
   * fixes in ms and whether the phone was handled and the heading has not
   * been set again since. Unknown values are null.
   */
  at(time) {
    const yaw = this.#yawAt(time);
    const turn = this.#turnRate(time);
    const heading = this.#calibrated && yaw !== null ? wrap360(this.#offset - yaw) : null;
    const fix = this.#fix && time - this.#fix.arrived <= FIX_MAX_AGE_MS ? this.#fix : null;
    const carried = fix ? this.#carry(fix, time) : null;
    let course = null;
    let speed = fix?.speed ?? null;
    let position = fix?.position ?? null;
    if (carried) {
      speed = Math.hypot(carried.east, carried.north);
      // Below walking pace the direction of the velocity is noise.
      if (speed >= 1) course = wrap360(Math.atan2(carried.east, carried.north) * DEGREES);
      if (position) position = offsetBy(position, carried.movedEast, carried.movedNorth);
    } else if (fix) {
      course = this.#guessCourse(fix, time, heading);
      if (position && course !== null && speed !== null) {
        const meters = (speed * Math.min(Math.max(time - (fix.arrived - this.#delay), 0), GUESS_MS)) / 1000;
        position = offsetBy(position, meters * Math.sin(course / DEGREES), meters * Math.cos(course / DEGREES));
      }
    }
    return {
      heading,
      course,
      driftAngle: heading !== null && course !== null ? wrap180(heading - course) : null,
      yawRate: turn === null ? null : -turn,
      speed,
      position,
      offset: this.#calibrated ? wrap360(this.#offset) : null,
      calibrated: this.#calibrated,
      corrected: this.#corrected,
      aided: carried !== null,
      gpsDelay: this.#aided ? this.#delay : null,
      moved: this.#moved,
    };
  }
}

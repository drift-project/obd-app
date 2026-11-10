// The driven line through the GPS fixes, smoothed.
//
// GPS gives a position once a second. Joined by straight lines the fixes make
// a polygon: at 40 km/h its corners are 11 m apart, and a car moved along it
// turns in jerks. Between two fixes the line here is instead the cubic curve
// that passes through both and leaves the first and reaches the second with
// the velocity GPS reported there. GPS measures its velocity from the Doppler
// shift of the satellite signals, which is more exact than its positions, so
// the curve bends the way the car went. Where GPS gives no course (standing,
// crawling) the velocity is taken from the neighbouring positions instead, as
// in a Catmull-Rom curve.

import { metersBetween, offsetBy } from './geo.js';

const RADIANS = Math.PI / 180;
const MOVING_MS = 1.5; // m/s: slower than this the course from GPS is noise
const STANDING_MS = 0.3;
export const MAX_GAP_MS = 3000; // fixes further apart are not joined by a curve
const STEP_M = 2; // the drawn line gets a point about this often
const MAX_STEPS = 12;

/**
 * The curve from (0, 0) to `chord` ({ east, north } in metres) that takes
 * `seconds`, leaves with velocity `v0` and arrives with `v1` ({ east, north }
 * in m/s, or null where it is not known). Returns a function of the share of
 * the way, 0 to 1, that gives { east, north, ve, vn }: the place and the
 * velocity there in m/s.
 *
 * A velocity that points away from the next fix, or one far too fast for the
 * distance between the fixes, would make the curve loop; such a velocity is
 * replaced by the straight way to the next fix or cut down.
 */
export function curve(chord, v0, v1, seconds) {
  const length = Math.hypot(chord.east, chord.north);
  const tangent = (velocity) => {
    if (!velocity || seconds <= 0) return { east: chord.east, north: chord.north };
    let east = velocity.east * seconds;
    let north = velocity.north * seconds;
    if (east * chord.east + north * chord.north < 0) return { east: chord.east, north: chord.north };
    const size = Math.hypot(east, north);
    if (size > 3 * length) {
      east *= (3 * length) / size;
      north *= (3 * length) / size;
    }
    return { east, north };
  };
  const m0 = tangent(v0);
  const m1 = tangent(v1);
  return (share) => {
    const s = Math.min(Math.max(share, 0), 1);
    const s2 = s * s;
    const s3 = s2 * s;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    // Derivatives with respect to the share; divided by the time they become m/s.
    const d10 = 3 * s2 - 4 * s + 1;
    const d01 = -6 * s2 + 6 * s;
    const d11 = 3 * s2 - 2 * s;
    const per = seconds > 0 ? 1 / seconds : 0;
    return {
      east: h10 * m0.east + h01 * chord.east + h11 * m1.east,
      north: h10 * m0.north + h01 * chord.north + h11 * m1.north,
      ve: (d10 * m0.east + d01 * chord.east + d11 * m1.east) * per,
      vn: (d10 * m0.north + d01 * chord.north + d11 * m1.north) * per,
    };
  };
}

const courseOf = (east, north) => ((Math.atan2(east, north) / RADIANS) % 360 + 360) % 360;

export class SmoothTrack {
  #origin = null;
  #times = [];
  #east = [];
  #north = [];
  #velocities = []; // { east, north } in m/s, or null
  #curves = []; // #curves[i] joins fix i and i + 1, or is null across a gap

  /**
   * `fixes`: `[{ time, latitude, longitude, speed, course }]` in order of
   * time, with `time` in ms, `speed` in m/s and `course` in degrees clockwise
   * from north; speed and course may be null.
   */
  constructor(fixes) {
    const usable = [];
    for (const fix of fixes) {
      if (!Number.isFinite(fix.time) || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) continue;
      // Two fixes at the same moment: the later one stands.
      if (usable.length && fix.time <= usable.at(-1).time) usable.pop();
      usable.push(fix);
    }
    if (!usable.length) return;
    this.#origin = { latitude: usable[0].latitude, longitude: usable[0].longitude };
    for (const fix of usable) {
      const place = metersBetween(this.#origin, fix);
      this.#times.push(fix.time);
      this.#east.push(place.east);
      this.#north.push(place.north);
    }
    const count = usable.length;
    const joined = (index) => index + 1 < count && this.#times[index + 1] - this.#times[index] <= MAX_GAP_MS;
    for (let index = 0; index < count; index += 1) {
      const { speed, course } = usable[index];
      if (Number.isFinite(speed) && speed >= MOVING_MS && Number.isFinite(course)) {
        this.#velocities.push({ east: speed * Math.sin(course * RADIANS), north: speed * Math.cos(course * RADIANS) });
      } else if (Number.isFinite(speed) && speed < STANDING_MS) {
        this.#velocities.push({ east: 0, north: 0 });
      } else {
        // From the neighbours that belong to the same stretch.
        const before = index > 0 && joined(index - 1) ? index - 1 : index;
        const after = joined(index) ? index + 1 : index;
        const seconds = (this.#times[after] - this.#times[before]) / 1000;
        this.#velocities.push(
          seconds > 0 ? { east: (this.#east[after] - this.#east[before]) / seconds, north: (this.#north[after] - this.#north[before]) / seconds } : null,
        );
      }
    }
    for (let index = 0; index + 1 < count; index += 1) {
      if (!joined(index)) {
        this.#curves.push(null);
        continue;
      }
      const chord = { east: this.#east[index + 1] - this.#east[index], north: this.#north[index + 1] - this.#north[index] };
      this.#curves.push(curve(chord, this.#velocities[index], this.#velocities[index + 1], (this.#times[index + 1] - this.#times[index]) / 1000));
    }
  }

  get empty() {
    return this.#times.length === 0;
  }

  get start() {
    return this.#times[0] ?? null;
  }

  get end() {
    return this.#times.at(-1) ?? null;
  }

  /** Index of the last fix at or before `time`, or -1. */
  #index(time) {
    let low = 0;
    let high = this.#times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.#times[middle] <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  #place(index, east, north, ve, vn) {
    const place = offsetBy(this.#origin, east, north);
    const speed = Math.hypot(ve, vn);
    return { latitude: place.latitude, longitude: place.longitude, speed, course: speed >= 0.5 ? courseOf(ve, vn) : null };
  }

  /**
   * Where the car was at `time` (ms): `{ latitude, longitude, speed, course }`
   * with the speed in m/s and the course in degrees (null when crawling). In
   * a gap between fixes the last one is held for `holdMs`; outside the fixes,
   * and after that, it is null.
   */
  at(time, holdMs = MAX_GAP_MS) {
    const index = this.#index(time);
    if (index < 0) return null;
    const join = this.#curves[index];
    if (join) {
      const share = (time - this.#times[index]) / (this.#times[index + 1] - this.#times[index]);
      const point = join(share);
      return this.#place(index, this.#east[index] + point.east, this.#north[index] + point.north, point.ve, point.vn);
    }
    if (time - this.#times[index] > holdMs) return null;
    const velocity = this.#velocities[index] ?? { east: 0, north: 0 };
    return this.#place(index, this.#east[index], this.#north[index], velocity.east, velocity.north);
  }

  /**
   * The acceleration over ground at `time` in m/s², as the change of the
   * velocity GPS measured from the fix before to the fix after: an average
   * over about a second, steadier than the bend of the curve. Null in a gap
   * or outside the fixes.
   */
  acceleration(time) {
    const index = this.#index(time);
    if (index < 0 || !this.#curves[index]) return null;
    const before = this.#velocities[index];
    const after = this.#velocities[index + 1];
    if (!before || !after) return null;
    const seconds = (this.#times[index + 1] - this.#times[index]) / 1000;
    return Math.hypot(after.east - before.east, after.north - before.north) / seconds;
  }

  /**
   * The line for drawing: `[[latitude, longitude, time], ...]` through every
   * fix with points on the curves between them about every two metres. A gap
   * between fixes is left as a straight line from one to the other. At most
   * `limit` points: on a long recording the steps are made longer.
   */
  points(limit = 20000) {
    const count = this.#times.length;
    if (!count) return [];
    const steps = [];
    let total = count;
    for (let index = 0; index + 1 < count; index += 1) {
      const length = Math.hypot(this.#east[index + 1] - this.#east[index], this.#north[index + 1] - this.#north[index]);
      const wanted = this.#curves[index] ? Math.min(Math.max(Math.ceil(length / STEP_M), 1), MAX_STEPS) : 1;
      steps.push(wanted);
      total += wanted - 1;
    }
    const out = [];
    if (count > limit) {
      // Not even every fix fits: every so many, and the last.
      const stride = Math.ceil(count / limit);
      for (let index = 0; index < count; index += 1) {
        if (index % stride !== 0 && index !== count - 1) continue;
        const fix = offsetBy(this.#origin, this.#east[index], this.#north[index]);
        out.push([fix.latitude, fix.longitude, this.#times[index]]);
      }
      return out;
    }
    // The points between fixes that fit are shared out evenly, the fractions carried on so the total stays within the limit.
    const thin = total > limit ? (limit - count) / Math.max(total - count, 1) : 1;
    let carried = 0;
    for (let index = 0; index < count; index += 1) {
      const fix = offsetBy(this.#origin, this.#east[index], this.#north[index]);
      out.push([fix.latitude, fix.longitude, this.#times[index]]);
      if (index + 1 >= count) break;
      const join = this.#curves[index];
      carried += join ? (steps[index] - 1) * thin : 0;
      const inner = Math.floor(carried + 1e-9);
      carried -= inner;
      for (let step = 1; step <= inner; step += 1) {
        const share = step / (inner + 1);
        const point = join(share);
        const place = offsetBy(this.#origin, this.#east[index] + point.east, this.#north[index] + point.north);
        out.push([place.latitude, place.longitude, this.#times[index] + share * (this.#times[index + 1] - this.#times[index])]);
      }
    }
    return out;
  }
}

/**
 * The smoothed line through the GPS fixes of a recording. The fixes are timed by the receiver's own clock
 * (fix_ms), which spaces them evenly where their arrival may bunch up, moved onto the time line of the
 * recording by the usual delay between fix and arrival. A fix more than 50 m off is left out.
 */
export function trackOf(recording) {
  const { times, values: latitudes } = recording.series('gps.latitude_deg');
  const longitudes = recording.series('gps.longitude_deg').values;
  const exact = (id, time) => recording.value(id, time, 0);
  const delays = [];
  for (const time of times) {
    const fix = exact('gps.fix_ms', time);
    if (fix !== null && time - fix >= 0 && time - fix < 5000) delays.push(time - fix);
  }
  delays.sort((a, b) => a - b);
  const delay = delays.length ? delays[Math.floor(delays.length / 2)] : null;
  const fixes = [];
  for (let index = 0; index < Math.min(times.length, longitudes.length); index += 1) {
    const time = times[index];
    if (exact('gps.accuracy_m', time) > 50) continue;
    const fix = exact('gps.fix_ms', time);
    fixes.push({
      time: delay !== null && fix !== null && time - fix >= 0 && time - fix < 5000 ? fix + delay : time,
      latitude: latitudes[index],
      longitude: longitudes[index],
      speed: exact('gps.speed_ms', time),
      course: exact('gps.heading_deg', time),
    });
  }
  fixes.sort((a, b) => a.time - b.time);
  const track = new SmoothTrack(fixes);
  return track.empty ? null : track;
}

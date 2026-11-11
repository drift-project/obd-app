// What happened in a recording, in numbers: the drifts one by one and the
// totals of the drive.
//
// A drift here is a stretch where the car points clearly away from where it
// travels, to one side, at more than walking pace. It needs the drift angle,
// so a recording without the phone's attitude and GPS has none to find.

const START_DEG = 10; // a drift begins when the angle reaches this
const END_DEG = 6; // and goes on until it falls below this, or changes side
const MIN_SPEED_MS = 5; // 18 km/h: slower than this the direction of travel is too uncertain, as for setting the heading
const MIN_MS = 800; // shorter is a twitch, not a drift
const JOIN_MS = 700; // two drifts to the same side this close together are one
const GAP_MS = 500; // a longer silence of the drift angle ends a drift
const WHEEL_LAG_MS = 800; // the car's speed arrives late, so its readings are looked for a little past the drift
const GPS_GAP_MS = 3000;

const G = 9.80665;

const speedAt = (recording, time) => recording.value('drift.speed_ms', time, 1500) ?? recording.value('gps.speed_ms', time, 3000);

/** The hardest push on the car from `from` to `to` in g, along and across it together; null where the recording does not tell. */
function mostPush(recording, from = -Infinity, to = Infinity) {
  const ahead = recording.series('drift.ahead_ms2');
  let most = null;
  for (let index = 0; index < ahead.times.length; index += 1) {
    const time = ahead.times[index];
    if (time < from) continue;
    if (time > to) break;
    const right = recording.value('drift.right_ms2', time, 0);
    if (!Number.isFinite(right) || !Number.isFinite(ahead.values[index])) continue;
    most = Math.max(most ?? 0, Math.hypot(ahead.values[index], right) / G);
  }
  return most;
}

/**
 * Finds drifts as the rows of the drift stream come, so that each can be told the moment it is over; the
 * replay finds them with the same rules from the recording. `add(time, angle, speed)` takes a row in order
 * of time (the drift angle in degrees, the speed over ground in m/s or null), `tick(time)` says that time
 * went on without a known angle and `finish()` that nothing more comes. `onDrift({ from, to, peak, side,
 * speedKmh })` gets each drift once it can no longer grow: when the angle has stayed down for longer than
 * two stretches may lie apart and still be one drift, or the next stretch went to the other side.
 */
export class DriftTracker {
  #open = null; // the stretch at an angle going on: { from, to, peak, speed, count }
  #held = null; // the one before, which the next stretch to the same side may still join

  constructor(onDrift) {
    this.onDrift = onDrift;
  }

  add(time, angle, speed) {
    const fast = speed !== null && speed >= MIN_SPEED_MS;
    const open = this.#open;
    if (open && (time - open.to > GAP_MS || !fast || Math.abs(angle) < END_DEG || Math.sign(angle) !== Math.sign(open.peak))) this.#close();
    if (!this.#open) {
      this.tick(time);
      if (!fast || Math.abs(angle) < START_DEG) return;
      // A stretch to the other side cannot join the one before: that one is over.
      if (this.#held && Math.sign(angle) !== Math.sign(this.#held.peak)) this.#release();
      this.#open = { from: time, to: time, peak: angle, speed: 0, count: 0 };
    }
    const current = this.#open;
    current.to = time;
    current.speed += speed;
    current.count += 1;
    if (Math.abs(angle) > Math.abs(current.peak)) current.peak = angle;
  }

  tick(time) {
    // A longer silence of the angle ends the stretch, as the next known angle would.
    if (this.#open && time - this.#open.to > GAP_MS) this.#close();
    if (!this.#open && this.#held && time - this.#held.to > JOIN_MS) this.#release();
  }

  finish() {
    this.#close();
    this.#release();
  }

  /** The stretch at an angle has ended. The angle dipping for a moment does not make two drifts of one. */
  #close() {
    const open = this.#open;
    this.#open = null;
    if (!open) return;
    const held = this.#held;
    if (held && open.from - held.to <= JOIN_MS && Math.sign(open.peak) === Math.sign(held.peak)) {
      held.to = open.to;
      held.speed += open.speed;
      held.count += open.count;
      if (Math.abs(open.peak) > Math.abs(held.peak)) held.peak = open.peak;
      return;
    }
    this.#release();
    this.#held = open;
  }

  #release() {
    const held = this.#held;
    this.#held = null;
    if (!held || held.to - held.from < MIN_MS) return;
    this.onDrift({ from: held.from, to: held.to, peak: held.peak, side: held.peak > 0 ? 'R' : 'L', speedKmh: (held.speed / held.count) * 3.6 });
  }
}

/**
 * The drifts of a recording in order of time: `[{ from, to, peak, side,
 * speedKmh, slipPct, gripG }]`. `peak` is the largest angle in degrees with
 * its sign (positive: the nose points to the right of the direction of
 * travel), `side` 'R' or 'L' the same in a letter, `speedKmh` the mean speed
 * over ground, `slipPct` the most the wheels ran ahead of the ground during
 * it and `gripG` the hardest push on the car in g, each null when the
 * recording does not tell.
 */
export function findDrifts(recording) {
  const { times, values } = recording.series('drift.drift_angle_deg');
  const found = [];
  const tracker = new DriftTracker((drift) => found.push(drift));
  for (let index = 0; index < times.length; index += 1) tracker.add(times[index], values[index], speedAt(recording, times[index]));
  tracker.finish();

  const slip = recording.series('wheels.slip_pct');
  return found.map((drift) => {
    let slipPct = null;
    for (let index = 0; index < slip.times.length; index += 1) {
      const time = slip.times[index];
      if (time < drift.from || time > drift.to + WHEEL_LAG_MS) continue;
      if (slipPct === null || slip.values[index] > slipPct) slipPct = slip.values[index];
    }
    return { ...drift, slipPct, gripG: mostPush(recording, drift.from, drift.to) };
  });
}

/**
 * The totals of a recording. `drifts` come from findDrifts() and
 * `wheelSpans` from the wheel comparison. Values the recording cannot give
 * are null:
 *
 * - `recordedMs`: time recorded, pauses left out;
 * - `distanceM`: distance over ground from GPS speed;
 * - `topSpeedKmh` over ground, `topWheelKmh` as the car read it, `topRpm`, `topCoolantC`;
 * - `drifts` (their number), `driftMs` in all, `longestMs`, `bestAngle` with its sign, `driftSpeedKmh` on average;
 * - `spinMs`: time the wheels turned faster than the car moved, and `topSlipPct`;
 * - `topGrip`: the hardest push on the car in g.
 */
export function summarize(recording, drifts = [], wheelSpans = []) {
  const highest = new Map(recording.signals.map(({ id, max }) => [id, max]));
  const top = (id) => highest.get(id) ?? null;

  let distance = null;
  const speed = recording.series('gps.speed_ms');
  for (let index = 1; index < speed.times.length; index += 1) {
    const seconds = (speed.times[index] - speed.times[index - 1]) / 1000;
    if (seconds * 1000 > GPS_GAP_MS) continue;
    distance = (distance ?? 0) + ((speed.values[index] + speed.values[index - 1]) / 2) * seconds;
  }

  const best = drifts.reduce((most, drift) => (most === null || Math.abs(drift.peak) > Math.abs(most) ? drift.peak : most), null);
  const driftMs = drifts.reduce((sum, drift) => sum + (drift.to - drift.from), 0);
  const spins = wheelSpans.filter(({ kind }) => kind === 'spin');
  const topGround = top('gps.speed_ms');
  return {
    recordedMs: recording.stretches().reduce((sum, [from, to]) => sum + (to - from), 0),
    distanceM: distance,
    topSpeedKmh: topGround === null ? null : topGround * 3.6,
    topWheelKmh: top('obd.speed_kmh'),
    topRpm: top('obd.rpm'),
    topCoolantC: top('obd.coolant_c'),
    drifts: drifts.length,
    driftMs,
    longestMs: drifts.reduce((longest, drift) => Math.max(longest, drift.to - drift.from), 0),
    bestAngle: best,
    driftSpeedKmh: driftMs ? drifts.reduce((sum, drift) => sum + drift.speedKmh * (drift.to - drift.from), 0) / driftMs : null,
    spinMs: spins.reduce((sum, span) => sum + (span.to - span.from), 0),
    topSlipPct: spins.reduce((most, span) => (most === null || span.peak > most ? span.peak : most), null),
    topGrip: mostPush(recording),
  };
}

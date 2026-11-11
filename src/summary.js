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
  let open = null;
  const close = () => {
    if (open) found.push(open);
    open = null;
  };
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const angle = values[index];
    const speed = speedAt(recording, time);
    const fast = speed !== null && speed >= MIN_SPEED_MS;
    if (open && (time - open.to > GAP_MS || !fast || Math.abs(angle) < END_DEG || Math.sign(angle) !== Math.sign(open.peak))) close();
    if (!open) {
      if (!fast || Math.abs(angle) < START_DEG) continue;
      open = { from: time, to: time, peak: angle, speed: 0, count: 0 };
    }
    open.to = time;
    open.speed += speed;
    open.count += 1;
    if (Math.abs(angle) > Math.abs(open.peak)) open.peak = angle;
  }
  close();

  // The angle dipping for a moment does not make two drifts of one.
  const joined = [];
  for (const drift of found) {
    const last = joined.at(-1);
    if (last && drift.from - last.to <= JOIN_MS && Math.sign(drift.peak) === Math.sign(last.peak)) {
      last.to = drift.to;
      last.speed += drift.speed;
      last.count += drift.count;
      if (Math.abs(drift.peak) > Math.abs(last.peak)) last.peak = drift.peak;
    } else {
      joined.push({ ...drift });
    }
  }

  const slip = recording.series('wheels.slip_pct');
  return joined
    .filter((drift) => drift.to - drift.from >= MIN_MS)
    .map(({ from, to, peak, speed, count }) => {
      let slipPct = null;
      for (let index = 0; index < slip.times.length; index += 1) {
        const time = slip.times[index];
        if (time < from || time > to + WHEEL_LAG_MS) continue;
        if (slipPct === null || slip.values[index] > slipPct) slipPct = slip.values[index];
      }
      return { from, to, peak, side: peak > 0 ? 'R' : 'L', speedKmh: (speed / count) * 3.6, slipPct, gripG: mostPush(recording, from, to) };
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

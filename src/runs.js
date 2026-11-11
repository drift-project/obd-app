// The log split into runs: the stretches of driving between longer stops, so
// that each can be replayed, summed up and saved on its own. Between two goes
// on a closed stretch of road the car waits; a recording that was stopped and
// started again leaves a silence. Either ends a run.

import { driftTable } from './drift-replay.js';
import { powerTable } from './engine.js';
import { Recording } from './replay.js';
import { findDrifts, summarize } from './summary.js';
import { trimTables } from './trim.js';
import { wheelSlip } from './wheels.js';

// Standing this long ends a run. Between his drift runs the car waited a minute or more; in town it stood at
// lights for up to 28 s, which should not cut a drive in two.
export const STOP_MS = 45000;
const STANDING_MS = 1; // m/s: slower than this the car stands (GPS shows a few tenths of a metre a second at rest)
const MOVING_MS = 3; // m/s: from here on the car drives, as for showing an example
const SILENCE_MS = 30000; // a longer silence of the speed (nothing recorded, or no fix) ends a run too
const STEP_MS = 3000; // the distance is summed only between readings this close together
const MIN_MOVING_MS = 10000; // a run has at least this much driving...
const MIN_DISTANCE_M = 100; // ...or this much distance: less is moving the car about
export const LEAD_MS = 3000; // a run is shown from this long before the car first moves
export const TAIL_MS = 3000; // and until this long after it last moved

/**
 * The runs in a speed signal: `times` (ms) and `speeds` (m/s) in order of time. Returns `[{ from, to,
 * movingMs, distanceM, topKmh, open }]`: the stretch to show (from a moment before the car first moved to a
 * moment after it last did), the time spent driving, the distance and the highest speed. `open` is true for
 * a run that has not ended yet: the car has not stood long enough since, and nothing after it says it is over.
 */
export function findRuns(times, speeds) {
  const runs = [];
  let run = null; // the run going on: { start, first, last, movingMs, distanceM, top }
  let standingSince = null;
  let previous = null; // [time, speed] of the reading before
  let resumed = null; // the first reading after a silence: a run is not shown from before it
  const close = () => {
    if (run && (run.movingMs >= MIN_MOVING_MS || run.distanceM >= MIN_DISTANCE_M)) {
      const before = runs.at(-1)?.to ?? -Infinity;
      runs.push({ from: Math.max(run.first - LEAD_MS, before, run.start), to: run.last + TAIL_MS, movingMs: run.movingMs, distanceM: run.distanceM, topKmh: run.top * 3.6, open: false });
    }
    run = null;
  };
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const speed = speeds[index];
    if (!Number.isFinite(speed)) continue;
    if (!previous || time - previous[0] > SILENCE_MS) {
      close();
      resumed = time;
    }
    if (speed < STANDING_MS) standingSince ??= time;
    else standingSince = null;
    if (run && standingSince !== null && time - standingSince >= STOP_MS) close();
    if (speed >= MOVING_MS) {
      run ??= { start: resumed, first: time, last: time, movingMs: 0, distanceM: 0, top: 0 };
      run.last = time;
      run.top = Math.max(run.top, speed);
    }
    // The few tenths of a metre a second GPS shows at rest are not distance.
    if (run && previous && time - previous[0] <= STEP_MS && speed >= STANDING_MS) {
      const seconds = (time - previous[0]) / 1000;
      run.distanceM += ((speed + previous[1]) / 2) * seconds;
      if (speed >= MOVING_MS && previous[1] >= MOVING_MS) run.movingMs += time - previous[0];
    }
    previous = [time, speed];
  }
  const going = run;
  close();
  // A run the data ends in is still going, unless the car has stood long enough since its last move.
  if (going && runs.length && runs.at(-1).to === going.last + TAIL_MS) runs.at(-1).open = true;
  return runs;
}

/**
 * The tables of a recording with what the replay works out from them: the drift angle again from the
 * recorded sensors (what the drive showed is kept as `drift_recorded`), the wheels against the ground and
 * the power of the engine. `{ recorded, all, again, wheels, whole }`: the recording as it came, all the
 * tables, the drift table worked out, the wheel comparison and all of it as one Recording.
 */
export function workOut(tables) {
  const recorded = new Recording(tables);
  let all = tables;
  const again = recorded.empty ? null : driftTable(recorded);
  if (again) all = [...all.map((table) => (table.stream === 'drift' ? { ...table, stream: 'drift_recorded' } : table)), { stream: 'drift', ...again }];
  const wheels = recorded.empty ? null : wheelSlip(recorded);
  if (wheels) all = [...all, { stream: 'wheels', columns: wheels.columns, data: wheels.data }];
  const power = recorded.empty ? null : powerTable(recorded);
  if (power) all = [...all, { stream: 'engine', ...power }];
  return { recorded, all, again, wheels, whole: all === tables ? recorded : new Recording(all) };
}

/**
 * What each run of a log holds, worked out as the replay would: `runs` from findRuns() and the tables of
 * the whole log. `[{ drifts, bestAngle, longestMs, topGrip, topSlipPct }]` in the order of the runs; the
 * values a run cannot tell are null (drifts and bestAngle need the drift angle).
 */
export function runTotals(tables, runs) {
  const { all, wheels, whole } = workOut(tables);
  const angle = whole.has('drift.drift_angle_deg');
  return runs.map(({ from, to }) => {
    const part = new Recording(trimTables(all, from, to));
    if (part.empty) return { drifts: null, bestAngle: null, longestMs: null, topGrip: null, topSlipPct: null };
    const spans = (wheels?.spans ?? []).filter((span) => span.to >= from && span.from <= to);
    const drifts = findDrifts(part);
    const totals = summarize(part, drifts, spans);
    return {
      drifts: angle ? totals.drifts : null,
      bestAngle: totals.bestAngle,
      longestMs: angle ? totals.longestMs : null,
      topGrip: totals.topGrip,
      topSlipPct: totals.topSlipPct,
    };
  });
}

// The part of a recording worth showing: the drive without the minutes of
// standing and of the phone being handled, or only the drifts. The rest of
// the data is still used to work the drift angle out, which needs the
// straight driving before the first slide to know where the car points.

export const BEFORE_DRIFT_MS = 1000; // a drift run is shown from this long before its first drift
export const AFTER_DRIFT_MS = 2500; // and until this long after its last
const MOVING_MS = 3; // m/s: from here on the car counts as driving
const AROUND_MOVING_MS = 1000;

/**
 * The stretch `[from, to]` of `recording` to show for `trim`: 'drifts' (from
 * a second before the first action to a moment after the last, where action
 * is one of `drifts` or a stretch of `spins`, the wheels running ahead of the
 * car, as when it pulls away hard), 'moving' (while the car drives and the
 * heading is known) or anything else for all of it. Falls back to all of it
 * where the recording does not have what the trim needs.
 */
export function trimSpan(recording, trim, drifts = [], spins = []) {
  const all = [recording.start, recording.end];
  const within = ([from, to]) => {
    const span = [Math.max(from, recording.start), Math.min(to, recording.end)];
    return span[1] > span[0] ? span : all;
  };
  const action = [...drifts, ...spins.filter(({ kind }) => kind === 'spin')];
  if (trim === 'drifts' && action.length) {
    const first = Math.min(...action.map(({ from }) => from));
    const last = Math.max(...action.map(({ to }) => to));
    return within([first - BEFORE_DRIFT_MS, last + AFTER_DRIFT_MS]);
  }
  if (trim === 'moving') {
    const { times, values } = recording.series('gps.speed_ms');
    const moving = times.filter((_, index) => values[index] >= MOVING_MS);
    if (!moving.length) return all;
    let to = moving.at(-1) + AROUND_MOVING_MS;
    // Where the phone was picked up before the end, the heading is lost: the drive is shown until then.
    const known = recording.series('drift.calibrated');
    for (let index = 1; index < known.times.length; index += 1) {
      if (known.values[index - 1] === 1 && known.values[index] === 0 && known.times[index] > moving[0]) {
        to = Math.min(to, known.times[index]);
        break;
      }
    }
    return within([moving[0] - AROUND_MOVING_MS, to]);
  }
  return all;
}

/** The rows of `tables` ([{ stream, columns, data }]) from `from` to `to`, by the time in their first column. */
export function trimTables(tables, from, to) {
  return tables.map((table) => {
    const width = table.columns.length;
    const rows = width ? table.data.length / width : 0;
    const kept = [];
    for (let row = 0; row < rows; row += 1) {
      const time = table.data[row * width];
      if (time >= from && time <= to) kept.push(row);
    }
    if (kept.length === rows) return table;
    const data = new Float64Array(kept.length * width);
    kept.forEach((row, index) => data.set(table.data.subarray(row * width, (row + 1) * width), index * width));
    return { ...table, data };
  });
}

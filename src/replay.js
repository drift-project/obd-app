// A recording loaded for replay: every measured value as a signal on one
// time axis, whichever file it came from.
//
// The files of a log are tables whose first column is the time in
// milliseconds since 1970. A table can be sparse: on a K-line car every row
// of the car's table holds a single value. So each column becomes a signal
// with its own times, and a value is looked up by time, not by row.

/** The cells of a CSV text with a header line, as numbers, row after row; empty and non-numeric cells are NaN. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const columns = (lines[0] ?? '').split(',').map((name) => name.trim());
  const width = columns.length;
  let count = 0;
  for (let index = 1; index < lines.length; index += 1) if (lines[index].trim()) count += 1;
  const data = new Float64Array(count * width);
  let offset = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const cells = lines[index].split(',');
    for (let column = 0; column < width; column += 1) {
      const cell = cells[column]?.trim();
      data[offset + column] = cell ? Number(cell) : NaN;
    }
    offset += width;
  }
  return { columns, data };
}

/**
 * Which stream a log file holds, by its name: `obd` for the car's
 * obd_data_*.csv, the sensor's name for phone_<sensor>_*.csv, and otherwise
 * the file name without its date and ending.
 */
export function streamOf(fileName) {
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  // Something may stand before and after the app's own name: "1a2b-obd_data_....csv", "phone_gps_... (1).csv".
  if (/(^|[^a-z])obd_(data|demo)/i.test(name)) return 'obd';
  const phone = /(?:^|[^a-z])phone_([a-z_]+?)(?:_\d{8}_\d{6})?(?:\W.*)?$/i.exec(name);
  if (phone) return phone[1].toLowerCase();
  return name.replace(/_\d{8}_\d{6}$/, '');
}

/** Index of the first of the sorted `times` that is not before `time`. */
function firstAtOrAfter(times, time) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Index of the last of the sorted `times` that is not after `time`, or -1. */
function lastAtOrBefore(times, time) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** Times and values put in order of time. */
function sorted(times, values) {
  let ordered = true;
  for (let index = 1; index < times.length && ordered; index += 1) ordered = times[index] >= times[index - 1];
  if (ordered) return [times, values];
  const order = Array.from(times.keys()).sort((a, b) => times[a] - times[b]);
  return [Float64Array.from(order, (index) => times[index]), Float64Array.from(order, (index) => values[index])];
}

export class Recording {
  #signals = new Map();
  #rowTimes = []; // the row times of every table, sorted: where the recording has data at all

  /**
   * `tables`: `[{ stream, columns, data }]`. `columns` names the cells of a
   * row, the first being the time in ms; `data` is a Float64Array with the
   * rows one after another. A table without usable times is left out and
   * named in `skipped`.
   */
  constructor(tables) {
    this.skipped = [];
    for (const { stream, columns, data } of tables) {
      const width = columns.length;
      const rows = width ? Math.floor(data.length / width) : 0;
      const times = new Float64Array(rows);
      let usable = 0;
      let ordered = true;
      for (let row = 0; row < rows; row += 1) {
        times[row] = data[row * width];
        // Milliseconds since 1970 for any date after 2001; anything smaller is not such a time.
        if (times[row] > 1e12) usable += 1;
        if (row && times[row] < times[row - 1]) ordered = false;
      }
      if (!usable || width < 2) {
        this.skipped.push(stream);
        continue;
      }
      // The usual table: every row has a time and they are in order. Its full columns can share the row times.
      const whole = ordered && usable === rows;
      this.#rowTimes.push(whole ? times : times.filter((time) => time > 1e12).sort());
      for (let column = 1; column < width; column += 1) this.#addSignal(stream, columns[column], times, data, column, width, whole);
    }
  }

  #addSignal(stream, column, rowTimes, data, offset, width, whole) {
    let count = 0;
    for (let row = 0; row < rowTimes.length; row += 1) {
      if (rowTimes[row] > 1e12 && Number.isFinite(data[row * width + offset])) count += 1;
    }
    if (!count) return;
    const id = `${stream}.${column}`;
    const before = this.#signals.get(id);
    const start = before ? before.times.length : 0;
    // A column without a gap needs no times of its own: a long recording of the phone has millions of them.
    const shared = whole && !before && count === rowTimes.length;
    let times = shared ? rowTimes : new Float64Array(start + count);
    let values = new Float64Array(start + count);
    if (before) {
      times.set(before.times);
      values.set(before.values);
    }
    let at = start;
    for (let row = 0; row < rowTimes.length; row += 1) {
      const value = data[row * width + offset];
      if (!(rowTimes[row] > 1e12) || !Number.isFinite(value)) continue;
      if (!shared) times[at] = rowTimes[row];
      values[at] = value;
      at += 1;
    }
    [times, values] = sorted(times, values);
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    this.#signals.set(id, { id, stream, column, times, values, min, max });
  }

  /** `[{ id, stream, column, count, min, max }]` in the order the tables were given. */
  get signals() {
    return [...this.#signals.values()].map(({ id, stream, column, times, min, max }) => ({ id, stream, column, count: times.length, min, max }));
  }

  has(id) {
    return this.#signals.has(id);
  }

  /** Every value of a signal with its time, as two arrays of the same length (empty for an unknown signal). */
  series(id) {
    const signal = this.#signals.get(id);
    return signal ? { times: signal.times, values: signal.values } : { times: new Float64Array(0), values: new Float64Array(0) };
  }

  get empty() {
    return this.#signals.size === 0;
  }

  /** Time of the first value in ms. */
  get start() {
    return Math.min(...this.#rowTimes.map((times) => times[0]));
  }

  /** Time of the last value in ms. */
  get end() {
    return Math.max(...this.#rowTimes.map((times) => times.at(-1)));
  }

  /**
   * The newest value of a signal at or before `time`, or null when there is
   * none or it is older than `holdMs`.
   */
  value(id, time, holdMs = Infinity) {
    const signal = this.#signals.get(id);
    if (!signal) return null;
    const index = lastAtOrBefore(signal.times, time);
    if (index < 0 || time - signal.times[index] > holdMs) return null;
    return signal.values[index];
  }

  /**
   * Like value(), but between two values it gives the point on the straight
   * line from one to the next, so that what is drawn from it moves smoothly.
   * Two values further apart than `holdMs` are not joined: the earlier one
   * is held as value() holds it.
   */
  interpolate(id, time, holdMs = Infinity) {
    return this.#between(id, time, holdMs, (from, to) => to - from);
  }

  /**
   * Like interpolate(), for an angle in degrees: between 350 and 10 it goes
   * the short way, through 0, and the result is in the range of the signal
   * (-180 to 180 for a signal that has negative values, else 0 to 360).
   */
  interpolateAngle(id, time, holdMs = Infinity) {
    const value = this.#between(id, time, holdMs, (from, to) => ((((to - from + 180) % 360) + 360) % 360) - 180);
    if (value === null) return null;
    const signed = this.#signals.get(id).min < 0;
    const turned = ((value % 360) + 360) % 360;
    return signed && turned > 180 ? turned - 360 : turned;
  }

  #between(id, time, holdMs, change) {
    const signal = this.#signals.get(id);
    if (!signal) return null;
    const { times, values } = signal;
    const index = lastAtOrBefore(times, time);
    if (index < 0) return null;
    const step = index + 1 < times.length ? times[index + 1] - times[index] : 0;
    if (step > 0 && step <= holdMs) return values[index] + (change(values[index], values[index + 1]) * (time - times[index])) / step;
    return time - times[index] > holdMs ? null : values[index];
  }

  /** How many values a signal has between two times, both ends included. */
  count(id, from, to) {
    const signal = this.#signals.get(id);
    if (!signal) return 0;
    return lastAtOrBefore(signal.times, to) - firstAtOrAfter(signal.times, from) + 1;
  }

  /**
   * The values of a signal between two times as `[[time, value], ...]` for
   * drawing, with one point beyond each end so the line reaches the edges.
   * More points than `limit` are thinned so that every peak and dip stays.
   */
  points(id, from, to, limit = 800) {
    const signal = this.#signals.get(id);
    if (!signal) return [];
    const { times, values } = signal;
    const first = Math.max(firstAtOrAfter(times, from) - 1, 0);
    const last = Math.min(firstAtOrAfter(times, to), times.length - 1);
    const count = last - first + 1;
    if (count <= 0) return [];
    const points = [];
    if (count <= limit) {
      for (let index = first; index <= last; index += 1) points.push([times[index], values[index]]);
      return points;
    }
    const buckets = Math.max(Math.floor(limit / 2), 1);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = first + Math.floor((bucket * count) / buckets);
      const end = first + Math.floor(((bucket + 1) * count) / buckets);
      let low = start;
      let high = start;
      for (let index = start; index < end; index += 1) {
        if (values[index] < values[low]) low = index;
        if (values[index] > values[high]) high = index;
      }
      for (const index of low === high ? [low] : [Math.min(low, high), Math.max(low, high)]) points.push([times[index], values[index]]);
    }
    return points;
  }

  /**
   * The stretches in which something was recorded, as `[[from, to], ...]`:
   * times closer together than `gapMs` belong to one stretch.
   */
  stretches(gapMs = 3000) {
    const pieces = [];
    for (const times of this.#rowTimes) {
      let from = times[0];
      for (let index = 1; index <= times.length; index += 1) {
        if (index < times.length && times[index] - times[index - 1] <= gapMs) continue;
        pieces.push([from, times[index - 1]]);
        from = times[index];
      }
    }
    pieces.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const piece of pieces) {
      const last = merged.at(-1);
      if (last && piece[0] - last[1] <= gapMs) last[1] = Math.max(last[1], piece[1]);
      else merged.push([...piece]);
    }
    return merged;
  }
}

/** Where a replay goes next from `time`: `time` itself inside a stretch, else the start of the next one, else null. */
export function skipGap(stretches, time) {
  for (const [from, to] of stretches) {
    if (time <= to) return Math.max(time, from);
  }
  return null;
}

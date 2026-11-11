// Samples from the phone sensors, kept compactly and written out as CSV.
//
// Every stream is a table of numbers: a timestamp followed by a fixed set of
// columns. Samples are collected in plain arrays and packed into Float64Array
// blocks about once a second; the blocks are what goes to IndexedDB. A missing
// value (a phone without an altitude, say) is NaN in a block and an empty cell
// in the CSV.

/**
 * One table per stream. `columns` follow `timestamp_ms`; `digits` is the
 * number of decimals written to the CSV, one for all columns or one each.
 */
export class SampleLog {
  #streams = new Map();

  constructor(streams) {
    for (const { name, columns, digits = 4 } of streams) {
      this.#streams.set(name, {
        columns,
        width: columns.length + 1,
        digits: Array.isArray(digits) ? digits : columns.map(() => digits),
        pending: [],
        blocks: [],
        samples: 0,
      });
    }
  }

  get names() {
    return [...this.#streams.keys()];
  }

  /** Add one sample: `[timestamp_ms, ...values]`, with null or undefined for a missing value. */
  add(name, values) {
    const stream = this.#streams.get(name);
    for (let i = 0; i < stream.width; i += 1) {
      const value = values[i];
      stream.pending.push(typeof value === 'number' ? value : NaN);
    }
    stream.samples += 1;
  }

  /** Pack what was added since the last call: `{ stream: Float64Array }`, or null when nothing is new. */
  take() {
    let batch = null;
    for (const [name, stream] of this.#streams) {
      if (!stream.pending.length) continue;
      const block = Float64Array.from(stream.pending);
      stream.pending = [];
      stream.blocks.push(block);
      batch ??= {};
      batch[name] = block;
    }
    return batch;
  }

  /** Put back batches read from storage (streams this version does not know are skipped). */
  load(batches) {
    for (const batch of batches) {
      for (const [name, block] of Object.entries(batch ?? {})) {
        const stream = this.#streams.get(name);
        if (!stream || !(block instanceof Float64Array) || block.length % stream.width !== 0) continue;
        stream.blocks.push(block);
        stream.samples += block.length / stream.width;
      }
    }
  }

  /** The blocks of a stream with what has not been packed yet. */
  #blocksOf(stream) {
    return stream.pending.length ? [...stream.blocks, stream.pending] : stream.blocks;
  }

  /** How many samples a stream has, all of them or those timed from `from` to `to`. */
  count(name, from = -Infinity, to = Infinity) {
    const stream = this.#streams.get(name);
    if (from === -Infinity && to === Infinity) return stream.samples;
    let count = 0;
    for (const block of this.#blocksOf(stream)) {
      for (let offset = 0; offset < block.length; offset += stream.width) if (block[offset] >= from && block[offset] <= to) count += 1;
    }
    return count;
  }

  get total() {
    let total = 0;
    for (const stream of this.#streams.values()) total += stream.samples;
    return total;
  }

  /** Timestamps of the first and the last sample of a stream, of all or of those from `from` to `to`; null when there are none. */
  range(name, from = -Infinity, to = Infinity) {
    const stream = this.#streams.get(name);
    const blocks = this.#blocksOf(stream);
    if (!blocks.length) return null;
    if (from === -Infinity && to === Infinity) {
      const tail = blocks.at(-1);
      return [blocks[0][0], tail[tail.length - stream.width]];
    }
    let first = null;
    let last = null;
    for (const block of blocks) {
      for (let offset = 0; offset < block.length; offset += stream.width) {
        const time = block[offset];
        if (time < from || time > to) continue;
        first ??= time;
        last = time;
      }
    }
    return first === null ? null : [first, last];
  }

  /** Timestamps of the first and the last sample over all streams, or null when there are none. */
  span() {
    const ranges = this.names.map((name) => this.range(name)).filter(Boolean);
    if (!ranges.length) return null;
    return [Math.min(...ranges.map(([first]) => first)), Math.max(...ranges.map(([, last]) => last))];
  }

  /**
   * The stream as one table for replay: `{ columns, data }` with the
   * timestamp as the first column and the samples one after another in
   * `data`, or null when it has no samples.
   */
  table(name) {
    const stream = this.#streams.get(name);
    if (!stream.samples) return null;
    const data = new Float64Array(stream.samples * stream.width);
    let offset = 0;
    for (const block of stream.pending.length ? [...stream.blocks, stream.pending] : stream.blocks) {
      data.set(block, offset);
      offset += block.length;
    }
    return { columns: ['timestamp_ms', ...stream.columns], data };
  }

  /** The stream as CSV text, all of it or the samples timed from `from` to `to`, or null when there are none. */
  csv(name, from = -Infinity, to = Infinity) {
    const stream = this.#streams.get(name);
    if (!stream.samples) return null;
    const { width, digits } = stream;
    const lines = [`timestamp_ms,${stream.columns.join(',')}`];
    for (const block of this.#blocksOf(stream)) {
      for (let offset = 0; offset < block.length; offset += width) {
        if (block[offset] < from || block[offset] > to) continue;
        // Timestamps keep a tenth of a millisecond, which is what the browser gives.
        let line = block[offset].toFixed(1);
        for (let i = 1; i < width; i += 1) {
          const value = block[offset + i];
          line += Number.isNaN(value) ? ',' : `,${Number(value.toFixed(digits[i - 1]))}`;
        }
        lines.push(line);
      }
    }
    return lines.length > 1 ? `${lines.join('\r\n')}\r\n` : null;
  }

  clear() {
    for (const stream of this.#streams.values()) {
      stream.pending = [];
      stream.blocks = [];
      stream.samples = 0;
    }
  }
}

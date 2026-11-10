// Polling loop on top of the ELM327 driver (port of obd_main.py from raspberry-unicore).

import { ELM327Error } from './elm327.js';
import { FAST_PIDS, PIDS, SLOW_PIDS } from './pids.js';

export const SLOW_INTERVAL_MS = 1000;
// The driver is watching the screen, so the wait between attempts stays short.
export const RECONNECT_MAX_MS = 8000;
// A few seconds of "NO DATA" means ignition off or the adapter lost the bus.
export const MAX_EMPTY_POLLS = 20;
// The diagnostic log keeps the first polls of a connection in full, then only problems.
export const QUIET_AFTER_POLLS = 20;
export const SUMMARY_INTERVAL_MS = 30000;

const COLUMNS = [...FAST_PIDS, ...SLOW_PIDS];

/** PIDs as the two-digit hex numbers used in OBD documentation: "04 05 0C". */
export const pidList = (pids) => pids.map((pid) => pid.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** One adapter session: fast PIDs every cycle, slow PIDs round robin. */
export class OBDPoller {
  constructor(elm, { clock = Date.now, slowIntervalMs = SLOW_INTERVAL_MS } = {}) {
    this.elm = elm;
    this.clock = clock;
    this.slowIntervalMs = slowIntervalMs;
    this.fast = [];
    this.slow = [];
    this.slowIndex = 0;
    this.lastSlow = -Infinity;
    this.emptyPolls = 0;
  }

  async connect() {
    await this.elm.connect();
    this.fast = FAST_PIDS.filter((pid) => this.elm.supported.has(pid));
    this.slow = SLOW_PIDS.filter((pid) => this.elm.supported.has(pid));
    this.slowIndex = 0;
    this.lastSlow = -Infinity;
    this.emptyPolls = 0;
  }

  supportedFields() {
    return [...this.fast, ...this.slow].map((pid) => PIDS.get(pid).name);
  }

  /** Read one row: [timestamp_ms, value per column in FIELDS order (null if missing)]. */
  async poll() {
    const start = this.clock();
    const values = this.fast.length ? await this.elm.query(this.fast) : new Map();
    if (this.slow.length && start - this.lastSlow >= this.slowIntervalMs) {
      const pid = this.slow[this.slowIndex % this.slow.length];
      this.slowIndex += 1;
      this.lastSlow = start;
      for (const [key, value] of await this.elm.query([pid])) values.set(key, value);
    }
    const end = this.clock();
    this.emptyPolls = values.size ? 0 : this.emptyPolls + 1;
    if (this.emptyPolls >= MAX_EMPTY_POLLS) {
      throw new ELM327Error(`no data for ${MAX_EMPTY_POLLS} polls (ignition off?)`);
    }
    // Middle of the request: the values were sampled somewhere in between.
    const timestampMs = Math.round((start + end) / 2);
    return [timestampMs, ...COLUMNS.map((pid) => values.get(pid) ?? null)];
  }
}

/** Sleep that ends early when the signal aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Keep an adapter session alive until `signal` aborts, reconnecting with backoff.
 * `sink(row)` gets every row, `status(info)` gets phase changes and a periodic rate.
 * `trace` (optional) records the adapter conversation and what happened to the session.
 */
export async function run(
  makeElm,
  {
    signal,
    sink,
    status = () => {},
    statusIntervalMs = 1000,
    summaryIntervalMs = SUMMARY_INTERVAL_MS,
    sleep = abortableSleep,
    now = () => performance.now(),
    clock = Date.now,
    trace = null,
  } = {},
) {
  let backoffMs = 1000;
  const stats = {
    rows: 0,
    errors: 0,
    connected: false,
    elmVersion: '',
    protocol: '',
    voltage: '',
    fields: [],
    pids: [],
    lastError: '',
    requestMs: null,
  };
  let lastStatus = now();
  let rowsSinceStatus = 0;

  const report = (phase) => {
    const time = now();
    const elapsedMs = Math.max(time - lastStatus, 1);
    status({
      phase,
      adapterConnected: stats.connected,
      elmVersion: stats.elmVersion,
      protocol: stats.protocol,
      voltage: stats.voltage,
      supportedFields: stats.fields,
      supportedPids: stats.pids,
      rateHz: Math.round((rowsSinceStatus * 10000) / elapsedMs) / 10,
      requestMs: stats.requestMs,
      rows: stats.rows,
      errors: stats.errors,
      lastError: stats.lastError,
    });
    lastStatus = time;
    rowsSinceStatus = 0;
  };

  while (!signal.aborted) {
    const elm = makeElm();
    if (trace) {
      elm.trace ??= trace;
      trace.quiet = false;
      trace.note('connecting');
    }
    const poller = new OBDPoller(elm, { clock });
    // Closing the transport breaks a pending read, so disconnecting is immediate.
    const onAbort = () => {
      elm.close().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    report('connecting');
    try {
      await poller.connect();
      Object.assign(stats, {
        connected: true,
        elmVersion: elm.version,
        protocol: elm.protocol,
        voltage: elm.voltage,
        fields: poller.supportedFields(),
        pids: [...elm.supported].sort((a, b) => a - b),
        requestMs: null,
      });
      trace?.note(
        `connected: ${elm.version || 'unknown adapter'}, protocol ${elm.protocol || 'unknown'}, ` +
          `${elm.voltage || 'voltage unknown'}, signals: ${stats.fields.join(' ') || 'none'}`,
      );
      // Everything the car offers, not only what this app reads: the answer to "can it give X?".
      trace?.note(`the car reports ${stats.pids.length} mode 01 PIDs: ${pidList(stats.pids) || 'none'}`);
      backoffMs = 1000;
      report('connected');

      // Request time is measured over the polling only; the slow setup would skew it.
      const setup = { ...elm.stats };
      const requestMs = () => {
        const requests = elm.stats.requests - setup.requests;
        return requests > 0 ? Math.round((elm.stats.busyMs - setup.busyMs) / requests) : null;
      };
      let polls = 0;
      let summaryAt = now();
      let summaryRows = 0;
      while (!signal.aborted) {
        const row = await poller.poll();
        if (signal.aborted) break;
        sink(row);
        stats.rows += 1;
        rowsSinceStatus += 1;
        summaryRows += 1;
        polls += 1;
        stats.requestMs = requestMs();
        if (trace && polls === QUIET_AFTER_POLLS) {
          trace.note('polling is steady: from here only problems are logged, with the exchanges before them');
          trace.quiet = true;
        }
        if (trace && now() - summaryAt >= summaryIntervalMs) {
          const seconds = (now() - summaryAt) / 1000;
          trace.note(`${summaryRows} rows in ${seconds.toFixed(0)} s (${(summaryRows / seconds).toFixed(1)}/s), ${stats.requestMs} ms per request`);
          summaryAt = now();
          summaryRows = 0;
        }
        if (now() - lastStatus >= statusIntervalMs) report('connected');
        if (!poller.fast.length) await sleep(500, signal); // nothing fast to read: do not spin
      }
    } catch (error) {
      if (!signal.aborted) {
        stats.errors += 1;
        stats.lastError = error?.message || String(error);
        trace?.problem(stats.lastError);
        // A lost link is expected and only reported in the status; a bug should be loud.
        if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
          console.error('OBD session failed:', error);
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      await elm.close().catch(() => {});
      stats.connected = false;
    }
    if (signal.aborted) break;
    report('reconnecting');
    trace?.note(`next attempt in ${backoffMs / 1000} s`);
    await sleep(backoffMs, signal);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }
  if (trace) {
    trace.quiet = false;
    trace.note(`stopped after ${stats.rows} rows and ${stats.errors} problems`);
  }
  report('idle');
}

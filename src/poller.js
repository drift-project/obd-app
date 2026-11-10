// Polling loop on top of the ELM327 driver (port of obd_main.py from raspberry-unicore).

import { RUNNING_RPM } from './battery.js';
import { ELM327Error } from './elm327.js';
import { FAST_PIDS, PIDS, SLOW_PIDS, VOLTAGE_FIELD } from './pids.js';

export const SLOW_INTERVAL_MS = 1000;
// With the engine running the battery voltage changes slowly. With it off the
// voltage is read on every row, so the sag under the starter is not missed.
export const VOLTAGE_INTERVAL_MS = 5000;
// Read for drifting, the engine temperature and the voltage come this often: enough to see the
// engine get hot, and nearly all requests are left for the wheels, the driver's foot and the revs.
export const DRIFT_SLOW_INTERVAL_MS = 10000;
// The driver is watching the screen, so the wait between attempts stays short.
export const RECONNECT_MAX_MS = 8000;
// A few seconds of "NO DATA" means ignition off or the adapter lost the bus.
export const MAX_EMPTY_POLLS = 20;
// The diagnostic log keeps the first polls of a connection in full, then only problems.
export const QUIET_AFTER_POLLS = 20;
export const SUMMARY_INTERVAL_MS = 30000;

const COLUMNS = [...FAST_PIDS, ...SLOW_PIDS];
const RPM = 0x0c;
const SPEED = 0x0d;
const THROTTLE = 0x11;
const PEDAL = 0x49;
const COOLANT = 0x05;

/** PIDs as the two-digit hex numbers used in OBD documentation: "04 05 0C". */
export const pidList = (pids) => pids.map((pid) => pid.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * One adapter session: fast PIDs every cycle, slow PIDs round robin.
 *
 * `mode()` says what the readings are for and is asked on every cycle: 'all'
 * reads everything the car has, 'drift' gives the requests to what a drift is
 * judged by. That matters where every value is a request of its own (a
 * K-line car answers about four a second): the speed of the wheels is then
 * read twice a cycle, the driver's foot and the revs once, and of the slow
 * values only the engine temperature, every ten seconds.
 */
export class OBDPoller {
  constructor(elm, { clock = Date.now, slowIntervalMs = SLOW_INTERVAL_MS, mode = () => 'all' } = {}) {
    this.elm = elm;
    this.clock = clock;
    this.slowIntervalMs = slowIntervalMs;
    this.mode = mode;
    this.fast = [];
    this.slow = [];
    this.slowIndex = 0;
    this.lastSlow = -Infinity;
    this.lastVoltage = -Infinity;
    this.hasVoltage = false;
    this.emptyPolls = 0;
  }

  async connect() {
    await this.elm.connect();
    this.fast = FAST_PIDS.filter((pid) => this.elm.supported.has(pid));
    this.slow = SLOW_PIDS.filter((pid) => this.elm.supported.has(pid));
    this.slowIndex = 0;
    this.lastSlow = -Infinity;
    this.lastVoltage = -Infinity;
    // An adapter that could not tell its voltage while connecting is not asked again.
    this.hasVoltage = Boolean(this.elm.voltage);
    this.emptyPolls = 0;
  }

  supportedFields() {
    const fields = [...this.fast, ...this.slow].map((pid) => PIDS.get(pid).name);
    return this.hasVoltage ? [...fields, VOLTAGE_FIELD] : fields;
  }

  /** What one cycle asks for where every value is a request of its own. */
  singles(drift) {
    if (!drift) return this.fast;
    // Where the car tells the pedal, that is the driver's foot; the throttle plate is the next best thing.
    const foot = this.fast.includes(PEDAL) ? PEDAL : THROTTLE;
    return [SPEED, foot, SPEED, RPM].filter((pid) => this.fast.includes(pid));
  }

  /**
   * Read one cycle and return its rows, each [timestamp_ms, value per column
   * in FIELDS order (null if missing)].
   *
   * Where the car answers several PIDs in one request (CAN), a cycle is short
   * and gives one row. Where every value is a request of its own (K-line), a
   * cycle takes most of a second, so each value gets a row of its own with the
   * time of its own request.
   */
  async poll() {
    const rows = [];
    const seen = new Map();
    const row = (time, values, volts = null) => [Math.round(time), ...COLUMNS.map((pid) => values.get(pid) ?? null), volts];
    // Unknown until the first request with several PIDs has been answered: then it is tried, not assumed.
    const single = this.elm.multiPidWorks === false;
    // A value was sampled somewhere between its request and its answer: the middle is the best guess.
    const timed = async (read) => {
      const start = this.clock();
      const result = await read();
      return [result, (start + this.clock()) / 2];
    };
    const query = async (pids) => {
      const [values, time] = await timed(() => this.elm.query(pids));
      for (const [pid, value] of values) seen.set(pid, value);
      if (single && values.size) rows.push(row(time, values));
    };

    const drift = this.mode() === 'drift';
    const cycleStart = this.clock();
    if (single) for (const pid of this.singles(drift)) await query([pid]);
    else if (this.fast.length) await query(this.fast);
    const slow = drift ? this.slow.filter((pid) => pid === COOLANT) : this.slow;
    if (slow.length && cycleStart - this.lastSlow >= (drift ? DRIFT_SLOW_INTERVAL_MS : this.slowIntervalMs)) {
      const pid = slow[this.slowIndex % slow.length];
      this.slowIndex += 1;
      this.lastSlow = cycleStart;
      await query([pid]);
    }
    let volts = null;
    if (this.hasVoltage) {
      const rpm = seen.get(RPM);
      const running = rpm !== undefined && rpm >= RUNNING_RPM;
      const interval = !running ? 0 : drift ? DRIFT_SLOW_INTERVAL_MS : VOLTAGE_INTERVAL_MS;
      if (cycleStart - this.lastVoltage >= interval) {
        this.lastVoltage = cycleStart;
        const [reading, time] = await timed(() => this.elm.readVoltage());
        volts = reading;
        if (single && volts !== null) rows.push(row(time, new Map(), volts));
      }
    }
    this.emptyPolls = seen.size ? 0 : this.emptyPolls + 1;
    if (this.emptyPolls >= MAX_EMPTY_POLLS) {
      throw new ELM327Error(`no data for ${MAX_EMPTY_POLLS} polls (ignition off?)`);
    }
    if (!single) rows.push(row((cycleStart + this.clock()) / 2, seen, volts));
    return rows;
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
 * `mode()` is 'all' or 'drift', see OBDPoller.
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
    mode = () => 'all',
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
    const poller = new OBDPoller(elm, { clock, mode });
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
        const rows = await poller.poll();
        if (signal.aborted) break;
        for (const row of rows) sink(row);
        stats.rows += rows.length;
        rowsSinceStatus += rows.length;
        summaryRows += rows.length;
        polls += 1;
        stats.requestMs = requestMs();
        stats.voltage = elm.voltage;
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

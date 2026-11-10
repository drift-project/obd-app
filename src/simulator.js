// ELM327 simulator: behaves like an adapter plugged into a car doing drift runs.
// Used by the tests and by the app's demo mode (port of ELM327Simulator.py).

import { PIDS, SUPPORT_PIDS } from './pids.js';

const VERSION = 'ELM327 v1.5';
const CAN_PROTOCOLS = new Set(['6', '7', '8', '9', 'A', 'B', 'C']);
const SLOW_INIT_PROTOCOLS = new Set(['3', '4']);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pctByte = (percent) => [Math.round((clamp(percent, 0, 100) * 255) / 100)];
const word = (value) => [value >> 8, value & 0xff];
const hex = (byte) => byte.toString(16).toUpperCase().padStart(2, '0');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A turn of the event loop without waiting for a timer tick (coarse on Windows).
const nextTask = () =>
  new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));

/**
 * Answers AT commands and mode 01 requests with a synthetic drift session.
 *
 * `busProtocol` is the protocol the car speaks (ATSP number; null = the car is
 * silent, as with the ignition off). `autoSearch: false` makes the automatic
 * search miss the car, as some adapters do on K-line cars. `searchHangs` makes
 * the automatic search print no prompt until it is interrupted. `rejected`
 * lists AT commands (without "AT") a clone answers with "?". `gearbox` lists
 * PIDs of a second ECU that answers before the engine. `voltage` is what the
 * adapter measures at the socket: a number of volts or a function giving one.
 * `rpm` fixes the engine speed (0 is an engine that is off) instead of the
 * drift run.
 */
export class ELM327Simulator {
  constructor({
    supported,
    multiPid = true,
    responseCount = true,
    noData = [],
    busProtocol = '6',
    autoSearch = true,
    searchHangs = false,
    rejected = [],
    gearbox = null,
    voltage = 12.6,
    rpm = null,
    clock = () => performance.now() / 1000,
  } = {}) {
    this.supported = new Set(supported ?? PIDS.keys());
    this.multiPid = multiPid;
    this.responseCount = responseCount;
    this.noData = new Set(noData);
    this.busProtocol = busProtocol;
    this.autoSearch = autoSearch;
    this.searchHangs = searchHangs;
    this.rejected = new Set(rejected);
    this.gearbox = gearbox ? new Set(gearbox) : null;
    this.voltage = voltage;
    this.rpm = rpm;
    this.clock = clock;
    this.start = clock();
    this.requests = [];
    this.#reset();
  }

  #reset() {
    this.echo = true;
    this.spaces = true;
    this.selected = '0'; // ATSP number; 0 = automatic search
    this.connected = false;
    this.busy = false;
  }

  // Car model ---------------------------------------------------------------

  valueBytes(pid) {
    if (SUPPORT_PIDS.includes(pid)) return this.#supportBitmap(pid, this.supported);
    const t = this.clock() - this.start;
    const wave = Math.sin(1.1 * t);
    switch (pid) {
      case 0x0c: // rpm, oscillating like throttle steering in a drift
        return word(Math.round((this.rpm ?? 5200 + 1300 * wave) * 4));
      case 0x0d:
        return [Math.round(45 + 12 * Math.sin(0.4 * t))];
      case 0x11:
        return pctByte(55 + 40 * Math.sin(1.1 * t + 0.4));
      case 0x49:
        return pctByte(50 + 45 * Math.sin(1.1 * t + 0.3));
      case 0x04:
        return pctByte(60 + 25 * wave);
      case 0x05:
        return [92 + 40];
      case 0x0f:
        return [28 + 40];
      case 0x10:
        return word(Math.round((40 + 25 * wave) * 100));
      case 0x0b:
        return [Math.round(clamp(100 + 60 * wave, 0, 255))];
      case 0x5c: // oil, warm after a few runs
        return [108 + 40];
      case 0x46:
        return [14 + 40];
      case 0x3c: // catalyst, in tenths of a degree above -40
        return word((640 + 40) * 10);
      default:
        throw new RangeError(`no simulated value for PID ${hex(pid)}`);
    }
  }

  #supportBitmap(base, supported) {
    const bytes = [0, 0, 0, 0];
    const higherExists = [...supported].some((pid) => pid > base + 32);
    for (let offset = 1; offset <= 32; offset += 1) {
      const set = supported.has(base + offset) || (offset === 32 && higherExists);
      if (set) bytes[(offset - 1) >> 3] |= 0x80 >> ((offset - 1) & 7);
    }
    return bytes;
  }

  // Protocol ------------------------------------------------------------------

  /** Return the full adapter output for one command, ending with the prompt. */
  handle(rawCommand) {
    const command = rawCommand.trim().toUpperCase().replaceAll(' ', '');
    this.requests.push(command);
    if (this.busy) {
      // Any input stops a running search; the interrupting command itself is lost.
      this.busy = false;
      return 'STOPPED\r\r>';
    }
    const answer = this.#answer(command);
    const echo = this.echo ? `${rawCommand.trim()}\r` : '';
    if (this.busy) return `${echo}${answer}`; // no prompt: the adapter keeps searching
    return `${echo}${answer}\r\r>`;
  }

  #answer(command) {
    if (command.startsWith('AT')) return this.#at(command.slice(2));
    if (command.startsWith('01') && command.length >= 4) return this.#mode01(command.slice(2));
    return '?';
  }

  #at(command) {
    if (command === 'Z') {
      this.#reset();
      return `\r${VERSION}`;
    }
    if (this.rejected.has(command)) return '?';
    if (command === 'I') return VERSION;
    if (command === '@1') return 'OBDII to RS232 Interpreter';
    if (command === 'E0' || command === 'E1') {
      this.echo = command === 'E1';
      return 'OK';
    }
    if (command === 'S0' || command === 'S1') {
      this.spaces = command === 'S1';
      return 'OK';
    }
    if (command.startsWith('SP')) {
      this.selected = command.slice(-1);
      this.connected = false;
      return 'OK';
    }
    if (['L0', 'L1', 'H0', 'H1', 'AT0', 'AT1', 'AT2'].includes(command) || command.startsWith('ST')) return 'OK';
    if (command === 'DPN') {
      if (this.selected !== '0') return this.selected;
      return `A${this.connected ? this.busProtocol : '0'}`;
    }
    if (command === 'RV') return `${Number(typeof this.voltage === 'function' ? this.voltage() : this.voltage).toFixed(1)}V`;
    return '?';
  }

  /** Bring the bus up as the selected protocol allows: progress text to print, or the adapter's error. */
  #openBus() {
    if (this.connected) return { prefix: '' };
    if (this.selected === '0') {
      if (this.searchHangs) {
        this.busy = true;
        return { error: 'SEARCHING...' };
      }
      if (this.busProtocol === null || !this.autoSearch) return { error: 'SEARCHING...\rUNABLE TO CONNECT' };
      this.connected = true;
      return { prefix: 'SEARCHING...\r' };
    }
    const slowInit = SLOW_INIT_PROTOCOLS.has(this.selected);
    if (this.selected !== this.busProtocol) {
      if (slowInit) return { error: 'BUS INIT: ...ERROR' };
      if (this.selected === '5') return { error: 'BUS INIT: ERROR' };
      return { error: CAN_PROTOCOLS.has(this.selected) ? 'CAN ERROR' : 'NO DATA' };
    }
    this.connected = true;
    if (slowInit) return { prefix: 'BUS INIT: ...OK\r' };
    return { prefix: this.selected === '5' ? 'BUS INIT: OK\r' : '' };
  }

  #mode01(rawBody) {
    let body = rawBody;
    let wanted = Infinity;
    if (body.length % 2 === 1) {
      // trailing response count digit, e.g. "0C1": stop after that many answers
      if (!this.responseCount) return '?';
      wanted = parseInt(body.at(-1), 16);
      body = body.slice(0, -1);
    }
    if (!/^[0-9A-F]+$/.test(body)) return '?';
    const bus = this.#openBus();
    if (bus.error) return bus.error;
    let pids = [];
    for (let i = 0; i < body.length; i += 2) pids.push(parseInt(body.slice(i, i + 2), 16));
    // Several PIDs in one request exist only on CAN; a K-line ECU answers the first.
    if (!this.multiPid || !CAN_PROTOCOLS.has(this.busProtocol)) pids = pids.slice(0, 1);
    const answers = [];
    const second = this.#gearboxAnswer(pids[0]);
    if (second) answers.push(second);
    const payload = [0x41];
    for (const pid of pids) {
      const known = SUPPORT_PIDS.includes(pid) || this.supported.has(pid);
      if (!known || this.noData.has(pid)) continue;
      payload.push(pid, ...this.valueBytes(pid));
    }
    if (payload.length > 1) answers.push(payload);
    if (!answers.length) return `${bus.prefix}NO DATA`;
    return bus.prefix + answers.slice(0, wanted).map((answer) => this.#format(answer)).join('\r');
  }

  /** The second ECU has its own, much shorter, list of PIDs and answers before the engine. */
  #gearboxAnswer(pid) {
    if (!this.gearbox) return null;
    if (SUPPORT_PIDS.includes(pid)) {
      if (pid !== 0 && ![...this.gearbox].some((supported) => supported > pid)) return null;
      return [0x41, pid, ...this.#supportBitmap(pid, this.gearbox)];
    }
    return this.gearbox.has(pid) ? [0x41, pid, ...this.valueBytes(pid)] : null;
  }

  #format(payload) {
    const separator = this.spaces ? ' ' : '';
    const hexBytes = (chunk) => chunk.map(hex).join(separator);
    if (payload.length <= 7) return hexBytes(payload);
    // ISO-TP multi-frame answer as the ELM327 prints it with headers off.
    const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0'), `0:${separator}${hexBytes(payload.slice(0, 6))}`];
    for (let offset = 6, index = 1; offset < payload.length; offset += 7, index += 1) {
      lines.push(`${(index % 16).toString(16).toUpperCase()}:${separator}${hexBytes(payload.slice(offset, offset + 7))}`);
    }
    return lines.join('\r');
  }
}

/** In-process transport to a simulator, for tests and the demo mode. */
export class LoopbackTransport {
  constructor(simulator, { latencyMs = 0 } = {}) {
    this.simulator = simulator;
    this.latencyMs = latencyMs;
    this.opened = false;
    this.incoming = '';
    this.outgoing = '';
  }

  async open() {
    this.opened = true;
    this.incoming = '';
    this.outgoing = '';
  }

  async close() {
    this.opened = false;
  }

  async write(text) {
    this.#assertOpen();
    this.incoming += text;
    while (this.incoming.includes('\r')) {
      const end = this.incoming.indexOf('\r');
      const command = this.incoming.slice(0, end);
      this.incoming = this.incoming.slice(end + 1);
      // Always yields to the event loop, like a real link does.
      await (this.latencyMs > 0 ? sleep(this.latencyMs) : nextTask());
      this.#assertOpen();
      this.outgoing += this.simulator.handle(command);
    }
  }

  async read(timeoutMs) {
    this.#assertOpen();
    const data = this.outgoing;
    this.outgoing = '';
    if (!data && timeoutMs > 0) await sleep(Math.min(timeoutMs, 10));
    return data;
  }

  #assertOpen() {
    if (!this.opened) throw new Error('adapter connection lost: transport is closed');
  }
}

// ELM327 simulator: behaves like an adapter plugged into a car doing drift runs.
// Used by the tests and by the app's demo mode (port of ELM327Simulator.py).

import { PIDS, SUPPORT_PIDS } from './pids.js';

const VERSION = 'ELM327 v1.5';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pctByte = (percent) => [Math.round((clamp(percent, 0, 100) * 255) / 100)];
const word = (value) => [value >> 8, value & 0xff];
const hex = (byte) => byte.toString(16).toUpperCase().padStart(2, '0');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A turn of the event loop without waiting for a timer tick (coarse on Windows).
const nextTask = () =>
  new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));

/** Answers AT commands and mode 01 requests with a synthetic drift session. */
export class ELM327Simulator {
  constructor({ supported, multiPid = true, responseCount = true, noData = [], clock = () => performance.now() / 1000 } = {}) {
    this.supported = new Set(supported ?? PIDS.keys());
    this.multiPid = multiPid;
    this.responseCount = responseCount;
    this.noData = new Set(noData);
    this.clock = clock;
    this.start = clock();
    this.requests = [];
    this.#reset();
  }

  #reset() {
    this.echo = true;
    this.spaces = true;
    this.searched = false;
  }

  // Car model ---------------------------------------------------------------

  valueBytes(pid) {
    if (SUPPORT_PIDS.includes(pid)) return this.#supportBitmap(pid);
    const t = this.clock() - this.start;
    const wave = Math.sin(1.1 * t);
    switch (pid) {
      case 0x0c: // rpm, oscillating like throttle steering in a drift
        return word(Math.round((5200 + 1300 * wave) * 4));
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
      default:
        throw new RangeError(`no simulated value for PID ${hex(pid)}`);
    }
  }

  #supportBitmap(base) {
    const bytes = [0, 0, 0, 0];
    const higherExists = [...this.supported].some((pid) => pid > base + 32);
    for (let offset = 1; offset <= 32; offset += 1) {
      const set = this.supported.has(base + offset) || (offset === 32 && higherExists);
      if (set) bytes[(offset - 1) >> 3] |= 0x80 >> ((offset - 1) & 7);
    }
    return bytes;
  }

  // Protocol ------------------------------------------------------------------

  /** Return the full adapter output for one command, ending with the prompt. */
  handle(rawCommand) {
    const command = rawCommand.trim().toUpperCase().replaceAll(' ', '');
    this.requests.push(command);
    const answer = this.#answer(command);
    const echo = this.echo ? `${rawCommand.trim()}\r` : '';
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
    if (command === 'I') return VERSION;
    if (command === 'E0' || command === 'E1') {
      this.echo = command === 'E1';
      return 'OK';
    }
    if (command === 'S0' || command === 'S1') {
      this.spaces = command === 'S1';
      return 'OK';
    }
    if (['L0', 'L1', 'H0', 'H1', 'AT0', 'AT1', 'AT2'].includes(command) || command.startsWith('SP') || command.startsWith('ST')) {
      return 'OK';
    }
    if (command === 'DPN') return 'A6';
    if (command === 'RV') return '12.6V';
    return '?';
  }

  #mode01(rawBody) {
    let body = rawBody;
    if (body.length % 2 === 1) {
      // trailing response count digit, e.g. "0C1"
      if (!this.responseCount) return '?';
      body = body.slice(0, -1);
    }
    if (!/^[0-9A-F]+$/.test(body)) return '?';
    let pids = [];
    for (let i = 0; i < body.length; i += 2) pids.push(parseInt(body.slice(i, i + 2), 16));
    if (!this.multiPid) pids = pids.slice(0, 1);
    const payload = [0x41];
    for (const pid of pids) {
      const known = SUPPORT_PIDS.includes(pid) || this.supported.has(pid);
      if (!known || this.noData.has(pid)) continue;
      payload.push(pid, ...this.valueBytes(pid));
    }
    const prefix = this.searched ? '' : 'SEARCHING...\r';
    this.searched = true;
    return prefix + (payload.length === 1 ? 'NO DATA' : this.#format(payload));
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

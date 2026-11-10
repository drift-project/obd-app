// ELM327 OBD-II adapter driver (port of ELM327.py from raspberry-unicore).
//
// Works on top of a transport with four async methods:
//   open(), close(), write(text), read(timeoutMs) -> text that arrived (may be '').
// The adapter protocol is plain ASCII, so the transport deals in strings.

import { PIDS, SUPPORT_PIDS, decodeSupported, responseLength } from './pids.js';

const PROMPT = '>';
const MAX_PIDS_PER_REQUEST = 6;

// Answers that mean the request failed. Spaces are removed before comparing.
const TRANSIENT_ERRORS = new Set(['STOPPED', 'BUFFERFULL', 'BUSBUSY', 'DATAERROR', 'CANERROR', 'BUSERROR', 'FBERROR']);
const FATAL_ERRORS = new Set(['UNABLETOCONNECT', 'ACTALERT', 'LVRESET', '?']);

const HEX = /^[0-9A-F]+$/;
const FRAME = /^([0-9A-F]):([0-9A-F]*)$/;
const BYTE_COUNT = /^[0-9A-F]{3}$/;

/** Base class for adapter problems; the caller reconnects on these. */
export class ELM327Error extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** No prompt from the adapter in time: the link is probably gone. */
export class ELM327Timeout extends ELM327Error {}

/** The adapter answered with an error such as '?' or 'UNABLE TO CONNECT'. */
export class ELM327ResponseError extends ELM327Error {
  constructor(code, command) {
    super(`${command}: ${code}`);
    this.code = code;
    this.command = command;
  }

  get transient() {
    return TRANSIENT_ERRORS.has(this.code);
  }
}

// --- Response parsing ----------------------------------------------------------

const compact = (text) => text.replaceAll(' ', '').toUpperCase();

/** Split raw adapter output (without the prompt) into lines, dropping the echo. */
export function splitResponse(raw, command) {
  const lines = raw
    .replaceAll('\0', '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length && compact(lines[0]) === compact(command)) lines.shift();
  return lines;
}

function normalize(lines) {
  const out = [];
  for (const line of lines) {
    const text = compact(line);
    if (!text || text.startsWith('SEARCHING')) continue;
    // "BUS INIT: ...OK" is progress output; "...ERROR" must stay visible.
    if (text.startsWith('BUSINIT') && !text.endsWith('ERROR')) continue;
    out.push(text);
  }
  return out;
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Group answer lines into messages: single-frame lines or multi-frame (ISO-TP) blocks. */
function messages(lines) {
  const out = [];
  let expected = null;
  let frames = [];
  const flush = () => {
    if (expected !== null) {
      const hex = frames.join('');
      if (hex.length % 2 === 0) out.push(hexToBytes(hex).slice(0, expected));
    }
    expected = null;
    frames = [];
  };
  for (const line of lines) {
    const frame = FRAME.exec(line);
    if (BYTE_COUNT.test(line)) {
      flush();
      expected = parseInt(line, 16);
    } else if (frame && expected !== null) {
      frames.push(frame[2]);
    } else {
      flush();
      if (HEX.test(line) && line.length % 2 === 0) out.push(hexToBytes(line));
    }
  }
  flush();
  return out;
}

/** Split one '41 pid data [pid data ...]' message into raw bytes per PID. */
function parseMode01Message(data) {
  const out = new Map();
  if (data.length < 2 || data[0] !== 0x41) return out;
  let i = 1;
  while (i < data.length) {
    const pid = data[i];
    const length = responseLength(pid);
    if (length === undefined) break;
    const chunk = data.slice(i + 1, i + 1 + length);
    if (chunk.length < length) break;
    if (!out.has(pid)) out.set(pid, chunk);
    i += 1 + length;
  }
  return out;
}

/** Parse a mode 01 answer into Map(pid -> raw data bytes). 'NO DATA' gives an empty map. */
export function parseMode01(lines, command = '01') {
  const normalized = normalize(lines);
  for (const line of normalized) {
    if (line === 'NODATA') return new Map();
    if (TRANSIENT_ERRORS.has(line) || FATAL_ERRORS.has(line) || line.endsWith('ERROR')) {
      throw new ELM327ResponseError(line, command);
    }
  }
  const result = new Map();
  for (const message of messages(normalized)) {
    for (const [pid, data] of parseMode01Message(message)) {
      if (!result.has(pid)) result.set(pid, data);
    }
  }
  return result;
}

// --- Adapter ---------------------------------------------------------------------

const hexPid = (pid) => pid.toString(16).toUpperCase().padStart(2, '0');

/** Mode 01 polling on top of an ELM327 adapter. */
export class ELM327 {
  static INIT_COMMANDS = [
    'ATE0', // no echo
    'ATL0', // no linefeeds
    'ATS0', // no spaces: shorter answers over a slow link
    'ATH0', // no CAN headers
    'ATAT1', // adaptive timing
    'ATSP0', // automatic protocol search
  ];

  constructor(transport, { timeoutMs = 2000, useResponseCount = true, allowMultiPid = true, now = () => performance.now() } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.useResponseCount = useResponseCount;
    this.allowMultiPid = allowMultiPid;
    this.now = now;
    this.version = '';
    this.protocol = '';
    this.supported = new Set();
    this.multiPidWorks = null;
  }

  // Connection --------------------------------------------------------------

  async connect() {
    await this.transport.open();
    try {
      await this.#initialize();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    await this.transport.close();
  }

  async #initialize() {
    await this.send('ATZ', 5000);
    const version = await this.send('ATI');
    this.version = version.at(-1) ?? '';
    for (const command of ELM327.INIT_COMMANDS) {
      const answer = await this.send(command);
      if (!answer.some((line) => line.toUpperCase().includes('OK'))) {
        throw new ELM327ResponseError(answer.join(' ') || 'no answer', command);
      }
    }
    // The first request starts the protocol search, which can take several seconds.
    this.supported = await this.#readSupported(15000);
    const protocol = await this.send('ATDPN');
    this.protocol = protocol.at(-1) ?? '';
  }

  async #readSupported(firstTimeoutMs) {
    const supported = new Set();
    for (const [index, base] of SUPPORT_PIDS.entries()) {
      if (index > 0 && !supported.has(base)) break;
      const raw = await this.#request([base], index === 0 ? firstTimeoutMs : undefined);
      if (!raw.has(base)) {
        if (index === 0) throw new ELM327ResponseError('NO DATA', '0100');
        break;
      }
      for (const pid of decodeSupported(base, raw.get(base))) supported.add(pid);
    }
    return supported;
  }

  // Commands ------------------------------------------------------------------

  /** Send one command and return the answer lines (without echo and prompt). */
  async send(command, timeoutMs = this.timeoutMs) {
    await this.#drain();
    await this.transport.write(`${command}\r`);
    const raw = await this.#readUntilPrompt(timeoutMs, command);
    return splitResponse(raw, command);
  }

  /** Drop leftovers of an earlier, timed-out answer (bounded, in case the adapter streams). */
  async #drain() {
    for (let i = 0; i < 100; i += 1) {
      if (!(await this.transport.read(0))) break;
    }
  }

  async #readUntilPrompt(timeoutMs, command) {
    const deadline = this.now() + timeoutMs;
    let buffer = '';
    while (!buffer.includes(PROMPT)) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new ELM327Timeout(`${command}: no answer within ${(timeoutMs / 1000).toFixed(1)} s`);
      buffer += await this.transport.read(Math.min(remaining, 500));
    }
    return buffer.slice(0, buffer.indexOf(PROMPT));
  }

  async #request(pids, timeoutMs) {
    const command = `01${pids.map(hexPid).join('')}`;
    if (pids.length === 1 && this.useResponseCount) {
      // "1" = return after the first answer instead of waiting for more ECUs.
      try {
        return parseMode01(await this.send(`${command}1`, timeoutMs), `${command}1`);
      } catch (error) {
        if (!(error instanceof ELM327ResponseError) || error.code !== '?') throw error;
        this.useResponseCount = false; // older adapters reject the response count digit
      }
    }
    return parseMode01(await this.send(command, timeoutMs), command);
  }

  // Polling ---------------------------------------------------------------------

  /** Read and decode supported PIDs into Map(pid -> value). Unanswered PIDs are left out. */
  async query(pids) {
    const wanted = pids.filter((pid) => this.supported.has(pid));
    const raw = new Map();
    if (wanted.length > 1 && this.allowMultiPid && this.multiPidWorks !== false) {
      for (let start = 0; start < wanted.length; start += MAX_PIDS_PER_REQUEST) {
        const chunk = wanted.slice(start, start + MAX_PIDS_PER_REQUEST);
        let answer;
        try {
          answer = await this.#request(chunk);
        } catch (error) {
          if (!(error instanceof ELM327ResponseError) || error.code !== '?') throw error;
          answer = new Map();
        }
        if (this.multiPidWorks === null && chunk.length > 1) {
          // ECUs without multi-PID support answer only the first PID (or nothing).
          this.multiPidWorks = answer.size > 1;
        }
        for (const [pid, data] of answer) raw.set(pid, data);
      }
      // A PID missing from a working multi-PID answer simply had no data this cycle.
      if (this.multiPidWorks) return decode(raw);
    }
    for (const pid of wanted) {
      if (raw.has(pid)) continue;
      for (const [key, data] of await this.#request([pid])) raw.set(key, data);
    }
    return decode(raw);
  }
}

function decode(raw) {
  const values = new Map();
  for (const [pid, data] of raw) {
    if (PIDS.has(pid)) values.set(pid, PIDS.get(pid).decode(data));
  }
  return values;
}

// ELM327 OBD-II adapter driver (port of ELM327.py from raspberry-unicore).
//
// Works on top of a transport with four async methods:
//   open(), close(), write(text), read(timeoutMs) -> text that arrived (may be '').
// The adapter protocol is plain ASCII, so the transport deals in strings.

import { PIDS, SUPPORT_PIDS, decodeSupported, responseLength } from './pids.js';

const PROMPT = '>';
const MAX_PIDS_PER_REQUEST = 6;
const RESET_TIMEOUT_MS = 5000;
// The automatic search walks through every protocol, and one 5 baud init on a
// K-line car takes over two seconds, so the first request may take a while.
const SEARCH_TIMEOUT_MS = 20000;
const BUS_INIT_TIMEOUT_MS = 12000;

// Answers that mean the request failed. Spaces are removed before comparing.
const TRANSIENT_ERRORS = new Set(['STOPPED', 'BUFFERFULL', 'BUSBUSY', 'DATAERROR', 'CANERROR', 'BUSERROR', 'FBERROR']);
const FATAL_ERRORS = new Set(['UNABLETOCONNECT', 'ACTALERT', 'LVRESET', '?']);

const HEX = /^[0-9A-F]+$/;
const FRAME = /^([0-9A-F]):([0-9A-F]*)$/;
const BYTE_COUNT = /^[0-9A-F]{3}$/;

/** Protocol numbers of the ATSP command, as reported back by ATDPN. */
export const PROTOCOL_NAMES = {
  1: 'SAE J1850 PWM',
  2: 'SAE J1850 VPW',
  3: 'ISO 9141-2',
  4: 'ISO 14230-4 KWP (5 baud init)',
  5: 'ISO 14230-4 KWP (fast init)',
  6: 'CAN 11-bit, 500 kbaud',
  7: 'CAN 29-bit, 500 kbaud',
  8: 'CAN 11-bit, 250 kbaud',
  9: 'CAN 29-bit, 250 kbaud',
  A: 'SAE J1939 CAN',
};

// Only CAN (ISO 15765-4) lets one request carry several PIDs.
const CAN_PROTOCOLS = new Set(['6', '7', '8', '9', 'A', 'B', 'C']);

/** 'A3' (found by the automatic search) or '3' (set by hand) -> '3'. */
export const protocolNumber = (code) => (code ?? '').trim().toUpperCase().slice(-1);

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

/** The adapter works but no protocol got an answer: ignition off, a protocol the adapter lacks, or no OBD-II in the car. */
export class ELM327NoCarError extends ELM327Error {
  constructor(attempts) {
    super(`the car did not answer (${attempts.join('; ')})`);
    this.attempts = attempts;
  }
}

// --- Response parsing ----------------------------------------------------------

const compact = (text) => text.replaceAll(' ', '').toUpperCase();
const isOk = (lines) => lines.some((line) => line.toUpperCase().includes('OK'));
const pause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

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

/** Parse a mode 01 answer into one Map(pid -> raw data bytes) per answering ECU. 'NO DATA' gives none. */
export function parseMode01Messages(lines, command = '01') {
  const normalized = normalize(lines);
  for (const line of normalized) {
    if (line === 'NODATA') return [];
    if (TRANSIENT_ERRORS.has(line) || FATAL_ERRORS.has(line) || line.endsWith('ERROR')) {
      throw new ELM327ResponseError(line, command);
    }
  }
  return messages(normalized)
    .map(parseMode01Message)
    .filter((message) => message.size > 0);
}

/** Parse a mode 01 answer into Map(pid -> raw data bytes); the first ECU to answer a PID wins. */
export function parseMode01(lines, command = '01') {
  const result = new Map();
  for (const message of parseMode01Messages(lines, command)) {
    for (const [pid, data] of message) {
      if (!result.has(pid)) result.set(pid, data);
    }
  }
  return result;
}

// --- Adapter ---------------------------------------------------------------------

const hexPid = (pid) => pid.toString(16).toUpperCase().padStart(2, '0');

/** Mode 01 polling on top of an ELM327 adapter. */
export class ELM327 {
  // Settings sent after the reset. A clone that rejects one keeps its default,
  // which the parser copes with, so a refusal is noted and does not end the session.
  static INIT_COMMANDS = [
    'ATE0', // no echo
    'ATL0', // no linefeeds
    'ATS0', // no spaces: shorter answers over a slow link
    'ATH0', // no headers
    'ATAT1', // adaptive timing
  ];

  // K-line protocols tried one by one when the automatic search finds nothing:
  // the search of some adapters misses ISO 9141-2 cars. A CAN car is always
  // found by the automatic search, so CAN is not repeated here.
  static FALLBACK_PROTOCOLS = ['3', '5', '4'];

  constructor(
    transport,
    {
      timeoutMs = 2000,
      useResponseCount = true,
      allowMultiPid = true,
      preferredProtocol = '',
      protocolPauseMs = 1000,
      searchTimeoutMs = SEARCH_TIMEOUT_MS,
      busInitTimeoutMs = BUS_INIT_TIMEOUT_MS,
      trace = null,
      onProgress = () => {},
      now = () => performance.now(),
    } = {},
  ) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.useResponseCount = useResponseCount;
    this.allowMultiPid = allowMultiPid;
    this.preferredProtocol = preferredProtocol;
    this.protocolPauseMs = protocolPauseMs;
    this.searchTimeoutMs = searchTimeoutMs;
    this.busInitTimeoutMs = busInitTimeoutMs;
    this.trace = trace;
    this.onProgress = onProgress;
    this.now = now;
    this.version = '';
    this.description = '';
    this.voltage = '';
    this.protocol = '';
    this.supported = new Set();
    this.responders = new Map(); // pid -> number of ECUs that support it
    this.multiPidWorks = null;
    this.stats = { requests: 0, busyMs: 0 };
  }

  // Connection --------------------------------------------------------------

  async connect() {
    this.onProgress('Opening the adapter link');
    try {
      await this.transport.open();
    } catch (error) {
      throw new ELM327Error(`cannot open the adapter link: ${error?.message || error}`);
    }
    try {
      await this.#initialize();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async close() {
    await this.transport.close();
  }

  async #initialize() {
    this.onProgress('Resetting the adapter');
    await this.send('ATZ', RESET_TIMEOUT_MS);
    this.version = (await this.send('ATI')).at(-1) ?? '';
    for (const command of ELM327.INIT_COMMANDS) {
      if (!isOk(await this.send(command))) this.trace?.note(`${command} was not accepted, carrying on`);
    }
    this.description = await this.#ask('AT@1');
    this.voltage = await this.#ask('ATRV');
    await this.#findCar();
    this.protocol = await this.#ask('ATDPN');
    if (!CAN_PROTOCOLS.has(protocolNumber(this.protocol))) this.multiPidWorks = false;
  }

  /** Last line of the answer to an informational command; '' when the adapter does not know it. */
  async #ask(command) {
    const answer = (await this.send(command)).at(-1) ?? '';
    return answer === '?' ? '' : answer;
  }

  /** Find a protocol the car answers on and read which PIDs it supports. */
  async #findCar() {
    const preferred = PROTOCOL_NAMES[this.preferredProtocol] ? [this.preferredProtocol] : [];
    const order = [...new Set([...preferred, '0', ...ELM327.FALLBACK_PROTOCOLS])];
    const failures = [];
    for (const [index, protocol] of order.entries()) {
      const automatic = protocol === '0';
      const label = automatic ? 'automatic search' : PROTOCOL_NAMES[protocol];
      // A K-line ECU needs a moment of silence before it accepts a new init.
      if (index > 0) await pause(this.protocolPauseMs);
      this.onProgress(automatic ? 'Searching for the car protocol' : `Trying ${label}`);
      if (!isOk(await this.send(`ATSP${protocol}`)) && !automatic) {
        failures.push(`${label}: not accepted by the adapter`);
        continue;
      }
      try {
        this.supported = await this.#readSupported(automatic ? this.searchTimeoutMs : this.busInitTimeoutMs);
        return;
      } catch (error) {
        if (error instanceof ELM327ResponseError) {
          failures.push(`${label}: ${error.code}`);
        } else if (error instanceof ELM327Timeout) {
          failures.push(`${label}: no answer in time`);
          await this.#settle();
        } else {
          throw error;
        }
      }
    }
    throw new ELM327NoCarError(failures);
  }

  /** After a timeout the adapter may still be busy. Any command stops it; what it says is dropped. */
  async #settle() {
    try {
      await this.send('ATI');
    } catch (error) {
      if (!(error instanceof ELM327Timeout)) throw error;
    }
  }

  async #readSupported(firstTimeoutMs) {
    const supported = new Set();
    const responders = new Map();
    for (const [index, base] of SUPPORT_PIDS.entries()) {
      if (index > 0 && !supported.has(base)) break;
      // No response count here: every ECU gets to answer (engine and gearbox
      // both do on some cars) and the PIDs of all of them count.
      const command = `01${hexPid(base)}`;
      const answers = parseMode01Messages(await this.send(command, index === 0 ? firstTimeoutMs : undefined), command);
      const bitmaps = answers.map((answer) => answer.get(base)).filter(Boolean);
      if (!bitmaps.length) {
        if (index === 0) throw new ELM327ResponseError('NO DATA', command);
        break;
      }
      for (const bitmap of bitmaps) {
        for (const pid of decodeSupported(base, bitmap)) {
          supported.add(pid);
          responders.set(pid, (responders.get(pid) ?? 0) + 1);
        }
      }
    }
    this.responders = responders;
    return supported;
  }

  // Commands ------------------------------------------------------------------

  /** Send one command and return the answer lines (without echo and prompt). */
  async send(command, timeoutMs = this.timeoutMs) {
    const leftover = await this.#drain();
    if (leftover) this.trace?.rx(leftover, 'late');
    const started = this.now();
    this.trace?.tx(command);
    await this.transport.write(`${command}\r`);
    const raw = await this.#readUntilPrompt(timeoutMs, command);
    this.trace?.rx(raw);
    this.stats.requests += 1;
    this.stats.busyMs += this.now() - started;
    return splitResponse(raw, command);
  }

  /** Drop leftovers of an earlier, timed-out answer (bounded, in case the adapter streams). */
  async #drain() {
    let leftover = '';
    for (let i = 0; i < 100; i += 1) {
      const text = await this.transport.read(0);
      if (!text) break;
      leftover += text;
    }
    return leftover;
  }

  async #readUntilPrompt(timeoutMs, command) {
    const deadline = this.now() + timeoutMs;
    let buffer = '';
    while (!buffer.includes(PROMPT)) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        if (buffer) this.trace?.rx(buffer, 'no prompt');
        throw new ELM327Timeout(`${command}: no answer within ${(timeoutMs / 1000).toFixed(1)} s`);
      }
      buffer += await this.transport.read(Math.min(remaining, 500));
    }
    return buffer.slice(0, buffer.indexOf(PROMPT));
  }

  async #request(pids, timeoutMs) {
    const command = `01${pids.map(hexPid).join('')}`;
    if (pids.length === 1 && this.useResponseCount) {
      // The trailing digit is how many answers to wait for: the adapter returns
      // right after them instead of sitting out its timeout. It has to match
      // the number of ECUs that know the PID, or a late answer from the second
      // one would collide with the next request on a K-line.
      const counted = `${command}${Math.min(this.responders.get(pids[0]) ?? 1, 9)}`;
      try {
        return parseMode01(await this.send(counted, timeoutMs), counted);
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

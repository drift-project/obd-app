// Flight recorder for the conversation with the adapter.
//
// In the car there is no laptop to debug with, so the app keeps what it sent
// and what came back, and the driver can share it. Steady polling would flood
// the log, so in quiet mode the exchanges only go to a short context buffer,
// which is written out when a problem is reported.

const pad = (value, width = 2) => String(value).padStart(width, '0');

function clockText(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Make control characters visible: the line endings of a clone are part of the evidence. */
export function visible(text) {
  return text.replace(/[^\x20-\x7e]/g, (char) => {
    if (char === '\r') return '\\r';
    if (char === '\n') return '\\n';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

const KINDS = new Set(['>', '<', '#', '!']);
const isEntry = (entry) =>
  Array.isArray(entry) && entry.length === 3 && Number.isFinite(entry[0]) && KINDS.has(entry[1]) && typeof entry[2] === 'string';

/** Bounded log of entries: '>' sent, '<' received, '#' note, '!' problem. */
export class Trace {
  #entries = [];
  #context = [];
  #quiet = false;

  constructor({ size = 2000, contextSize = 24, clock = Date.now } = {}) {
    this.size = size;
    this.contextSize = contextSize;
    this.clock = clock;
    this.revision = 0; // changes with every stored entry, so a view knows when to redraw
  }

  get length() {
    return this.#entries.length;
  }

  get quiet() {
    return this.#quiet;
  }

  /** Quiet: exchanges are kept only as context for the next problem. */
  set quiet(value) {
    this.#quiet = Boolean(value);
    if (!this.#quiet) this.#context = [];
  }

  tx(text) {
    this.#exchange('>', text);
  }

  rx(text, label = '') {
    this.#exchange('<', `${label ? `(${label}) ` : ''}${visible(text)}`);
  }

  note(text) {
    this.#store([this.clock(), '#', text]);
  }

  /** Record a problem, preceded by the exchanges that led to it. */
  problem(text) {
    for (const entry of this.#context) this.#store(entry);
    this.#context = [];
    this.#store([this.clock(), '!', text]);
  }

  #exchange(kind, text) {
    const entry = [this.clock(), kind, text];
    if (!this.#quiet) {
      this.#store(entry);
      return;
    }
    this.#context.push(entry);
    if (this.#context.length > this.contextSize) this.#context.shift();
  }

  #store(entry) {
    this.#entries.push(entry);
    if (this.#entries.length > this.size) this.#entries.splice(0, this.#entries.length - this.size);
    this.revision += 1;
  }

  /** The newest `last` entries as text lines, oldest first. */
  lines(last = this.size) {
    return this.#entries.slice(-Math.max(last, 1)).map(([time, kind, text]) => `${clockText(time)} ${kind} ${text}`);
  }

  text(last) {
    return this.lines(last).join('\n');
  }

  clear() {
    this.#entries = [];
    this.#context = [];
    this.revision += 1;
  }

  toJSON() {
    return { version: 1, entries: this.#entries };
  }

  /** Restore entries saved with JSON.stringify(trace); anything malformed is ignored. */
  load(data) {
    if (data?.version !== 1 || !Array.isArray(data.entries)) return;
    this.#entries = data.entries.filter(isEntry).slice(-this.size);
    this.revision += 1;
  }
}

// DRIFThing OBD: live dashboard and logger for an ELM327 adapter over Web Serial.

import { fileName, toCsv } from './csv.js';
import { ELM327 } from './elm327.js';
import { FIELDS } from './pids.js';
import { run } from './poller.js';
import { ELM327Simulator, LoopbackTransport } from './simulator.js';
import { RowStore } from './storage.js';
import { WebSerialTransport } from './transports.js';

const RPM_MAX = 8000;
const REDLINE = 0.85;
const FLUSH_MS = 1000; // a killed page loses at most about this much of the log
const SAVED_KEY = 'drifthing-obd-saved-rows';

// Second character of the ATDPN answer (the first is "A" when found automatically).
const PROTOCOLS = {
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

const FORMAT = {
  maf_gs: (value) => value.toFixed(1),
};

const $ = (id) => document.getElementById(id);
const hasSerial = 'serial' in navigator;
const count = new Intl.NumberFormat('en-US');

const state = {
  mode: null, // 'serial' | 'demo' | null
  controller: null,
  rows: [], // rows from the car; kept in IndexedDB until cleared
  demoRows: [], // demo rows; memory only, never mixed with car data
  pending: [], // car rows not yet written to IndexedDB
  savedRows: 0, // how many car rows were already exported
  latest: new Map(),
  info: null,
  store: null,
  storeQueue: Promise.resolve(),
  dirty: true,
  clearTimer: null,
};

const activeRows = () => (state.mode === 'demo' ? state.demoRows : state.rows);

// --- Storage -------------------------------------------------------------------

function enqueue(operation) {
  state.storeQueue = state.storeQueue.then(operation).catch((error) => console.warn('Log storage failed:', error));
  return state.storeQueue;
}

function flush() {
  if (!state.pending.length) return;
  const batch = state.pending;
  state.pending = [];
  enqueue(() => state.store.append(batch));
}

function readSavedRows() {
  try {
    return Number(localStorage.getItem(SAVED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markSaved() {
  if (state.mode === 'demo') return;
  state.savedRows = state.rows.length;
  try {
    localStorage.setItem(SAVED_KEY, String(state.savedRows));
  } catch {
    // The counter is a convenience; the rows themselves live in IndexedDB.
  }
  state.dirty = true;
}

// --- Session ---------------------------------------------------------------------

function sink(row) {
  activeRows().push(row);
  if (state.mode === 'serial') state.pending.push(row);
  for (let i = 1; i < FIELDS.length; i += 1) {
    if (row[i] !== null) state.latest.set(FIELDS[i], row[i]);
  }
  state.dirty = true;
}

/** What went wrong, in words a driver can act on. */
function problemText(error) {
  if (/UNABLETOCONNECT|NO DATA|no data for/i.test(error)) return 'The adapter answers but the car does not. Is the ignition on?';
  return `Adapter problem: ${error.replace(/\.$/, '')}.`;
}

function onStatus(info) {
  state.info = info;
  if (info.phase === 'connected') showNotice('');
  if (info.phase === 'reconnecting') showNotice(`${problemText(info.lastError)} Retrying…`);
  state.dirty = true;
}

function start(mode, makeElm) {
  if (state.controller) return;
  state.mode = mode;
  state.controller = new AbortController();
  state.latest.clear();
  if (mode === 'demo') state.demoRows = [];
  showNotice('');
  keepAwake(true);
  updateControls();
  run(makeElm, { signal: state.controller.signal, sink, status: onStatus })
    .catch((error) => showNotice(`The session stopped: ${error.message}`))
    .finally(() => {
      state.mode = null;
      state.controller = null;
      state.latest.clear();
      flush();
      keepAwake(false);
      updateControls();
      state.dirty = true;
    });
}

async function connect({ choose = false } = {}) {
  try {
    let port = null;
    if (!choose) [port] = await navigator.serial.getPorts();
    port ??= await navigator.serial.requestPort();
    start('serial', () => new ELM327(new WebSerialTransport(port)));
  } catch (error) {
    // NotFoundError: the chooser was closed without picking a device.
    if (error.name !== 'NotFoundError') showNotice(`Could not open the adapter: ${error.message}`);
  }
}

function startDemo() {
  const simulator = new ELM327Simulator();
  start('demo', () => new ELM327(new LoopbackTransport(simulator, { latencyMs: 40 })));
}

function disconnect() {
  state.controller?.abort();
}

// --- Screen wake lock -------------------------------------------------------------

let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    // Not granted (battery saver, unsupported): the user keeps the screen on.
  }
}

// --- Export ----------------------------------------------------------------------

function exportFile() {
  const prefix = state.mode === 'demo' ? 'obd_demo' : 'obd_data';
  return new File([toCsv(activeRows())], fileName(new Date(), prefix), { type: 'text/csv' });
}

function save() {
  const file = exportFile();
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markSaved();
}

async function share() {
  const file = exportFile();
  try {
    await navigator.share({ files: [file], title: file.name });
    markSaved();
  } catch (error) {
    if (error.name !== 'AbortError') showNotice(`Sharing failed: ${error.message}`);
  }
}

function disarmClear() {
  clearTimeout(state.clearTimer);
  state.clearTimer = null;
  $('clear').classList.remove('armed');
  $('clear').textContent = 'Clear';
}

/** Two taps instead of a dialog: the first arms the button for three seconds. */
function clear() {
  if (!state.clearTimer) {
    $('clear').classList.add('armed');
    $('clear').textContent = 'Tap again to delete';
    state.clearTimer = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  if (state.mode === 'demo') {
    state.demoRows = [];
  } else {
    state.rows = [];
    state.pending = [];
    enqueue(() => state.store.clear());
    markSaved();
  }
  state.dirty = true;
}

// --- Rendering -------------------------------------------------------------------

function showNotice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

function updateControls() {
  const running = state.controller !== null;
  $('connect').hidden = running;
  $('demo').hidden = running;
  $('disconnect').hidden = !running;
  $('connect').disabled = !hasSerial;
  $('log-tag').hidden = state.mode !== 'demo';
  if (running) {
    $('other').hidden = true;
  } else if (hasSerial) {
    navigator.serial.getPorts().then((ports) => {
      $('other').hidden = state.controller !== null || ports.length === 0;
    });
  }
}

function statusText(info) {
  if (!info || info.phase === 'idle') return 'Disconnected';
  if (info.phase === 'connecting') return 'Connecting…';
  if (info.phase === 'reconnecting') return 'Reconnecting…';
  const prefix = state.mode === 'demo' ? 'Demo' : 'Connected';
  return `${prefix} · ${info.rateHz.toFixed(1)} Hz`;
}

function protocolText(code) {
  if (!code) return '--';
  const name = PROTOCOLS[code.at(-1)];
  return name ? `${name} (${code})` : code;
}

const two = (value) => String(value).padStart(2, '0');
const clockTime = (date) => `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;

function spanText(rows) {
  if (!rows.length) return '';
  const first = new Date(rows[0][0]);
  const last = new Date(rows.at(-1)[0]);
  const sameDay = first.toDateString() === last.toDateString();
  const from = sameDay ? clockTime(first) : `${first.toLocaleDateString('en-GB')} ${clockTime(first)}`;
  const unsaved = state.mode === 'demo' ? 0 : rows.length - state.savedRows;
  return `· ${from} → ${clockTime(last)}${unsaved > 0 && state.savedRows > 0 ? ` · ${count.format(unsaved)} not saved yet` : ''}`;
}

function renderValues() {
  const live = state.info?.phase === 'connected';
  const supported = live ? new Set(state.info.supportedFields) : null;
  // While reconnecting the last values stay on screen, dimmed so they do not pass for live ones.
  document.querySelector('.dash').classList.toggle('stale', state.controller !== null && !live);
  for (const element of document.querySelectorAll('[data-field]')) {
    element.classList.toggle('unsupported', supported !== null && !supported.has(element.dataset.field));
  }
  for (const element of document.querySelectorAll('[data-value]')) {
    const field = element.dataset.value;
    const value = state.latest.get(field);
    if (value === undefined) element.textContent = supported && !supported.has(field) ? 'n/a' : '--';
    else element.textContent = FORMAT[field] ? FORMAT[field](value) : String(Math.round(value));
  }
  for (const element of document.querySelectorAll('[data-bar]')) {
    element.style.width = `${Math.max(0, Math.min(100, state.latest.get(element.dataset.bar) ?? 0))}%`;
  }
  const rpm = state.latest.get('rpm');
  const fraction = rpm === undefined ? 0 : Math.max(0, Math.min(1, rpm / RPM_MAX));
  const arc = $('rpm-arc');
  arc.style.strokeDasharray = `${(fraction * 100).toFixed(2)} 100`;
  arc.style.opacity = fraction > 0 ? '1' : '0';
  arc.classList.toggle('redline', fraction >= REDLINE);
}

function renderInfo() {
  const info = state.info;
  $('status').dataset.phase = info?.phase ?? 'idle';
  $('status').textContent = statusText(info);
  $('info-version').textContent = info?.elmVersion || '--';
  $('info-protocol').textContent = protocolText(info?.protocol);
  $('info-signals').textContent = info?.supportedFields?.length ? info.supportedFields.join(', ') : '--';
  $('info-errors').textContent = String(info?.errors ?? 0);
  $('info-last-error').textContent = info?.lastError || '--';
}

function renderLog() {
  const rows = activeRows();
  $('row-count').textContent = count.format(rows.length);
  $('log-span').textContent = spanText(rows);
  $('save').disabled = rows.length === 0;
  $('share').disabled = rows.length === 0;
  $('clear').disabled = rows.length === 0;
  if (rows.length === 0 && state.clearTimer) disarmClear();
}

function render() {
  if (state.dirty) {
    state.dirty = false;
    renderValues();
    renderInfo();
    renderLog();
  }
  requestAnimationFrame(render);
}

// --- Startup ---------------------------------------------------------------------

async function init() {
  $('connect').addEventListener('click', () => connect());
  $('other').addEventListener('click', () => connect({ choose: true }));
  $('demo').addEventListener('click', startDemo);
  $('disconnect').addEventListener('click', disconnect);
  $('save').addEventListener('click', save);
  $('share').addEventListener('click', share);
  $('clear').addEventListener('click', clear);

  const probe = new File(['x'], 'probe.csv', { type: 'text/csv' });
  $('share').hidden = !navigator.canShare?.({ files: [probe] });

  if (!hasSerial) {
    showNotice(
      'This browser cannot reach the adapter. Open this page in Chrome on Android (137 or newer) or in desktop Chrome or Edge. Demo works everywhere.',
    );
  }

  state.store = await RowStore.create();
  state.rows = await state.store.load().catch(() => []);
  state.savedRows = Math.min(readSavedRows(), state.rows.length);
  $('info-storage').textContent = state.store.persistent ? 'Saved on this device until cleared' : 'Memory only: save before closing the page';

  setInterval(flush, FLUSH_MS);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    flush();
    if (state.controller) keepAwake(true);
  });

  updateControls();
  state.dirty = true;
  requestAnimationFrame(render);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Offline support is off:', error));
  }
}

init();

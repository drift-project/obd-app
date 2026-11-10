// DRIFThing OBD: live dashboard and logger for an ELM327 adapter over Web Serial.

import { fileName, toCsv } from './csv.js';
import { ELM327, PROTOCOL_NAMES, protocolNumber } from './elm327.js';
import { FIELDS } from './pids.js';
import { pidList, run } from './poller.js';
import { ELM327Simulator, LoopbackTransport } from './simulator.js';
import { RowStore } from './storage.js';
import { Trace } from './trace.js';
import { WebSerialTransport, pickPort } from './transports.js';

const APP_VERSION = '0.2.3';
const RPM_MAX = 8000;
const REDLINE = 0.85;
const FLUSH_MS = 1000; // a killed page loses at most about this much of the log
const TRACE_SAVE_MS = 3000;
const TRACE_LINES_SHOWN = 300;
const SAVED_KEY = 'drifthing-obd-saved-rows';
const TRACE_KEY = 'drifthing-obd-trace';
const PROTOCOL_KEY = 'drifthing-obd-protocol';
const ADAPTER_KEY = 'drifthing-obd-adapter-picked'; // '1' once an adapter was picked in the chooser

// What the Demo button simulates. "?car=kline" in the address shows an old
// K-line car (one value per request, slow), "?car=silent" a car that never answers.
const DEMO_CARS = {
  can: { car: {}, latencyMs: 40 },
  kline: { car: { busProtocol: '3', supported: [0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x10, 0x11] }, latencyMs: 140 },
  silent: { car: { busProtocol: null }, latencyMs: 300 },
};

const FORMAT = {
  maf_gs: (value) => value.toFixed(1),
};

const $ = (id) => document.getElementById(id);
const hasSerial = 'serial' in navigator;
const onAndroid = /Android/i.test(`${navigator.userAgentData?.platform ?? ''} ${navigator.userAgent}`);
const count = new Intl.NumberFormat('en-US');

const state = {
  mode: null, // 'serial' | 'demo' | null
  controller: null,
  rows: [], // rows from the car; kept in IndexedDB until cleared
  demoRows: [], // demo rows; memory only, never mixed with car data
  pending: [], // car rows not yet written to IndexedDB
  savedRows: 0, // how many car rows were already exported
  latest: new Map(),
  info: null, // status of the running session, or of the last one
  carInfo: null, // status of the last session with a real adapter
  progress: '', // what the connection attempt is doing right now
  protocol: '', // protocol number that worked last time; tried first
  trace: new Trace(), // conversation with the real adapter; survives reloads
  demoTrace: new Trace({ size: 500 }), // demo conversation; memory only
  traceSaved: -1,
  traceShown: '',
  store: null,
  storeQueue: Promise.resolve(),
  dirty: true,
  clearTimer: null,
};

const activeRows = () => (state.mode === 'demo' ? state.demoRows : state.rows);
const activeTrace = () => (state.mode === 'demo' ? state.demoTrace : state.trace);

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

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Full or blocked storage: these values are conveniences, the app works without them.
  }
}

function markSaved() {
  if (state.mode === 'demo') return;
  state.savedRows = state.rows.length;
  writeStored(SAVED_KEY, String(state.savedRows));
  state.dirty = true;
}

function loadTrace() {
  try {
    state.trace.load(JSON.parse(readStored(TRACE_KEY)));
  } catch {
    // A damaged copy of the diagnostic log is not worth stopping for.
  }
}

function saveTrace() {
  if (state.trace.revision === state.traceSaved) return;
  state.traceSaved = state.trace.revision;
  writeStored(TRACE_KEY, JSON.stringify(state.trace));
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
  if (/car did not answer|no data for/i.test(error)) {
    return (
      'The adapter answers but the car does not. Turn the ignition on, best with the engine running. ' +
      'If it is on, this adapter may not speak the protocol of the car, or the car has no standard OBD2 data: ' +
      'share the diagnostic log below.'
    );
  }
  if (/cannot open the adapter link/i.test(error)) {
    return 'Cannot reach the adapter. Check that it is plugged in with its light on, paired with this phone and not in use by another app.';
  }
  if (/no answer within/i.test(error)) {
    return 'The link is open but the adapter is silent. Unplug it, plug it back in and wait a few seconds.';
  }
  return `Adapter problem: ${error.replace(/\.$/, '')}.`;
}

function rememberProtocol(code) {
  const number = protocolNumber(code);
  if (state.mode !== 'serial' || !PROTOCOL_NAMES[number] || number === state.protocol) return;
  state.protocol = number;
  writeStored(PROTOCOL_KEY, number);
}

function onStatus(info) {
  state.info = info;
  if (state.mode === 'serial') state.carInfo = info;
  if (info.phase === 'connected') {
    showNotice('');
    state.progress = '';
    rememberProtocol(info.protocol);
  }
  if (info.phase === 'reconnecting') {
    state.progress = '';
    showNotice(`${problemText(info.lastError)} Retrying…`);
  }
  state.dirty = true;
}

function onProgress(text) {
  state.progress = text;
  state.dirty = true;
}

function start(mode, makeElm) {
  if (state.controller) return;
  state.mode = mode;
  state.controller = new AbortController();
  state.latest.clear();
  state.progress = '';
  if (mode === 'demo') {
    state.demoRows = [];
    state.demoTrace.clear();
  }
  showNotice('');
  keepAwake(true);
  updateControls();
  run(makeElm, { signal: state.controller.signal, sink, status: onStatus, trace: activeTrace() })
    .catch((error) => {
      activeTrace().problem(`the session stopped: ${error.message}`);
      showNotice(`The session stopped: ${error.message}`);
    })
    .finally(() => {
      state.mode = null;
      state.controller = null;
      state.latest.clear();
      state.progress = '';
      flush();
      saveTrace();
      keepAwake(false);
      updateControls();
      state.dirty = true;
    });
}

const hex4 = (value) => (value ?? 0).toString(16).padStart(4, '0');

function portText(port) {
  const info = port.getInfo?.() ?? {};
  if (info.bluetoothServiceClassId) return `Bluetooth serial port (service ${info.bluetoothServiceClassId})`;
  if (info.usbVendorId !== undefined) return `USB serial port ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
  return 'serial port';
}

const adapterPicked = () => readStored(ADAPTER_KEY) === '1';

async function connect({ choose = false } = {}) {
  try {
    const { port, remembered } = await pickPort(navigator.serial, { choose, pickedBefore: adapterPicked(), android: onAndroid });
    writeStored(ADAPTER_KEY, '1');
    state.trace.note(`${remembered ? 'remembered' : 'picked'} adapter: ${portText(port)}`);
    start('serial', () => new ELM327(new WebSerialTransport(port), { preferredProtocol: state.protocol, onProgress }));
  } catch (error) {
    if (error.name === 'NotFoundError') {
      // The chooser was closed without picking a device.
      state.trace.note('no adapter was picked');
      showNotice(
        'No adapter was picked. If the list was empty: allow "Nearby devices" for Chrome (phone Settings, Apps, Chrome, ' +
          'Permissions), then stop Chrome with "Force stop" and open this app again. The adapter must also be paired ' +
          'in the Bluetooth settings of the phone (PIN 1234 or 0000).',
      );
      return;
    }
    state.trace.problem(`could not get the adapter: ${error.message}`);
    showNotice(`Could not open the adapter: ${error.message}`);
  }
}

function startDemo() {
  const { car, latencyMs } = DEMO_CARS[new URLSearchParams(location.search).get('car')] ?? DEMO_CARS.can;
  const simulator = new ELM327Simulator(car);
  start('demo', () => new ELM327(new LoopbackTransport(simulator, { latencyMs }), { onProgress }));
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

function download(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Hand a file to the system share sheet; true when it was shared. */
async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (error) {
    if (error.name !== 'AbortError') showNotice(`Sharing failed: ${error.message}`);
    return false;
  }
}

const canShare = (name, type) => Boolean(navigator.canShare?.({ files: [new File(['x'], name, { type })] }));

function exportFile() {
  const prefix = state.mode === 'demo' ? 'obd_demo' : 'obd_data';
  return new File([toCsv(activeRows())], fileName(new Date(), prefix), { type: 'text/csv' });
}

function save() {
  download(exportFile());
  markSaved();
}

async function share() {
  if (await shareFile(exportFile())) markSaved();
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

// --- Diagnostic report -------------------------------------------------------------

function protocolText(code) {
  if (!code) return '--';
  const name = PROTOCOL_NAMES[protocolNumber(code)];
  return name ? `${name} (${code})` : code;
}

/** Everything needed to tell from a distance why a car did or did not connect. */
function reportText() {
  const demo = state.mode === 'demo';
  const info = demo ? state.info : state.carInfo;
  return [
    `DRIFThing OBD ${APP_VERSION} report${demo ? ' (DEMO: simulated car)' : ''}`,
    `Written: ${new Date().toString()}`,
    `Browser: ${navigator.userAgent}`,
    `Web Serial: ${hasSerial ? 'available' : 'missing'}`,
    `Adapter: ${info?.elmVersion || 'unknown'}`,
    `Protocol: ${protocolText(info?.protocol)}`,
    `Voltage: ${info?.voltage || 'unknown'}`,
    `Signals: ${info?.supportedFields?.length ? info.supportedFields.join(', ') : 'unknown'}`,
    `Car PIDs (mode 01): ${info?.supportedPids?.length ? pidList(info.supportedPids) : 'unknown'}`,
    `Request time: ${info?.requestMs ? `${info.requestMs} ms` : 'unknown'}`,
    `Rows in the log: ${activeRows().length}`,
    `Problems: ${info?.errors ?? 0}${info?.lastError ? `, last: ${info.lastError}` : ''}`,
    '',
    'Conversation with the adapter, newest last (> sent, < received, # note, ! problem):',
    activeTrace().text() || '(nothing yet)',
    '',
  ].join('\n');
}

const reportFile = () => new File([reportText()], fileName(new Date(), 'obd_report', 'txt'), { type: 'text/plain' });

function flash(button, text) {
  const label = button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(reportText());
    flash($('trace-copy'), 'Copied');
  } catch (error) {
    showNotice(`Copying failed (${error.message}). Use Save instead.`);
  }
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
  } else if (hasSerial && adapterPicked()) {
    // Not before an adapter was picked: see pickPort() for what an early getPorts() does on Android.
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
  // Values only some cars have (oil, outside air, catalyst) take no room where the car lacks them.
  const known = new Set(state.info?.supportedFields ?? []);
  for (const element of document.querySelectorAll('[data-field]')) {
    element.classList.toggle('unsupported', supported !== null && !supported.has(element.dataset.field));
    if (element.classList.contains('optional')) element.hidden = !known.has(element.dataset.field);
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
  $('progress').textContent = state.progress ? `${state.progress}…` : '';
  $('progress').hidden = !state.progress;
  $('info-version').textContent = info?.elmVersion || '--';
  $('info-protocol').textContent = protocolText(info?.protocol);
  $('info-voltage').textContent = info?.voltage || '--';
  $('info-request').textContent = info?.requestMs ? `${info.requestMs} ms` : '--';
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

/** The diagnostic log is redrawn only while it is open and only when it changed. */
function renderTrace() {
  if (!$('diagnostics').open) return;
  const trace = activeTrace();
  const key = `${state.mode === 'demo' ? 'demo' : 'car'}:${trace.revision}`;
  if (key === state.traceShown) return;
  state.traceShown = key;
  const view = $('trace-text');
  const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
  view.textContent = trace.length ? trace.text(TRACE_LINES_SHOWN) : 'Nothing yet. Connect the adapter and the conversation shows up here.';
  if (atEnd) view.scrollTop = view.scrollHeight;
}

function render() {
  if (state.dirty) {
    state.dirty = false;
    renderValues();
    renderInfo();
    renderLog();
  }
  renderTrace();
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
  $('trace-copy').addEventListener('click', copyReport);
  $('trace-save').addEventListener('click', () => download(reportFile()));
  $('trace-share').addEventListener('click', () => shareFile(reportFile()));
  $('diagnostics').addEventListener('toggle', () => {
    state.traceShown = '';
  });

  $('share').hidden = !canShare('probe.csv', 'text/csv');
  $('trace-share').hidden = !canShare('probe.txt', 'text/plain');
  $('app-version').textContent = APP_VERSION;

  if (!hasSerial) {
    showNotice(
      'This browser cannot reach the adapter. Open this page in Chrome on Android (137 or newer) or in desktop Chrome or Edge. Demo works everywhere.',
    );
  }

  loadTrace();
  state.trace.note(`app ${APP_VERSION} started on ${new Date().toDateString()}, Web Serial ${hasSerial ? 'available' : 'missing'}`);
  state.protocol = PROTOCOL_NAMES[readStored(PROTOCOL_KEY)] ? readStored(PROTOCOL_KEY) : '';

  state.store = await RowStore.create();
  state.rows = await state.store.load().catch(() => []);
  state.savedRows = Math.min(Number(readStored(SAVED_KEY)) || 0, state.rows.length);
  // Ask the browser not to drop the app and its log when the phone runs low on space.
  const kept = state.store.persistent && (await navigator.storage?.persist?.().catch(() => false));
  if (!state.store.persistent) $('info-storage').textContent = 'Memory only: save before closing the page';
  else $('info-storage').textContent = kept ? 'Saved on this device until cleared' : 'Saved on this device (the browser may drop it if space runs out)';

  setInterval(flush, FLUSH_MS);
  setInterval(saveTrace, TRACE_SAVE_MS);
  addEventListener('pagehide', () => {
    flush();
    saveTrace();
  });
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    if (state.mode === 'serial') state.trace.note(visible ? 'page in front again' : 'page hidden: the browser may pause the readout');
    flush();
    saveTrace();
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

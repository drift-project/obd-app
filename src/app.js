// DRIFThing OBD: live dashboard and logger for an ELM327 adapter over Web Serial,
// with the motion sensors and the GPS of the phone recorded next to the car data.

import { fileName, toCsv } from './csv.js';
import { ELM327, PROTOCOL_NAMES, protocolNumber } from './elm327.js';
import { FIELDS } from './pids.js';
import { pidList, run } from './poller.js';
import { SampleLog } from './samples.js';
import { PhoneSensors, STREAMS } from './sensors.js';
import { ELM327Simulator, LoopbackTransport } from './simulator.js';
import { RowStore, SampleStore } from './storage.js';
import { Trace } from './trace.js';
import { WebSerialTransport, pickPort } from './transports.js';
import { zip } from './zip.js';

const APP_VERSION = '0.3.0';
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
  mode: null, // 'serial' | 'demo' | 'phone' | null
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
  samples: new SampleLog(STREAMS), // phone sensor samples; kept in IndexedDB until cleared
  sampleStore: null,
  sensors: null, // the running PhoneSensors
  sensorStates: [], // what each sensor is doing, or did in the last session
  sensorRates: new Map(), // stream name -> samples per second, measured every second
  sensorCounts: new Map(),
  sensorRateAt: 0,
  gps: null, // the newest position sample of the running session
  clock: null, // steady epoch clock of the running session
  prepared: null, // export files built for the log as it is now
};

const activeRows = () => (state.mode === 'demo' ? state.demoRows : state.rows);
const activeTrace = () => (state.mode === 'demo' ? state.demoTrace : state.trace);

// --- Storage -------------------------------------------------------------------

function enqueue(operation) {
  state.storeQueue = state.storeQueue.then(operation).catch((error) => console.warn('Log storage failed:', error));
  return state.storeQueue;
}

function flush() {
  if (state.pending.length) {
    const rows = state.pending;
    state.pending = [];
    enqueue(() => state.store.append(rows));
  }
  const samples = state.samples.take();
  if (samples) enqueue(() => state.sampleStore.append(samples));
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

// --- Phone sensors ------------------------------------------------------------------

const STREAM_LABELS = {
  accelerometer: 'Accelerometer',
  linear_acceleration: 'Acceleration, no gravity',
  gyroscope: 'Gyroscope',
  magnetometer: 'Magnetometer',
  orientation: 'Orientation',
  relative_orientation: 'Orientation, no compass',
  gps: 'GPS',
};

// Where each value sits in a position sample: [timestamp_ms, ...columns].
const GPS = Object.fromEntries(STREAMS.find(({ name }) => name === 'gps').columns.map((column, index) => [column, index + 1]));

/**
 * Epoch time that cannot jump in the middle of a session: the wall clock is
 * read once and the page's steady clock counts from there. Car rows and phone
 * samples share it, so they line up.
 */
function sessionClock() {
  const offset = Date.now() - performance.now();
  return { now: () => offset + performance.now(), fromTicks: (ticks) => offset + ticks };
}

function onSample(name, values) {
  state.samples.add(name, values);
  if (name === 'gps') {
    state.gps = values;
    state.dirty = true;
  }
}

/** Speed over ground from the newest fix in km/h, or null when the phone gave none. */
function gpsSpeedKmh() {
  const speed = state.gps?.[GPS.speed_ms];
  return typeof speed === 'number' ? speed * 3.6 : null;
}

function gpsText() {
  const accuracy = state.gps?.[GPS.accuracy_m];
  const kmh = gpsSpeedKmh();
  return [typeof accuracy === 'number' ? `±${Math.round(accuracy)} m` : '', kmh === null ? '' : `${Math.round(kmh)} km/h`].filter(Boolean).join(' · ');
}

/** What one sensor is doing, for the screen and the report. */
function streamText({ name, state: phase, detail }) {
  const samples = state.samples.count(name);
  const total = samples ? `${count.format(samples)} samples` : '';
  if (phase === 'on') {
    const rate = state.sensorRates.get(name);
    const speed = rate === undefined ? 'on' : `${rate.toFixed(rate < 10 ? 1 : 0)} Hz`;
    return [speed, name === 'gps' ? gpsText() : '', total].filter(Boolean).join(' · ');
  }
  if (phase === 'starting') return 'starting…';
  if (phase === 'off') return total || '--';
  return [detail || phase, total].filter(Boolean).join(' · ');
}

const sensorStates = () => (state.sensorStates.length ? state.sensorStates : STREAMS.map(({ name }) => ({ name, state: 'off', detail: '' })));
const sensorSummary = () => sensorStates().map((stream) => `${stream.name} ${streamText(stream)}`).join('; ');

function measureRates() {
  if (!state.sensors) return;
  const now = performance.now();
  const seconds = (now - state.sensorRateAt) / 1000;
  if (seconds < 0.5) return;
  for (const { name } of STREAMS) {
    const total = state.samples.count(name);
    state.sensorRates.set(name, Math.max(0, total - (state.sensorCounts.get(name) ?? total)) / seconds);
    state.sensorCounts.set(name, total);
  }
  state.sensorRateAt = now;
  state.dirty = true;
}

function startSensors() {
  const sensors = new PhoneSensors({
    toEpochMs: state.clock.fromTicks,
    onSample,
    onChange: () => {
      state.sensorStates = sensors.states;
      state.dirty = true;
    },
  });
  state.sensors = sensors;
  state.gps = null;
  state.sensorRates.clear();
  state.sensorCounts = new Map(STREAMS.map(({ name }) => [name, state.samples.count(name)]));
  state.sensorRateAt = performance.now();
  sensors.start();
  state.sensorStates = sensors.states;
  // A few seconds in, every sensor has either delivered or said why it cannot.
  setTimeout(() => {
    if (state.sensors === sensors) activeTrace().note(`phone sensors: ${sensorSummary()}`);
  }, 4000);
}

function stopSensors() {
  const sensors = state.sensors;
  if (!sensors) return;
  state.sensors = null;
  sensors.stop();
  state.sensorStates = sensors.states;
  state.sensorRates.clear();
  state.gps = null;
  const shifted = Object.entries(sensors.clockShifts).filter(([, shift]) => shift !== 0);
  const clocks = shifted.length ? `; sensor clocks moved to the page clock: ${shifted.map(([name, shift]) => `${name} ${shift} ms`).join(', ')}` : '';
  activeTrace().note(`phone sensors stopped, ${count.format(state.samples.total)} samples in the log${clocks}`);
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

/** Start a session: 'serial' and 'demo' read a car through `makeElm`, 'phone' records the phone sensors alone. */
function start(mode, makeElm = null) {
  if (state.controller) return;
  state.mode = mode;
  state.controller = new AbortController();
  state.clock = sessionClock();
  state.prepared = null;
  state.latest.clear();
  state.progress = '';
  if (mode === 'demo') {
    state.demoRows = [];
    state.demoTrace.clear();
  }
  showNotice('');
  keepAwake(true);
  // The demo car is made up, so nothing real is recorded next to it.
  if (mode !== 'demo') startSensors();
  if (mode === 'phone') state.trace.note('recording the phone sensors without the car');
  updateControls();
  const { signal } = state.controller;
  const session = makeElm
    ? run(makeElm, { signal, sink, status: onStatus, trace: activeTrace(), clock: state.clock.now })
    : new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
  session
    .catch((error) => {
      activeTrace().problem(`the session stopped: ${error.message}`);
      showNotice(`The session stopped: ${error.message}`);
    })
    .finally(() => {
      stopSensors();
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

function startPhone() {
  start('phone');
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

/** Hand files to the system share sheet; true when they were shared. */
async function shareFiles(files) {
  try {
    await navigator.share({ files, title: files[0].name });
    return true;
  } catch (error) {
    if (error.name !== 'AbortError') showNotice(`Sharing failed: ${error.message}`);
    return false;
  }
}

const probeFile = (name, type) => new File(['x'], name, { type });
const canShare = (...files) => Boolean(navigator.canShare?.({ files }));

const phoneSamples = () => (state.mode === 'demo' ? 0 : state.samples.total);

/** Describes the files of a log for whoever opens them later. */
function logInfo(stamp, rows) {
  const lines = [
    `DRIFThing OBD ${APP_VERSION} log, written ${stamp.toString()}`,
    `Browser: ${navigator.userAgent}`,
    '',
    'Every file has timestamp_ms in its first column: milliseconds since 1970-01-01 UTC. The phone clock is read',
    'once when a recording starts and a steady clock counts from there, so all files of a recording share one time line.',
    '',
    'Files:',
  ];
  if (rows) lines.push(`obd_data: ${rows} rows from the car over OBD2, one row per polling cycle.`);
  for (const stream of STREAMS) {
    const samples = state.samples.count(stream.name);
    if (!samples) continue;
    const [first, last] = state.samples.range(stream.name);
    lines.push(
      `phone_${stream.name}: ${samples} samples, ${clockTime(new Date(first))} to ${clockTime(new Date(last))}. ` +
        `${stream.about}. Columns: timestamp_ms, ${stream.columns.join(', ')}.`,
    );
  }
  lines.push(
    '',
    'Phone axes: x to the right of the screen, y to its top, z out of the screen.',
    'Chrome gives a web page at most 60 readings a second from the motion sensors and 10 from the magnetometer.',
  );
  const absent = sensorStates().filter(({ state: phase }) => ['missing', 'blocked', 'failed', 'waiting'].includes(phase));
  if (absent.length) lines.push('', 'Not recorded in the last session:', ...absent.map(({ name, detail }) => `${name}: ${detail}`));
  return `${lines.join('\r\n')}\r\n`;
}

/** Everything in the log as named pieces of text: the car CSV, one CSV per phone sensor and a description. */
function logEntries(stamp) {
  const entries = [];
  const rows = activeRows();
  const demo = state.mode === 'demo';
  if (rows.length) entries.push({ name: fileName(stamp, demo ? 'obd_demo' : 'obd_data'), type: 'text/csv', data: toCsv(rows) });
  if (phoneSamples()) {
    for (const { name } of STREAMS) {
      const data = state.samples.csv(name);
      if (data) entries.push({ name: fileName(stamp, `phone_${name}`), type: 'text/csv', data });
    }
    entries.push({ name: fileName(stamp, 'log_info', 'txt'), type: 'text/plain', data: logInfo(stamp, rows.length) });
  }
  return entries;
}

const asFile = ({ name, type, data }) => new File([data], name, { type });

/** Build the export files, or reuse them while the log has not changed. A long log takes a moment. */
async function prepareExport(button) {
  const key = `${state.mode}:${activeRows().length}:${phoneSamples()}`;
  if (state.prepared?.key === key) return state.prepared;
  const label = button.textContent;
  button.textContent = 'Preparing…';
  try {
    // Lets the label show before the work blocks the page.
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    const stamp = new Date();
    state.prepared = { key, stamp, entries: logEntries(stamp) };
    return state.prepared;
  } finally {
    button.textContent = label;
  }
}

async function save() {
  try {
    const { stamp, entries } = await prepareExport($('save'));
    if (entries.length === 1) download(asFile(entries[0]));
    else download(new File([await zip(entries, { date: stamp })], fileName(stamp, 'drifthing_log', 'zip'), { type: 'application/zip' }));
    markSaved();
  } catch (error) {
    showNotice(`Saving failed: ${error.message}`);
  }
}

async function share() {
  let prepared;
  try {
    prepared = await prepareExport($('share'));
  } catch (error) {
    showNotice(`Sharing failed: ${error.message}`);
    return;
  }
  // Sharing must follow a tap closely, and a long log can take longer than that to build.
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    flash($('share'), 'Ready, tap again');
    return;
  }
  const files = prepared.entries.map(asFile);
  // Chrome shares at most ten files and 50 MB at a time.
  if (!canShare(...files)) {
    const megabytes = Math.ceil(files.reduce((sum, file) => sum + file.size, 0) / 1e6);
    showNotice(
      `Chrome cannot share this log in one go (${files.length} files, ${megabytes} MB). ` +
        'Use Save: it packs everything into one ZIP file that can be sent from the Files app.',
    );
    return;
  }
  if (await shareFiles(files)) markSaved();
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
    state.samples.clear();
    state.prepared = null;
    enqueue(() => state.store.clear());
    enqueue(() => state.sampleStore.clear());
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
    `Phone sensors: ${demo ? 'not recorded in the demo' : sensorSummary()}`,
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
  $('phone-only').hidden = running;
  $('disconnect').hidden = !running;
  $('disconnect').textContent = state.mode === 'phone' ? 'Stop' : 'Disconnect';
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
  if (state.mode === 'phone') return 'Recording phone';
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
  document.querySelector('.dash').classList.toggle('stale', state.controller !== null && state.mode !== 'phone' && !live);
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
  $('status').dataset.phase = state.mode === 'phone' ? 'connected' : (info?.phase ?? 'idle');
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
  const samples = phoneSamples();
  const empty = rows.length === 0 && samples === 0;
  $('row-count').textContent = count.format(rows.length);
  $('log-span').textContent = spanText(rows);
  $('phone-summary').hidden = samples === 0;
  $('sample-count').textContent = count.format(samples);
  const span = samples ? state.samples.span() : null;
  $('sample-span').textContent = span ? `· ${clockTime(new Date(span[0]))} → ${clockTime(new Date(span[1]))}` : '';
  $('save').disabled = empty;
  $('share').disabled = empty;
  $('clear').disabled = empty;
  if (empty && state.clearTimer) disarmClear();
}

function renderPhone() {
  for (const stream of sensorStates()) $(`phone-${stream.name}`).textContent = streamText(stream);
  const kmh = gpsSpeedKmh();
  $('gps-speed').textContent = kmh === null ? '--' : String(Math.round(kmh));
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
    renderPhone();
  }
  renderTrace();
  requestAnimationFrame(render);
}

// --- Startup ---------------------------------------------------------------------

function buildPhoneList() {
  for (const { name } of STREAMS) {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const value = document.createElement('dd');
    label.textContent = STREAM_LABELS[name];
    value.id = `phone-${name}`;
    value.textContent = '--';
    row.append(label, value);
    $('phone-list').append(row);
  }
}

async function init() {
  buildPhoneList();
  $('connect').addEventListener('click', () => connect());
  $('other').addEventListener('click', () => connect({ choose: true }));
  $('demo').addEventListener('click', startDemo);
  $('phone-only').addEventListener('click', startPhone);
  $('disconnect').addEventListener('click', disconnect);
  $('save').addEventListener('click', save);
  $('share').addEventListener('click', share);
  $('clear').addEventListener('click', clear);
  $('trace-copy').addEventListener('click', copyReport);
  $('trace-save').addEventListener('click', () => download(reportFile()));
  $('trace-share').addEventListener('click', () => shareFiles([reportFile()]));
  $('diagnostics').addEventListener('toggle', () => {
    state.traceShown = '';
  });

  // A log is shared as several CSV files and a text file in one go.
  $('share').hidden = !canShare(probeFile('a.csv', 'text/csv'), probeFile('b.csv', 'text/csv'), probeFile('c.txt', 'text/plain'));
  $('trace-share').hidden = !canShare(probeFile('probe.txt', 'text/plain'));
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
  state.sampleStore = await SampleStore.create();
  state.samples.load(await state.sampleStore.load().catch(() => []));
  state.savedRows = Math.min(Number(readStored(SAVED_KEY)) || 0, state.rows.length);
  // Ask the browser not to drop the app and its log when the phone runs low on space.
  const kept = state.store.persistent && (await navigator.storage?.persist?.().catch(() => false));
  if (!state.store.persistent) $('info-storage').textContent = 'Memory only: save before closing the page';
  else $('info-storage').textContent = kept ? 'Saved on this device until cleared' : 'Saved on this device (the browser may drop it if space runs out)';

  setInterval(flush, FLUSH_MS);
  setInterval(measureRates, 1000);
  setInterval(saveTrace, TRACE_SAVE_MS);
  addEventListener('pagehide', () => {
    flush();
    saveTrace();
  });
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    if (state.mode === 'serial' || state.mode === 'phone') {
      state.trace.note(visible ? 'page in front again' : 'page hidden: the browser pauses the readout and the sensors');
    }
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

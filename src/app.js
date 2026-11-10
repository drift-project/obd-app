// DRIFThing OBD: live dashboard and logger for an ELM327 adapter over Web Serial,
// with the motion sensors and the GPS of the phone recorded next to the car data.

import { BatteryMonitor, chargePercent, chargingVerdict } from './battery.js';
import { sessionClock } from './clock.js';
import { fileName, toCsv } from './csv.js';
import { DEMO_START, demoDrive, demoPhone } from './demo-drive.js';
import { DRIFT_STREAM, DriftEstimator, pickAttitude } from './drift.js';
import { ELM327, PROTOCOL_NAMES, protocolNumber } from './elm327.js';
import { powerHp } from './engine.js';
import { offsetBy } from './geo.js';
import { TrackMap } from './map.js';
import { FIELDS } from './pids.js';
import { pidList, run } from './poller.js';
import { ReplayView } from './replay-view.js';
import { SampleLog } from './samples.js';
import { PhoneSensors, STREAMS } from './sensors.js';
import { ELM327Simulator, LoopbackTransport } from './simulator.js';
import { RowStore, SampleStore } from './storage.js';
import { Trace } from './trace.js';
import { WebSerialTransport, pickPort } from './transports.js';
import { WheelWatch } from './wheels.js';
import { zip } from './zip.js';

const APP_VERSION = '0.7.0';
const RPM_MAX = 8000;
const REDLINE = 0.85;
const FLUSH_MS = 1000; // a killed page loses at most about this much of the log
const TRACE_SAVE_MS = 3000;
const TRACE_LINES_SHOWN = 300;
const SAVED_KEY = 'drifthing-obd-saved-rows';
const TRACE_KEY = 'drifthing-obd-trace';
const PROTOCOL_KEY = 'drifthing-obd-protocol';
const ADAPTER_KEY = 'drifthing-obd-adapter-picked'; // '1' once an adapter was picked in the chooser
const VIEW_KEY = 'drifthing-obd-view';
const BATTERY_KEY = 'drifthing-obd-battery'; // capacity, type and voltmeter correction as JSON
const READ_MODE_KEY = 'drifthing-obd-read-mode'; // 'all' or 'drift': what the requests to the car are spent on
const SESSIONS_KEY = 'drifthing-obd-sessions'; // which version recorded which part of the log, as JSON
const MAX_SESSIONS = 60;
const WHEEL_FACTOR_KEY = 'drifthing-obd-wheel-factor'; // car speed over GPS speed with gripping wheels, from the last drive
const ALARM_KEY = 'drifthing-obd-alarm'; // coolant limit and whether the phone may make a noise, as JSON
const ALARM_OFF_BELOW = 3; // degrees the coolant has to cool below the limit before the alarm goes
const ALARM_REPEAT_MS = 8000;
const ZOOM_KEY = 'drifthing-obd-map-zoom';
const LAYER_KEY = 'drifthing-obd-map-layer'; // 'map' or 'orthophoto'
const VIEWS = ['car', 'drift', 'replay'];
const DRIFT_LOG_MS = 100; // the drift stream is written ten times a second

// Everything recorded from the phone: its sensors and what the drift view worked out from them.
const LOG_STREAMS = [...STREAMS, DRIFT_STREAM];

// What the Demo button simulates. "?car=kline" in the address shows an old
// K-line car (one value per request, slow), "?car=silent" a car that never answers.
const DEMO_CARS = {
  can: { car: { voltage: 14.1 }, latencyMs: 40 },
  kline: { car: { busProtocol: '3', supported: [0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x10, 0x11], voltage: 14.1 }, latencyMs: 140 },
  silent: { car: { busProtocol: null }, latencyMs: 300 },
};

const FORMAT = {
  maf_gs: (value) => value.toFixed(1),
  battery_v: (value) => value.toFixed(1),
};

const RPM_FIELD = FIELDS.indexOf('rpm');
const SPEED_COLUMN = FIELDS.indexOf('speed_kmh');
const COOLANT_COLUMN = FIELDS.indexOf('coolant_c');
const AIR_FLOW_COLUMN = FIELDS.indexOf('maf_gs');
// Values worked out from another one are on offer wherever that one is.
const WORKED_OUT_FROM = { power_hp: 'maf_gs' };
const VOLTAGE_COLUMN = FIELDS.indexOf('battery_v');

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
  latestAt: new Map(), // when each car value last arrived, on the page clock
  battery: new BatteryMonitor(), // of the running session, or of the last one
  batterySettings: { capacity: 100, type: 'flooded', correction: 0 },
  batteryNoted: '', // what the diagnostic log was last told about the battery
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
  samples: new SampleLog(LOG_STREAMS), // phone samples; kept in IndexedDB until cleared
  view: 'car', // one of VIEWS
  map: null, // the map of the drift view
  replay: null, // the replay view
  drift: new DriftEstimator(), // of the running session, or of the last one
  attitudeFrom: null, // the orientation stream that feeds the drift estimator
  demoDrive: null, // timer of the made-up drive behind the Demo button
  sampleStore: null,
  sensors: null, // the running PhoneSensors
  sensorStates: [], // what each sensor is doing, or did in the last session
  sensorRates: new Map(), // stream name -> samples per second, measured every second
  sensorCounts: new Map(),
  sensorRateAt: 0,
  gps: null, // the newest position sample of the running session
  clock: null, // steady epoch clock of the running session
  prepared: null, // export files built for the log as it is now
  readMode: 'all', // 'all' or 'drift', see OBDPoller
  sessions: [], // the recording sessions whose data is in the log
  session: null, // the running one
  wheels: new WheelWatch(), // wheels against the ground, of the running session or the last one
  alarm: { coolant: 110, sound: true, on: false, value: null, beepAt: -Infinity },
  audio: null, // made on the first tap that starts a session: a page may only make a noise after one
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

/** Speed of the car in m/s if it was read in the last few seconds, else null. */
function wheelSpeed() {
  const at = state.latestAt.get('speed_kmh');
  const kmh = state.latest.get('speed_kmh');
  if (at === undefined || typeof kmh !== 'number' || performance.now() - at > 2500) return null;
  return kmh / 3.6;
}

/** Hand a sample to the drift estimator: attitude, acceleration without gravity or a position fix. */
function feedDrift(name, values) {
  if (name === 'gps') {
    state.gps = values;
    state.drift.fix(values[0], {
      latitude: values[GPS.latitude_deg],
      longitude: values[GPS.longitude_deg],
      accuracy: values[GPS.accuracy_m],
      course: values[GPS.heading_deg],
      speed: values[GPS.speed_ms],
      // The demo car and the demo drive are two separate inventions, so their speeds say nothing about each other.
      wheelSpeed: state.mode === 'demo' ? null : wheelSpeed(),
    });
    if (state.mode !== 'demo') state.wheels.ground(values[0], values[GPS.speed_ms]);
    state.dirty = true;
  } else if (name === 'linear_acceleration') {
    state.drift.acceleration(values[0], values.slice(1));
  } else if (name === 'accelerometer') {
    state.drift.accelerometer(values[0], values.slice(1));
  } else if (name === 'gyroscope') {
    state.drift.gyroscope(values[0], values.slice(1));
  } else if (name === 'relative_orientation' || name === 'orientation') {
    const source = pickAttitude(state.attitudeFrom, name);
    if (!source) return;
    // Both sensors start within a millisecond of each other: whichever came first, the one without the compass takes over.
    const restart = state.attitudeFrom !== null && state.attitudeFrom !== source;
    state.attitudeFrom = source;
    state.drift.attitude(values[0], values.slice(1), restart);
  }
}

function onSample(name, values) {
  state.samples.add(name, values);
  feedDrift(name, values);
}

/** Ten times a second: what the drift view shows goes into the log, so it can be checked later. */
function logDrift() {
  if (!state.sensors) return;
  const now = state.clock.now();
  const drift = state.drift.at(now);
  state.samples.add('drift', [
    now,
    drift.heading,
    drift.course,
    drift.driftAngle,
    drift.yawRate,
    drift.speed,
    drift.position?.latitude,
    drift.position?.longitude,
    drift.offset,
    drift.calibrated ? 1 : 0,
    drift.corrected ? 1 : 0,
    drift.aided ? 1 : 0,
    drift.gpsDelay,
  ]);
}

// The demo drive reaches the drift view the way the phone sensors do, only nothing of it is recorded.
const DEMO_GPS_DELAY_MS = 300;

function startDemoDrive() {
  const started = state.clock.now();
  let fixes = 0;
  const step = () => {
    const now = state.clock.now();
    const t = (now - started) / 1000;
    const phone = demoPhone(demoDrive(t));
    feedDrift('relative_orientation', [now, ...phone.attitude]);
    feedDrift('linear_acceleration', [now, ...phone.acceleration]);
    if (t < fixes) return;
    fixes += 1;
    // A fix once a second, and like a real one it describes a moment that has passed.
    const then = demoDrive(t - DEMO_GPS_DELAY_MS / 1000);
    const place = offsetBy(DEMO_START, then.east, then.north);
    feedDrift('gps', [now, Date.now() - DEMO_GPS_DELAY_MS, place.latitude, place.longitude, null, 3, null, then.course, then.speed]);
  };
  state.demoDrive = setInterval(step, 16);
}

function stopDemoDrive() {
  clearInterval(state.demoDrive);
  state.demoDrive = null;
  state.gps = null;
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

// --- Battery ---------------------------------------------------------------------

const CHARGING_TEXT = {
  normal: 'charging normally',
  weak: 'charging weakly: much is switched on at idle, or the battery is very low',
  'not charging': 'not charging: the alternator or its belt',
  'too high': 'too high: the voltage regulator',
};

function loadBatterySettings() {
  try {
    const saved = JSON.parse(readStored(BATTERY_KEY)) ?? {};
    const settings = state.batterySettings;
    if (saved.capacity >= 10 && saved.capacity <= 400) settings.capacity = saved.capacity;
    if (saved.type === 'agm' || saved.type === 'flooded') settings.type = saved.type;
    if (Math.abs(saved.correction) <= 1) settings.correction = saved.correction;
  } catch {
    // Nothing saved yet, or a damaged copy: the defaults stay.
  }
  $('battery-capacity').value = state.batterySettings.capacity;
  $('battery-type').value = state.batterySettings.type;
  $('battery-correction').value = state.batterySettings.correction;
}

function saveBatterySettings() {
  const capacity = Number($('battery-capacity').value);
  const correction = Number($('battery-correction').value);
  const settings = state.batterySettings;
  if (capacity >= 10 && capacity <= 400) settings.capacity = capacity;
  if (Number.isFinite(correction) && Math.abs(correction) <= 1) settings.correction = correction;
  settings.type = $('battery-type').value === 'agm' ? 'agm' : 'flooded';
  writeStored(BATTERY_KEY, JSON.stringify(settings));
  state.dirty = true;
}

const voltsText = (volts) => `${volts.toFixed(1)} V`;

/** What the battery has shown in this session, as the lines of the Battery panel. */
function batteryLines() {
  const { capacity, type, correction } = state.batterySettings;
  const seen = state.battery.summary();
  const rest = seen.rest ? seen.rest.volts + correction : null;
  const percent = chargePercent(rest, type);
  const lines = { charge: '--', rest: '--', start: '--', charging: '--' };
  if (rest !== null) {
    lines.rest = voltsText(rest);
    const about = `about ${Math.round(percent)}%, ${Math.round((percent * capacity) / 100)} of ${capacity} Ah`;
    lines.charge = seen.rest.afterDriving ? `${about}, but measured after the engine ran, so it reads high` : about;
  } else if (seen.running) {
    lines.charge = 'not known: the engine was already running. Connect before starting it.';
  }
  if (seen.starting !== null) lines.start = `${voltsText(seen.starting + correction)} at the lowest reading`;
  if (seen.charging !== null) {
    const volts = seen.charging + correction;
    lines.charging = `${voltsText(volts)}, ${CHARGING_TEXT[chargingVerdict(volts)]}`;
  } else if (seen.running) {
    lines.charging = 'settling after the start…';
  }
  return lines;
}

const batteryReport = () => {
  const lines = batteryLines();
  return `charge ${lines.charge}; engine off ${lines.rest}; while starting ${lines.start}; engine running ${lines.charging}`;
};

/** A reading of the battery voltage from the car; the diagnostic log is told when the picture changes. */
function onVoltage(time, volts, rpm) {
  state.battery.add(time, volts, typeof rpm === 'number' ? rpm : null);
  if (state.mode !== 'serial') return;
  const seen = state.battery.summary();
  // Told once the engine is off with a reading, and again once charging has been judged.
  const stage = seen.charging !== null ? 'charging' : seen.rest && !seen.running ? 'rest' : '';
  if (!stage || stage === state.batteryNoted) return;
  state.batteryNoted = stage;
  state.trace.note(`battery: ${batteryReport()}`);
}

// --- Session ---------------------------------------------------------------------

function sink(row) {
  activeRows().push(row);
  if (state.mode === 'serial') state.pending.push(row);
  const now = performance.now();
  for (let i = 1; i < FIELDS.length; i += 1) {
    if (row[i] === null || row[i] === undefined) continue;
    state.latest.set(FIELDS[i], row[i]);
    state.latestAt.set(FIELDS[i], now);
  }
  if (typeof row[VOLTAGE_COLUMN] === 'number') onVoltage(row[0], row[VOLTAGE_COLUMN], row[RPM_FIELD]);
  if (typeof row[SPEED_COLUMN] === 'number' && state.mode !== 'demo') state.wheels.car(row[0], row[SPEED_COLUMN]);
  if (typeof row[AIR_FLOW_COLUMN] === 'number') state.latest.set('power_hp', powerHp(row[AIR_FLOW_COLUMN]));
  if (typeof row[COOLANT_COLUMN] === 'number') watchCoolant(row[COOLANT_COLUMN]);
  state.dirty = true;
}

// --- Alarm -----------------------------------------------------------------------

function loadAlarm() {
  try {
    const saved = JSON.parse(readStored(ALARM_KEY)) ?? {};
    if (saved.coolant >= 0 && saved.coolant <= 150) state.alarm.coolant = saved.coolant;
    if (typeof saved.sound === 'boolean') state.alarm.sound = saved.sound;
  } catch {
    // Nothing saved yet, or a damaged copy: the defaults stay.
  }
  $('alarm-coolant').value = state.alarm.coolant;
  $('alarm-sound').checked = state.alarm.sound;
}

function saveAlarm() {
  const coolant = Number($('alarm-coolant').value);
  if (coolant >= 0 && coolant <= 150) state.alarm.coolant = Math.round(coolant);
  state.alarm.sound = $('alarm-sound').checked;
  writeStored(ALARM_KEY, JSON.stringify({ coolant: state.alarm.coolant, sound: state.alarm.sound }));
  // A limit moved above the temperature ends an alarm, one moved below it starts one.
  if (state.alarm.value !== null) watchCoolant(state.alarm.value);
  state.dirty = true;
}

/** Three short beeps and a buzz. Quietly does nothing where the browser will not let a page make a noise. */
function soundAlarm() {
  try {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    const audio = state.audio;
    if (!audio) return;
    for (let beep = 0; beep < 3; beep += 1) {
      const from = audio.currentTime + beep * 0.35;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.frequency.value = 1320;
      volume.gain.setValueAtTime(0.5, from);
      volume.gain.exponentialRampToValueAtTime(0.01, from + 0.25);
      tone.connect(volume).connect(audio.destination);
      tone.start(from);
      tone.stop(from + 0.26);
    }
  } catch {
    // The banner on the screen is the alarm; the noise is a help.
  }
}

/** A coolant temperature from the car: raise the alarm at the limit, end it once the engine has cooled a little. */
function watchCoolant(value) {
  const alarm = state.alarm;
  alarm.value = value;
  const limit = alarm.coolant;
  const was = alarm.on;
  if (!limit) alarm.on = false;
  else if (value >= limit) alarm.on = true;
  else if (value <= limit - ALARM_OFF_BELOW) alarm.on = false;
  if (alarm.on && !was) activeTrace().note(`coolant alarm: ${value} °C, limit ${limit} °C`);
  if (!alarm.on && was) activeTrace().note(`coolant alarm over: ${value} °C`);
  const now = performance.now();
  if (alarm.on && alarm.sound && now - alarm.beepAt >= ALARM_REPEAT_MS) {
    alarm.beepAt = now;
    soundAlarm();
  }
  if (!alarm.on) alarm.beepAt = -Infinity;
}

function renderAlarm() {
  const { on, value, coolant } = state.alarm;
  $('alarm').hidden = !on;
  if (on) $('alarm').textContent = `Coolant ${Math.round(value)} °C, over the limit of ${coolant} °C`;
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

// The log outlives the version that recorded it: it stays in the browser while the app is updated, and
// one log can hold drives recorded by several versions. So every recording session is written down
// with its version, and the description of a saved log lists them.

function loadSessions() {
  try {
    const saved = JSON.parse(readStored(SESSIONS_KEY));
    if (Array.isArray(saved)) state.sessions = saved.filter((session) => Number.isFinite(session?.started));
  } catch {
    // Nothing written down yet, or a damaged copy: the log is still there, only undescribed.
  }
}

function saveSessions() {
  state.sessions = state.sessions.slice(-MAX_SESSIONS);
  writeStored(SESSIONS_KEY, JSON.stringify(state.sessions));
}

/** The demo is not in the log, so it is not written down. */
function openSession(mode) {
  if (mode === 'demo') return;
  state.session = { started: Math.round(state.clock.now()), ended: null, version: APP_VERSION, mode, read: mode === 'serial' ? state.readMode : null };
  state.sessions.push(state.session);
  saveSessions();
}

/** Bring what is known about the running session up to date; called when it ends and when the page may be about to go. */
function noteSession() {
  const session = state.session;
  if (!session) return;
  session.ended = Math.round(state.clock.now());
  session.heading = state.attitudeFrom;
  if (session.mode === 'serial') {
    session.read = state.readMode;
    session.adapter = state.carInfo?.elmVersion || null;
    session.protocol = state.carInfo?.protocol || null;
  }
  saveSessions();
}

function closeSession() {
  noteSession();
  state.session = null;
}

/** One session as a line of the log description. */
function sessionText(session) {
  const from = new Date(session.started);
  const day = from.toLocaleDateString('en-GB');
  const until = session.ended ? clockTime(new Date(session.ended)) : 'not closed (the page was shut while recording)';
  const parts = [`app ${session.version}`, session.mode === 'serial' ? 'car and phone' : 'phone only'];
  if (session.read) parts.push(session.read === 'drift' ? 'car read for drifting' : 'car read in full');
  if (session.adapter) parts.push(session.adapter);
  if (session.protocol) parts.push(protocolText(session.protocol));
  if (session.heading) parts.push(`heading from phone_${session.heading}`);
  return `${day} ${clockTime(from)} to ${until}: ${parts.join(', ')}`;
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
  state.drift = new DriftEstimator();
  state.attitudeFrom = null;
  state.battery = new BatteryMonitor();
  state.batteryNoted = '';
  state.wheels = new WheelWatch({ factor: Number(readStored(WHEEL_FACTOR_KEY)) || 1 });
  state.alarm.on = false;
  state.alarm.value = null;
  try {
    state.audio ??= new AudioContext();
    state.audio.resume();
  } catch {
    // No sound then; the alarm still shows on the screen.
  }
  // The demo car is made up, so nothing real is recorded next to it: it brings its own drive.
  if (mode === 'demo') startDemoDrive();
  else startSensors();
  if (mode === 'phone') state.trace.note('recording the phone sensors without the car');
  if (makeElm) activeTrace().note(`read mode: ${state.readMode === 'drift' ? 'for drifting' : 'everything'}`);
  openSession(mode);
  updateControls();
  const { signal } = state.controller;
  const session = makeElm
    ? run(makeElm, { signal, sink, status: onStatus, trace: activeTrace(), clock: state.clock.now, mode: () => state.readMode })
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
      stopDemoDrive();
      // The scale between the car and GPS belongs to the car: the next drive starts from it.
      if (state.wheels.steady >= 8) writeStored(WHEEL_FACTOR_KEY, state.wheels.factor.toFixed(4));
      state.alarm.on = false;
      closeSession();
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
  if (rows) {
    lines.push(
      `obd_data: ${rows} rows from the car over OBD2. Where the car gives one value per request (K-line), every value`,
      'is a row of its own with the time of its own request, and the other cells of that row are empty. Where it answers',
      'several values at once (CAN), a row is one polling cycle. An empty cell: not read in that row.',
    );
  }
  for (const stream of LOG_STREAMS) {
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
  noteSession();
  if (state.sessions.length) {
    lines.push('', 'Recording sessions in this log, each with the version of the app that recorded it:', ...state.sessions.map(sessionText));
  } else {
    lines.push('', 'Which version recorded this log was not written down (before 0.6.2 it was not); the first line names the version that saved it.');
  }
  const absent = sensorStates().filter(({ state: phase }) => ['missing', 'blocked', 'failed', 'waiting'].includes(phase));
  if (absent.length) lines.push('', 'Not recorded in the last session:', ...absent.map(({ name, detail }) => `${name}: ${detail}`));
  // Everything that is needed to judge a recording from a distance travels in the one archive.
  lines.push('', '--- Diagnostic report ---', ...reportText().split('\n'));
  return `${lines.join('\r\n')}\r\n`;
}

/** Everything in the log as named pieces of text: the car CSV, one CSV per phone sensor and a description. */
function logEntries(stamp) {
  const entries = [];
  const rows = activeRows();
  const demo = state.mode === 'demo';
  if (rows.length) entries.push({ name: fileName(stamp, demo ? 'obd_demo' : 'obd_data'), type: 'text/csv', data: toCsv(rows) });
  if (phoneSamples()) {
    for (const { name } of LOG_STREAMS) {
      const data = state.samples.csv(name);
      if (data) entries.push({ name: fileName(stamp, `phone_${name}`), type: 'text/csv', data });
    }
    entries.push({ name: fileName(stamp, 'log_info', 'txt'), type: 'text/plain', data: logInfo(stamp, rows.length) });
  }
  return entries;
}

const asFile = ({ name, type, data }) => new File([data], name, { type });

/** The log as it is now, as tables for the replay: the car's rows and every stream recorded from the phone. */
function logTables() {
  const tables = [];
  const rows = activeRows();
  if (rows.length) {
    const width = FIELDS.length;
    const data = new Float64Array(rows.length * width).fill(NaN);
    rows.forEach((row, index) => {
      // Rows logged by an older version are shorter: their missing columns stay empty.
      for (let column = 0; column < width; column += 1) if (typeof row[column] === 'number') data[index * width + column] = row[column];
    });
    tables.push({ stream: 'obd', columns: FIELDS, data });
  }
  if (phoneSamples()) {
    for (const { name } of LOG_STREAMS) {
      const table = state.samples.table(name);
      if (table) tables.push({ stream: name, ...table });
    }
  }
  return tables;
}

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
    // What is left of the log is what the running session records from here on.
    state.sessions = state.session ? [state.session] : [];
    saveSessions();
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
    `Battery: ${batteryReport()}`,
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
    if (value === undefined) element.textContent = supported && !supported.has(WORKED_OUT_FROM[field] ?? field) ? 'n/a' : '--';
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
  $('replay-this').disabled = empty;
  $('clear').disabled = empty;
  if (empty && state.clearTimer) disarmClear();
}

function renderBattery() {
  const lines = batteryLines();
  $('battery-charge').textContent = lines.charge;
  $('battery-rest').textContent = lines.rest;
  $('battery-start').textContent = lines.start;
  $('battery-charging').textContent = lines.charging;
}

function renderPhone() {
  for (const stream of sensorStates()) $(`phone-${stream.name}`).textContent = streamText(stream);
  const kmh = gpsSpeedKmh();
  $('gps-speed').textContent = kmh === null ? '--' : String(Math.round(kmh));
}

// --- Drift view ------------------------------------------------------------------

function showView(view) {
  state.view = VIEWS.includes(view) ? view : 'car';
  writeStored(VIEW_KEY, state.view);
  document.querySelector('.dash').hidden = state.view !== 'car';
  $('drift').hidden = state.view !== 'drift';
  $('replay').hidden = state.view !== 'replay';
  for (const name of VIEWS) $(`view-${name}`).setAttribute('aria-pressed', String(state.view === name));
  if (state.view !== 'replay') state.replay.pause();
  state.dirty = true;
}

const NO_DRIFT = { heading: null, course: null, driftAngle: null, yawRate: null, position: null, calibrated: false, corrected: false, aided: false, moved: false };

function driftNote(drift, live, line) {
  if (!live) return line.length ? 'The line of the last drive. Start a recording to see the car move.' : 'Start a recording to see the car here.';
  if (!drift.position) return 'Waiting for a GPS position.';
  if (!state.attitudeFrom) return 'No orientation sensor yet: the car is turned along its course and there is no drift angle.';
  if (drift.moved) return 'The phone was moved. Drive straight for two seconds above 20 km/h to set the heading of the car again.';
  if (!drift.calibrated) return 'Drive straight for two seconds above 20 km/h: the heading of the car is then taken from GPS.';
  if (drift.corrected) return 'Driving straight: heading corrected from GPS.';
  return drift.aided ? '' : 'Between GPS fixes the course is a guess until the car has changed speed or direction a few times.';
}

/** Drawn on every frame while the drift view is open, so the car moves smoothly. */
function renderDrift() {
  const live = state.sensors !== null || state.demoDrive !== null;
  const drift = live ? state.drift.at(state.clock.now()) : NO_DRIFT;
  const line = state.drift.path;
  const last = line.at(-1);
  const position = live ? drift.position : last ? { latitude: last[0], longitude: last[1] } : null;
  state.map.draw({ position, points: line, heading: drift.heading, course: drift.course });

  const angle = drift.driftAngle;
  $('drift-angle').textContent = angle === null ? '--' : String(Math.round(Math.abs(angle)));
  // Which side the nose points to, seen along the direction of travel.
  $('drift-side').textContent = angle === null || Math.abs(angle) < 1 ? '°' : angle > 0 ? '° R' : '° L';
  const gps = gpsSpeedKmh();
  $('drift-gps').textContent = gps === null ? '--' : String(Math.round(gps));
  const car = wheelSpeed();
  $('drift-car').textContent = car === null ? '--' : String(Math.round(car * 3.6));
  // Wheels that turn faster than the car moves, or slower: the tile says so and by how much.
  const wheels = live && state.mode !== 'demo' ? state.wheels.at(state.clock.now()) : null;
  const kind = wheels?.kind ?? '';
  if ($('drift-car-tile').dataset.wheels !== kind) $('drift-car-tile').dataset.wheels = kind;
  $('drift-slip').textContent = kind ? `wheels ${wheels.slipPct > 0 ? '+' : ''}${Math.round(wheels.slipPct)}%` : '';
  $('drift-turn').textContent = drift.yawRate === null ? '--' : String(Math.round(drift.yawRate));
  state.map.hint = position ? '' : live ? 'Waiting for a GPS position' : 'No position yet';
  $('drift-note').textContent = driftNote(drift, live, line);
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

function render(now) {
  if (state.dirty) {
    state.dirty = false;
    renderValues();
    renderInfo();
    renderLog();
    renderPhone();
    renderBattery();
    renderAlarm();
  }
  if (state.view === 'drift') renderDrift();
  if (state.view === 'replay') state.replay.frame(now);
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

let tilesNotedAt = -Infinity;

/** A map without its pictures is worth a line in the diagnostic log, but not one for every piece. */
function noteTileError(layer) {
  const now = performance.now();
  if (now - tilesNotedAt < 60000) return;
  tilesNotedAt = now;
  state.trace.note(`map: pieces of the layer "${layer}" did not load (no connection, or the server refused)`);
}

function setReadMode(mode) {
  state.readMode = mode === 'drift' ? 'drift' : 'all';
  writeStored(READ_MODE_KEY, state.readMode);
  $('read-mode').value = state.readMode;
  if (state.controller && state.mode !== 'phone') activeTrace().note(`read mode: ${state.readMode === 'drift' ? 'for drifting' : 'everything'}`);
}

async function init() {
  buildPhoneList();
  loadSessions();
  setReadMode(readStored(READ_MODE_KEY));
  $('read-mode').addEventListener('change', (event) => setReadMode(event.target.value));
  // The maps of the drift view and of the replay show the same layer at the same zoom, kept for the next start.
  const maps = [];
  const mapOptions = {
    zoom: Number(readStored(ZOOM_KEY)),
    layer: readStored(LAYER_KEY),
    onChange: (settings) => {
      writeStored(ZOOM_KEY, String(settings.zoom));
      writeStored(LAYER_KEY, settings.layer);
      for (const map of maps) map.show(settings);
    },
    onTileError: noteTileError,
  };
  state.map = new TrackMap($('map'), mapOptions);
  const replayMap = new TrackMap($('replay-map'), mapOptions);
  maps.push(state.map, replayMap);
  state.replay = new ReplayView({ $, map: replayMap, logTables, readStored, writeStored });
  for (const name of VIEWS) $(`view-${name}`).addEventListener('click', () => showView(name));
  // The app opens on a live view: a replay is something to come back to, not to start a drive with.
  showView(readStored(VIEW_KEY) === 'drift' ? 'drift' : 'car');
  loadBatterySettings();
  for (const id of ['battery-capacity', 'battery-type', 'battery-correction']) $(id).addEventListener('change', saveBatterySettings);
  $('connect').addEventListener('click', () => connect());
  $('other').addEventListener('click', () => connect({ choose: true }));
  $('demo').addEventListener('click', startDemo);
  $('phone-only').addEventListener('click', startPhone);
  $('disconnect').addEventListener('click', disconnect);
  $('save').addEventListener('click', save);
  $('share').addEventListener('click', share);
  $('clear').addEventListener('click', clear);
  $('replay-this').addEventListener('click', () => {
    showView('replay');
    state.replay.openLog();
    $('replay').scrollIntoView({ block: 'start' });
  });
  loadAlarm();
  for (const id of ['alarm-coolant', 'alarm-sound']) $(id).addEventListener('change', saveAlarm);
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
  setInterval(logDrift, DRIFT_LOG_MS);
  setInterval(saveTrace, TRACE_SAVE_MS);
  addEventListener('pagehide', () => {
    flush();
    saveTrace();
    noteSession();
  });
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    if (state.mode === 'serial' || state.mode === 'phone') {
      state.trace.note(visible ? 'page in front again' : 'page hidden: the browser pauses the readout and the sensors');
    }
    // A phone that slept leaves the clock of the recording behind. Nothing was recorded meanwhile, so it can move on.
    const behind = visible && state.controller ? state.clock.catchUp() : 0;
    if (behind) activeTrace().note(`the clock of the recording was ${(behind / 1000).toFixed(1)} s behind after the pause and was moved on`);
    flush();
    saveTrace();
    // A hidden page may never come back: what is known about the session is written down now.
    if (!visible) noteSession();
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

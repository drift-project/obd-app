import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327, ELM327Error } from '../src/elm327.js';
import { FAST_PIDS, FIELDS, PIDS, SLOW_PIDS } from '../src/pids.js';
import { DRIFT_SLOW_INTERVAL_MS, MAX_EMPTY_POLLS, OBDPoller, QUIET_AFTER_POLLS, SLOW_INTERVAL_MS, run } from '../src/poller.js';
import { ELM327Simulator, LoopbackTransport } from '../src/simulator.js';
import { Trace } from '../src/trace.js';

function fakeClock() {
  const clock = () => clock.now;
  clock.now = 1_700_000_000_000;
  return clock;
}

async function makePoller({ simulator = new ELM327Simulator(), clock = fakeClock() } = {}) {
  const elm = new ELM327(new LoopbackTransport(simulator), { timeoutMs: 500 });
  const poller = new OBDPoller(elm, { clock });
  await poller.connect();
  return poller;
}

const column = (row, pid) => row[FIELDS.indexOf(PIDS.get(pid).name)];

/** The single row of a cycle on a car that answers several PIDs at once. */
async function pollRow(poller) {
  const rows = await poller.poll();
  assert.equal(rows.length, 1);
  return rows[0];
}

test('row has a timestamp and all fast values', async () => {
  const clock = fakeClock();
  const row = await pollRow(await makePoller({ clock }));
  assert.equal(row.length, FIELDS.length);
  assert.equal(row[0], clock.now);
  assert.ok(FAST_PIDS.every((pid) => column(row, pid) !== null));
});

test('slow PIDs are read one per interval in turn', async () => {
  const clock = fakeClock();
  const poller = await makePoller({ clock });
  const first = await pollRow(poller);
  assert.notEqual(column(first, SLOW_PIDS[0]), null);
  assert.equal(column(first, SLOW_PIDS[1]), null);

  const sameSecond = await pollRow(poller);
  assert.ok(SLOW_PIDS.every((pid) => column(sameSecond, pid) === null));

  clock.now += SLOW_INTERVAL_MS;
  const later = await pollRow(poller);
  assert.notEqual(column(later, SLOW_PIDS[1]), null);
});

test('long silence from the car raises to reconnect', async () => {
  const silent = new ELM327Simulator({ noData: [...FAST_PIDS, ...SLOW_PIDS] });
  const poller = await makePoller({ simulator: silent });
  await assert.rejects(async () => {
    for (let i = 0; i < MAX_EMPTY_POLLS; i += 1) await poller.poll();
  }, ELM327Error);
});

test('run reconnects after a failed adapter and reports rows', async () => {
  const broken = {
    open: async () => {
      throw new Error('adapter out of range');
    },
    close: async () => {},
    write: async () => {},
    read: async () => '',
  };
  let attempts = 0;
  const makeElm = () => {
    attempts += 1;
    if (attempts === 1) return new ELM327(broken);
    return new ELM327(new LoopbackTransport(new ELM327Simulator()), { timeoutMs: 500 });
  };
  const controller = new AbortController();
  const rows = [];
  const statuses = [];
  await run(makeElm, {
    signal: controller.signal,
    sink: (row) => {
      rows.push(row);
      if (rows.length === 12) controller.abort();
    },
    status: (info) => statuses.push(info),
    statusIntervalMs: 0,
    sleep: async () => {},
  });

  assert.equal(attempts, 2);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => row.length === FIELDS.length));
  const failed = statuses.find((info) => info.phase === 'reconnecting');
  assert.equal(failed.errors, 1);
  assert.equal(failed.lastError, 'cannot open the adapter link: adapter out of range');
  const live = statuses.filter((info) => info.phase === 'connected');
  assert.ok(live.length > 0 && live.every((info) => info.adapterConnected));
  assert.deepEqual(live[0].supportedFields, [...[...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name), 'battery_v']);
  const last = statuses.at(-1);
  assert.equal(last.phase, 'idle');
  assert.equal(last.rows, 12);
  assert.equal(last.adapterConnected, false);
});

test('aborting while connected stops promptly and closes the adapter', async () => {
  const transport = new LoopbackTransport(new ELM327Simulator(), { latencyMs: 5 });
  const controller = new AbortController();
  const rows = [];
  const statuses = [];
  await run(() => new ELM327(transport, { timeoutMs: 500 }), {
    signal: controller.signal,
    sink: (row) => {
      rows.push(row);
      // Abort from a timer, so it lands while the next request is in flight.
      if (rows.length === 3) setTimeout(() => controller.abort(), 0);
    },
    status: (info) => statuses.push(info),
  });
  assert.ok(rows.length >= 3 && rows.length <= 5, `stopped after ${rows.length} rows`);
  assert.equal(transport.opened, false);
  assert.equal(statuses.at(-1).phase, 'idle');
  assert.equal(statuses.at(-1).errors, 0);
});

test('status carries the supply voltage and the time one request takes', async () => {
  const transport = new LoopbackTransport(new ELM327Simulator({ busProtocol: '3' }), { latencyMs: 5 });
  const controller = new AbortController();
  const statuses = [];
  let rows = 0;
  await run(() => new ELM327(transport, { timeoutMs: 500, protocolPauseMs: 0 }), {
    signal: controller.signal,
    sink: () => {
      rows += 1;
      if (rows === 4) controller.abort();
    },
    status: (info) => statuses.push(info),
    statusIntervalMs: 0,
  });
  const live = statuses.filter((info) => info.phase === 'connected');
  assert.equal(live[0].requestMs, null);
  assert.equal(live.at(-1).voltage, '12.6V');
  assert.equal(live.at(-1).protocol, 'A3');
  assert.ok(Number.isInteger(live.at(-1).requestMs) && live.at(-1).requestMs >= 3, `request time ${live.at(-1).requestMs} ms`);
});

// --- Diagnostic trace ---------------------------------------------------------------

const withoutTime = (line) => line.slice(13);
const quickElm = (transport) => new ELM327(transport, { timeoutMs: 500, protocolPauseMs: 0 });

test('run records the session and goes quiet once polling is steady', async () => {
  const trace = new Trace();
  const controller = new AbortController();
  const total = QUIET_AFTER_POLLS + 15;
  let cycles = 0;
  await run(() => quickElm(new LoopbackTransport(new ELM327Simulator({ busProtocol: '3' }))), {
    signal: controller.signal,
    sink: (row) => {
      // On a K-line every value is a row; the engine speed comes once a cycle.
      if (column(row, 0x0c) !== null) cycles += 1;
      if (cycles === total) controller.abort();
    },
    trace,
  });
  const lines = trace.lines().map(withoutTime);
  assert.equal(lines[0], '# connecting');
  assert.equal(lines[1], '> ATZ');
  assert.ok(
    lines.some((line) => line.startsWith('# connected: ELM327 v1.5, protocol A3, 12.6V, signals: rpm speed_kmh throttle_pct')),
    'the connection is summed up in one note',
  );
  const steady = lines.findIndex((line) => line.startsWith('# polling is steady'));
  assert.ok(steady > 0);
  // The first polls are logged in full, later ones are not.
  assert.ok(lines.slice(0, steady).filter((line) => line.startsWith('> 010C')).length === QUIET_AFTER_POLLS);
  assert.equal(lines.length, steady + 2);
  assert.match(lines.at(-1), /^# stopped after \d+ rows and 0 problems$/);
});

test('a link lost during steady polling is logged with the exchanges before it', async () => {
  const trace = new Trace();
  const controller = new AbortController();
  const transport = new LoopbackTransport(new ELM327Simulator());
  let rows = 0;
  await run(() => quickElm(transport), {
    signal: controller.signal,
    sink: () => {
      rows += 1;
      if (rows === QUIET_AFTER_POLLS + 5) transport.opened = false; // the link drops
      if (rows === QUIET_AFTER_POLLS + 10) controller.abort();
    },
    sleep: async () => {},
    trace,
  });
  const lines = trace.lines().map(withoutTime);
  const steady = lines.findIndex((line) => line.startsWith('# polling is steady'));
  const problem = lines.findIndex((line) => line.startsWith('! adapter connection lost'));
  assert.ok(steady > 0 && problem > steady);
  const context = lines.slice(steady + 1, problem);
  assert.ok(context.length > 0 && context.length <= trace.contextSize);
  assert.ok(context.every((line) => line.startsWith('> 01') || line.startsWith('< ')));
  assert.ok(context.some((line) => line.startsWith('> 01')));
  assert.deepEqual(lines.slice(problem + 1, problem + 4), ['# next attempt in 1 s', '# connecting', '> ATZ']);
  assert.equal(lines.at(-1), `# stopped after ${QUIET_AFTER_POLLS + 10} rows and 1 problems`);
});

test('a periodic note sums up the rate and the request time', async () => {
  const trace = new Trace();
  const controller = new AbortController();
  const transport = new LoopbackTransport(new ELM327Simulator(), { latencyMs: 5 });
  let rows = 0;
  await run(() => quickElm(transport), {
    signal: controller.signal,
    sink: () => {
      rows += 1;
      if (rows === 3) controller.abort();
    },
    summaryIntervalMs: 1,
    trace,
  });
  const summary = trace.lines().map(withoutTime).find((line) => / rows in /.test(line));
  assert.match(summary, /^# \d+ rows in \d+ s \(\d+\.\d\/s\), \d+ ms per request$/);
});

test('everything the car reports is listed, not only what the app reads', async () => {
  // An old K-line car: no pedal, no oil temperature, but timing advance (0E) and fuel trim (06).
  const car = [0x04, 0x05, 0x06, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
  const trace = new Trace();
  const controller = new AbortController();
  const statuses = [];
  await run(() => quickElm(new LoopbackTransport(new ELM327Simulator({ busProtocol: '3', supported: car }))), {
    signal: controller.signal,
    sink: () => controller.abort(),
    status: (info) => statuses.push(info),
    trace,
  });
  const live = statuses.find((info) => info.phase === 'connected');
  assert.deepEqual(live.supportedPids, car);
  assert.deepEqual(live.supportedFields, ['rpm', 'speed_kmh', 'throttle_pct', 'engine_load_pct', 'coolant_c', 'intake_air_c', 'maf_gs', 'battery_v']);
  const note = trace.lines().map(withoutTime).find((line) => line.includes('mode 01 PIDs'));
  assert.equal(note, '# the car reports 9 mode 01 PIDs: 04 05 06 0C 0D 0E 0F 10 11');
});

// --- Battery voltage ---------------------------------------------------------------

const voltage = (row) => row[FIELDS.indexOf('battery_v')];
const voltageRequests = (simulator) => simulator.requests.filter((request) => request === 'ATRV').length;

test('with the engine off the battery voltage is read on every row', async () => {
  const simulator = new ELM327Simulator({ rpm: 0, voltage: 12.4 });
  const clock = fakeClock();
  const poller = await makePoller({ simulator, clock });
  const before = voltageRequests(simulator);
  const rows = [];
  for (let i = 0; i < 4; i += 1) {
    rows.push(await pollRow(poller));
    clock.now += 800;
  }
  assert.deepEqual(rows.map(voltage), [12.4, 12.4, 12.4, 12.4]);
  assert.equal(voltageRequests(simulator) - before, 4);
  assert.ok(poller.supportedFields().includes('battery_v'));
});

test('with the engine running the battery voltage is read every few seconds', async () => {
  const simulator = new ELM327Simulator({ rpm: 850, voltage: 14.1 });
  const clock = fakeClock();
  const poller = await makePoller({ simulator, clock });
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push(await pollRow(poller));
    clock.now += 1000;
  }
  // The first row and then one every five seconds.
  assert.deepEqual(rows.map(voltage), [14.1, null, null, null, null, 14.1, null, null, null, null, 14.1, null]);
});

test('reading the voltage does not count as a request to the car', async () => {
  const simulator = new ELM327Simulator({ rpm: 0 });
  const poller = await makePoller({ simulator });
  const requests = poller.elm.stats.requests;
  assert.equal(await poller.elm.readVoltage(), 12.6);
  assert.equal(poller.elm.stats.requests, requests);
  assert.equal(poller.elm.voltage, '12.6V');
});

test('an adapter that cannot tell its voltage is not asked for it again', async () => {
  const simulator = new ELM327Simulator({ rejected: ['RV'], rpm: 0 });
  const poller = await makePoller({ simulator });
  const before = voltageRequests(simulator);
  const row = await pollRow(poller);
  assert.equal(voltage(row), null);
  assert.equal(voltageRequests(simulator), before);
  assert.equal(poller.supportedFields().includes('battery_v'), false);
});

test('a voltage that makes no sense is left out', async () => {
  let reading = 12.5;
  const simulator = new ELM327Simulator({ rpm: 0, voltage: () => reading });
  const poller = await makePoller({ simulator });
  reading = 0.3;
  assert.equal(voltage(await pollRow(poller)), null);
  reading = 12.3;
  assert.equal(voltage(await pollRow(poller)), 12.3);
});

// --- Time of every value ---------------------------------------------------------------

/** A clock that moves on by `step` ms every time it is read, as time passes while a request is on its way. */
function tickingClock(step = 60) {
  const clock = () => {
    clock.now += step;
    return clock.now;
  };
  clock.now = 1_700_000_000_000;
  return clock;
}

test('on a K-line every value gets a row of its own, timed by its own request', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x04, 0x05, 0x0c, 0x0d, 0x11], rpm: 900, voltage: 14.0 });
  const clock = tickingClock();
  const poller = await makePoller({ simulator, clock });
  const rows = await poller.poll();
  // rpm, speed, throttle, one slow value and the voltage.
  assert.equal(rows.length, 5);
  const filled = rows.map((row) => FIELDS.filter((_, index) => index > 0 && row[index] !== null));
  assert.deepEqual(filled, [['rpm'], ['speed_kmh'], ['throttle_pct'], ['engine_load_pct'], ['battery_v']]);
  const times = rows.map((row) => row[0]);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]), times.join(' '));
  // Each time lies between the moments its own request was sent and answered.
  assert.ok(times[0] > 1_700_000_000_000 && times.at(-1) < clock.now);
  assert.equal(column(rows[0], 0x0c), 900);
});

test('on CAN a cycle stays one row with every fast value', async () => {
  const poller = await makePoller({ simulator: new ELM327Simulator({ rpm: 900 }), clock: tickingClock() });
  const rows = await poller.poll();
  assert.equal(rows.length, 1);
  assert.ok(FAST_PIDS.every((pid) => column(rows[0], pid) !== null));
});

test('a K-line car that says nothing gives no rows and is noticed', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x0c, 0x0d], noData: [0x0c, 0x0d], rejected: ['RV'] });
  const poller = await makePoller({ simulator });
  assert.deepEqual(await poller.poll(), []);
  assert.equal(poller.emptyPolls, 1);
});

test('run hands every row of a cycle to the log', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x0c, 0x0d, 0x11], rpm: 900, rejected: ['RV'] });
  const controller = new AbortController();
  const rows = [];
  const statuses = [];
  await run(() => quickElm(new LoopbackTransport(simulator)), {
    signal: controller.signal,
    sink: (row) => {
      rows.push(row);
      if (rows.length === 6) controller.abort();
    },
    status: (info) => statuses.push(info),
  });
  assert.equal(rows.length, 6);
  // Two cycles of three requests: rpm, speed, throttle, twice.
  const filled = rows.map((row) => FIELDS.find((_, index) => index > 0 && row[index] !== null));
  assert.deepEqual(filled, ['rpm', 'speed_kmh', 'throttle_pct', 'rpm', 'speed_kmh', 'throttle_pct']);
  assert.equal(statuses.at(-1).rows, 6);
});

// --- Reading for drifting ---------------------------------------------------------------

const filledNames = (rows) => rows.map((row) => FIELDS.find((_, index) => index > 0 && row[index] !== null));

async function makeDriftPoller(simulator, { clock = tickingClock(), mode = () => 'drift' } = {}) {
  const poller = new OBDPoller(new ELM327(new LoopbackTransport(simulator), { timeoutMs: 500 }), { clock, mode });
  await poller.connect();
  return poller;
}

test('read for drifting, a K-line car gives the wheels twice a cycle and the foot and the revs once', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x11], rpm: 3000, voltage: 14.0 });
  const clock = tickingClock();
  const poller = await makeDriftPoller(simulator, { clock });
  // The first cycle also brings the engine temperature and the voltage, which are due at once.
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'throttle_pct', 'speed_kmh', 'rpm', 'coolant_c', 'battery_v']);
  // After that, cycle after cycle of nothing but the four.
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'throttle_pct', 'speed_kmh', 'rpm']);
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'throttle_pct', 'speed_kmh', 'rpm']);
  // Ten seconds on, the temperature and the voltage come again. The load and the intake air never do.
  clock.now += DRIFT_SLOW_INTERVAL_MS;
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'throttle_pct', 'speed_kmh', 'rpm', 'coolant_c', 'battery_v']);
});

test('read for drifting, the pedal stands for the foot of the driver where the car reports it', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x0c, 0x0d, 0x11, 0x49], rpm: 3000, rejected: ['RV'] });
  const poller = await makeDriftPoller(simulator);
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'pedal_pct', 'speed_kmh', 'rpm']);
});

test('the read mode can be changed while connected', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x0c, 0x0d, 0x11], rpm: 3000, rejected: ['RV'] });
  let mode = 'all';
  const poller = await makeDriftPoller(simulator, { mode: () => mode });
  assert.deepEqual(filledNames(await poller.poll()), ['rpm', 'speed_kmh', 'throttle_pct']);
  mode = 'drift';
  assert.deepEqual(filledNames(await poller.poll()), ['speed_kmh', 'throttle_pct', 'speed_kmh', 'rpm']);
  mode = 'all';
  assert.deepEqual(filledNames(await poller.poll()), ['rpm', 'speed_kmh', 'throttle_pct']);
});

test('read for drifting, a CAN car keeps its fast values and of the slow ones only the engine temperature', async () => {
  const clock = fakeClock();
  const poller = await makeDriftPoller(new ELM327Simulator({ rpm: 3000 }), { clock });
  const first = await pollRow(poller);
  assert.ok(FAST_PIDS.every((pid) => column(first, pid) !== null));
  assert.notEqual(column(first, 0x05), null);
  assert.equal(column(first, 0x04), null);
  clock.now += SLOW_INTERVAL_MS * 3;
  const soon = await pollRow(poller);
  assert.ok(SLOW_PIDS.every((pid) => column(soon, pid) === null));
  clock.now += DRIFT_SLOW_INTERVAL_MS;
  assert.notEqual(column(await pollRow(poller), 0x05), null);
});

// --- Reading for diagnostics ------------------------------------------------------------

test('read for diagnostics, the extra values come in turn, three a cycle, next to the usual ones', async () => {
  // The PIDs the E39 reported.
  const supported = [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x18, 0x19, 0x1c, 0x21];
  const simulator = new ELM327Simulator({ busProtocol: '3', supported, rpm: 760, rejected: ['RV'] });
  const poller = await makeDriftPoller(simulator, { mode: () => 'diag' });
  assert.deepEqual(poller.diagFields(), [
    'mil_on', 'trouble_codes', 'fuel_system_1', 'fuel_system_2', 'stft_b1_pct', 'ltft_b1_pct', 'stft_b2_pct', 'ltft_b2_pct',
    'timing_deg', 'o2_b1s1_v', 'o2_b1s1_trim_pct', 'o2_b1s2_v', 'o2_b1s2_trim_pct', 'o2_b2s1_v', 'o2_b2s1_trim_pct',
    'o2_b2s2_v', 'o2_b2s2_trim_pct', 'secondary_air', 'distance_mil_km', 'obd_standard',
  ]);
  const seen = new Set();
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const rows = await poller.poll();
    // The fast values first, then one slow one or none, then three for diagnostics.
    assert.deepEqual(filledNames(rows).slice(0, 3), ['rpm', 'speed_kmh', 'throttle_pct']);
    for (const row of rows) FIELDS.forEach((name, index) => index > 0 && row[index] !== null && seen.add(name));
  }
  // Five cycles of three cover the fourteen diagnostic PIDs, each answer filling its columns.
  for (const name of poller.diagFields()) {
    if (name === 'o2_b1s2_trim_pct' || name === 'o2_b2s2_trim_pct') continue; // those sensors are not used for trim
    assert.ok(seen.has(name), name);
  }
  const rows = await poller.poll();
  const mil = rows.find((row) => row[FIELDS.indexOf('trouble_codes')] !== null);
  if (mil) assert.equal(mil[FIELDS.indexOf('mil_on')], 0);
});

test('in the other modes nothing is read for diagnostics', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', supported: [0x01, 0x06, 0x0c, 0x0d, 0x11], rpm: 760, rejected: ['RV'] });
  for (const mode of ['all', 'drift']) {
    const poller = await makeDriftPoller(simulator, { mode: () => mode });
    const rows = [...(await poller.poll()), ...(await poller.poll())];
    assert.ok(rows.every((row) => row[FIELDS.indexOf('stft_b1_pct')] === null && row[FIELDS.indexOf('mil_on')] === null), mode);
  }
});

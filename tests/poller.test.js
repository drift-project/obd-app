import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327, ELM327Error } from '../src/elm327.js';
import { FAST_PIDS, FIELDS, PIDS, SLOW_PIDS } from '../src/pids.js';
import { MAX_EMPTY_POLLS, OBDPoller, SLOW_INTERVAL_MS, run } from '../src/poller.js';
import { ELM327Simulator, LoopbackTransport } from '../src/simulator.js';

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

test('row has a timestamp and all fast values', async () => {
  const clock = fakeClock();
  const row = await (await makePoller({ clock })).poll();
  assert.equal(row.length, FIELDS.length);
  assert.equal(row[0], clock.now);
  assert.ok(FAST_PIDS.every((pid) => column(row, pid) !== null));
});

test('slow PIDs are read one per interval in turn', async () => {
  const clock = fakeClock();
  const poller = await makePoller({ clock });
  const first = await poller.poll();
  assert.notEqual(column(first, SLOW_PIDS[0]), null);
  assert.equal(column(first, SLOW_PIDS[1]), null);

  const sameSecond = await poller.poll();
  assert.ok(SLOW_PIDS.every((pid) => column(sameSecond, pid) === null));

  clock.now += SLOW_INTERVAL_MS;
  const later = await poller.poll();
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
  assert.equal(failed.lastError, 'adapter out of range');
  const live = statuses.filter((info) => info.phase === 'connected');
  assert.ok(live.length > 0 && live.every((info) => info.adapterConnected));
  assert.deepEqual(live[0].supportedFields, [...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name));
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

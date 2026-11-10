import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327, ELM327Timeout } from '../src/elm327.js';
import { FAST_PIDS, PIDS, SLOW_PIDS } from '../src/pids.js';
import { ELM327Simulator, LoopbackTransport } from '../src/simulator.js';

async function connected(simulator) {
  const elm = new ELM327(new LoopbackTransport(simulator), { timeoutMs: 500 });
  await elm.connect();
  return elm;
}

const ALL = [...FAST_PIDS, ...SLOW_PIDS];
const hex = (pid) => pid.toString(16).toUpperCase().padStart(2, '0');

test('connect reads version, protocol and supported PIDs', async () => {
  const elm = await connected(new ELM327Simulator());
  assert.equal(elm.version, 'ELM327 v1.5');
  assert.equal(elm.protocol, 'A6');
  assert.ok(ALL.every((pid) => elm.supported.has(pid)));
});

test('fast PIDs come from one multi-PID request', async () => {
  const simulator = new ELM327Simulator();
  const elm = await connected(simulator);
  const before = simulator.requests.length;
  const values = await elm.query(FAST_PIDS);
  assert.deepEqual([...values.keys()].sort(), [...FAST_PIDS].sort());
  assert.deepEqual(simulator.requests.slice(before), ['010C0D1149']);
});

test('multi-frame answer for many PIDs is decoded', async () => {
  const elm = await connected(new ELM327Simulator());
  const values = await elm.query(ALL);
  assert.equal(values.size, ALL.length);
});

test('falls back to one PID per request when the car answers only the first', async () => {
  const simulator = new ELM327Simulator({ multiPid: false });
  const elm = await connected(simulator);
  const values = await elm.query(FAST_PIDS);
  assert.equal(values.size, FAST_PIDS.length);
  assert.equal(elm.multiPidWorks, false);
  const before = simulator.requests.length;
  await elm.query(FAST_PIDS);
  assert.deepEqual(simulator.requests.slice(before), FAST_PIDS.map((pid) => `01${hex(pid)}1`));
});

test('adapter without response count still works', async () => {
  const elm = await connected(new ELM327Simulator({ responseCount: false }));
  assert.equal(elm.useResponseCount, false);
  assert.deepEqual([...(await elm.query([0x0c])).keys()], [0x0c]);
});

test('unsupported PID is never requested', async () => {
  const supported = [...PIDS.keys()].filter((pid) => pid !== 0x49);
  const simulator = new ELM327Simulator({ supported });
  const elm = await connected(simulator);
  const values = await elm.query(FAST_PIDS);
  assert.equal(values.has(0x49), false);
  const polls = simulator.requests.filter((request) => request.startsWith('010C'));
  assert.ok(polls.length > 0 && polls.every((request) => !request.slice(2).includes('49')));
});

test('PID without data is left out', async () => {
  const elm = await connected(new ELM327Simulator({ noData: [0x10] }));
  assert.equal((await elm.query([0x10])).size, 0);
});

test('simulated values look like a drift run', async () => {
  const values = await (await connected(new ELM327Simulator())).query(ALL);
  assert.ok(values.get(0x0c) >= 3800 && values.get(0x0c) <= 6600);
  assert.ok(values.get(0x0d) >= 30 && values.get(0x0d) <= 60);
  assert.ok(values.get(0x11) >= 0 && values.get(0x11) <= 100);
  assert.equal(values.get(0x05), 92);
});

test('missing prompt raises a timeout', async () => {
  const silent = { open: async () => {}, close: async () => {}, write: async () => {}, read: async () => '' };
  const elm = new ELM327(silent, { timeoutMs: 50 });
  await assert.rejects(elm.send('ATI'), ELM327Timeout);
});

test('a failed setup closes the transport again', async () => {
  let closed = 0;
  const silent = {
    open: async () => {},
    close: async () => {
      closed += 1;
    },
    write: async () => {},
    read: async () => '',
  };
  const elm = new ELM327(silent, { timeoutMs: 20 });
  elm.send = async () => {
    throw new ELM327Timeout('ATZ: no answer');
  };
  await assert.rejects(elm.connect(), ELM327Timeout);
  assert.equal(closed, 1);
});

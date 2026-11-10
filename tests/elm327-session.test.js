import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327, ELM327NoCarError, ELM327Timeout, protocolNumber } from '../src/elm327.js';
import { FAST_PIDS, PIDS, SLOW_PIDS } from '../src/pids.js';
import { ELM327Simulator, LoopbackTransport } from '../src/simulator.js';
import { Trace } from '../src/trace.js';

const QUICK = { timeoutMs: 500, protocolPauseMs: 0 };

async function connected(simulator, options = {}) {
  const elm = new ELM327(new LoopbackTransport(simulator), { ...QUICK, ...options });
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
  assert.deepEqual([...(await elm.query([0x0c])).keys()], [0x0c]);
  assert.equal(elm.useResponseCount, false);
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

// --- Adapter details and clones ----------------------------------------------------

test('connect reads the adapter description and the supply voltage', async () => {
  const elm = await connected(new ELM327Simulator());
  assert.equal(elm.description, 'OBDII to RS232 Interpreter');
  assert.equal(elm.voltage, '12.6V');
});

test('a clone that rejects setup and information commands still connects', async () => {
  const elm = await connected(new ELM327Simulator({ rejected: ['AT1', '@1', 'RV', 'DPN'] }));
  assert.equal(elm.description, '');
  assert.equal(elm.voltage, '');
  assert.equal(elm.protocol, '');
  // Without a known protocol the safe single-PID requests are used.
  assert.equal(elm.multiPidWorks, false);
  assert.equal((await elm.query(FAST_PIDS)).size, FAST_PIDS.length);
});

test('PIDs of every answering ECU count as supported', async () => {
  // The gearbox answers first and knows only the vehicle speed.
  const elm = await connected(new ELM327Simulator({ gearbox: [0x0d] }));
  assert.ok(ALL.every((pid) => elm.supported.has(pid)));
});

test('on a K-line the adapter is told how many ECUs answer each PID', async () => {
  // Returning after the first of two answers would leave the second one on the wire.
  const simulator = new ELM327Simulator({ busProtocol: '3', gearbox: [0x0d] });
  const elm = await connected(simulator);
  const before = simulator.requests.length;
  const values = await elm.query([0x0c, 0x0d, 0x11]);
  assert.deepEqual(simulator.requests.slice(before), ['010C1', '010D2', '01111']);
  assert.equal(values.size, 3);
  assert.ok(values.get(0x0d) >= 30 && values.get(0x0d) <= 60);
});

// --- K-line cars (ISO 9141-2 and KWP2000, for example a BMW E39) ---------------------

const protocolCommands = (simulator) => simulator.requests.filter((request) => request.startsWith('ATSP'));

test('K-line car found by the automatic search is polled one PID per request', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3' });
  const elm = await connected(simulator);
  assert.equal(elm.protocol, 'A3');
  assert.equal(protocolNumber(elm.protocol), '3');
  const before = simulator.requests.length;
  const values = await elm.query(FAST_PIDS);
  assert.equal(values.size, FAST_PIDS.length);
  assert.deepEqual(simulator.requests.slice(before), FAST_PIDS.map((pid) => `01${hex(pid)}1`));
});

test('the K-line protocols are tried by hand when the automatic search misses the car', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '5', autoSearch: false });
  const progress = [];
  const elm = await connected(simulator, { onProgress: (text) => progress.push(text) });
  assert.equal(elm.protocol, '5');
  assert.deepEqual(protocolCommands(simulator), ['ATSP0', 'ATSP3', 'ATSP5']);
  assert.deepEqual(progress.slice(-3), ['Searching for the car protocol', 'Trying ISO 9141-2', 'Trying ISO 14230-4 KWP (fast init)']);
  assert.equal((await elm.query([0x0c])).size, 1);
});

test('a silent car is reported with every attempt that was made', async () => {
  const elm = new ELM327(new LoopbackTransport(new ELM327Simulator({ busProtocol: null })), QUICK);
  await assert.rejects(elm.connect(), (error) => {
    assert.ok(error instanceof ELM327NoCarError);
    assert.deepEqual(error.attempts, [
      'automatic search: UNABLETOCONNECT',
      'ISO 9141-2: BUSINIT:...ERROR',
      'ISO 14230-4 KWP (fast init): BUSINIT:ERROR',
      'ISO 14230-4 KWP (5 baud init): BUSINIT:...ERROR',
    ]);
    assert.ok(error.message.startsWith('the car did not answer ('));
    return true;
  });
});

test('the protocol that worked last time is tried first', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3' });
  const elm = await connected(simulator, { preferredProtocol: '3' });
  assert.equal(elm.protocol, '3');
  assert.deepEqual(protocolCommands(simulator), ['ATSP3']);
});

test('a remembered protocol from another car falls back to the automatic search', async () => {
  const simulator = new ELM327Simulator();
  const elm = await connected(simulator, { preferredProtocol: '3' });
  assert.equal(elm.protocol, 'A6');
  assert.deepEqual(protocolCommands(simulator), ['ATSP3', 'ATSP0']);
});

test('a protocol the adapter refuses is skipped', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '5', autoSearch: false, rejected: ['SP3'] });
  const elm = await connected(simulator);
  assert.equal(elm.protocol, '5');
  // No request went out under the refused protocol.
  assert.equal(simulator.requests[simulator.requests.indexOf('ATSP3') + 1], 'ATSP5');
});

test('a search that never ends is interrupted and the next protocol is tried', async () => {
  const simulator = new ELM327Simulator({ busProtocol: '3', searchHangs: true });
  const elm = await connected(simulator, { searchTimeoutMs: 60 });
  assert.equal(elm.protocol, '3');
});

// --- Diagnostic trace ---------------------------------------------------------------

const withoutTime = (line) => line.slice(13);

test('the conversation with the adapter is recorded', async () => {
  const trace = new Trace();
  await connected(new ELM327Simulator({ busProtocol: '3' }), { trace });
  const lines = trace.lines().map(withoutTime);
  assert.deepEqual(lines.slice(0, 2), ['> ATZ', String.raw`< ATZ\r\rELM327 v1.5\r\r`]);
  const search = lines[lines.indexOf('> 0100') + 1];
  assert.ok(search.startsWith(String.raw`< SEARCHING...\r4100`), search);
  assert.deepEqual(lines.slice(-2), ['> ATDPN', String.raw`< A3\r\r`]);
});

test('a timeout records what had arrived so far', async () => {
  const trace = new Trace();
  const simulator = new ELM327Simulator({ busProtocol: '3', searchHangs: true });
  await connected(simulator, { searchTimeoutMs: 60, trace });
  const lines = trace.lines().map(withoutTime);
  assert.ok(lines.includes('< (no prompt) SEARCHING...'));
  assert.ok(lines.includes(String.raw`< STOPPED\r\r`));
});

test('a refused setup command is noted', async () => {
  const trace = new Trace();
  await connected(new ELM327Simulator({ rejected: ['AT1'] }), { trace });
  assert.ok(trace.lines().map(withoutTime).includes('# ATAT1 was not accepted, carrying on'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Trace, visible } from '../src/trace.js';

function fakeClock() {
  const clock = () => {
    clock.now += 1;
    return clock.now;
  };
  clock.now = new Date(2026, 10, 10, 18, 5, 9, 0).getTime();
  return clock;
}

const withoutTime = (line) => line.slice(13);

test('entries are printed with local time and a marker per kind', () => {
  const trace = new Trace({ clock: fakeClock() });
  trace.note('connecting');
  trace.tx('ATZ');
  trace.rx('ELM327 v1.5\r\r');
  trace.problem('ATZ: no answer');
  assert.deepEqual(trace.lines(), [
    '18:05:09.001 # connecting',
    '18:05:09.002 > ATZ',
    String.raw`18:05:09.003 < ELM327 v1.5\r\r`,
    '18:05:09.004 ! ATZ: no answer',
  ]);
});

test('control characters and bytes outside ASCII are made visible', () => {
  const input = `OK\r\n${String.fromCharCode(0x00, 0xff, 0xfffd)}`;
  assert.equal(visible(input), ['OK', 'r', 'n', 'u0000', 'u00ff', 'ufffd'].join('\\'));
});

test('a label marks output that arrived out of turn', () => {
  const trace = new Trace();
  trace.rx('SEARCHING...', 'no prompt');
  assert.equal(withoutTime(trace.lines()[0]), '< (no prompt) SEARCHING...');
});

test('only the newest entries are kept', () => {
  const trace = new Trace({ size: 3 });
  for (let i = 1; i <= 5; i += 1) trace.note(`note ${i}`);
  assert.equal(trace.length, 3);
  assert.deepEqual(trace.lines().map(withoutTime), ['# note 3', '# note 4', '# note 5']);
  assert.deepEqual(trace.lines(2).map(withoutTime), ['# note 4', '# note 5']);
});

test('quiet mode keeps exchanges out of the log but notes stay', () => {
  const trace = new Trace();
  trace.quiet = true;
  trace.tx('010C1');
  trace.rx('410C1AF8\r\r');
  trace.note('30 rows');
  assert.deepEqual(trace.lines().map(withoutTime), ['# 30 rows']);
});

test('a problem brings the last quiet exchanges with it, in order', () => {
  const trace = new Trace({ contextSize: 4, clock: fakeClock() });
  trace.quiet = true;
  for (const pid of ['0C', '0D', '11']) {
    trace.tx(`01${pid}1`);
    trace.rx(`41${pid}00\r\r`);
  }
  trace.problem('010C1: no answer within 2.0 s');
  assert.deepEqual(trace.lines().map(withoutTime), [
    '> 010D1',
    String.raw`< 410D00\r\r`,
    '> 01111',
    String.raw`< 411100\r\r`,
    '! 010C1: no answer within 2.0 s',
  ]);
  // The context was used up: the next problem does not repeat it.
  trace.problem('again');
  assert.equal(trace.length, 6);
});

test('leaving quiet mode drops the unused context', () => {
  const trace = new Trace();
  trace.quiet = true;
  trace.tx('010C1');
  trace.quiet = false;
  trace.problem('link lost');
  assert.deepEqual(trace.lines().map(withoutTime), ['! link lost']);
});

test('the revision changes whenever something is stored', () => {
  const trace = new Trace();
  const before = trace.revision;
  trace.quiet = true;
  trace.tx('010C1');
  assert.equal(trace.revision, before);
  trace.note('stored');
  assert.notEqual(trace.revision, before);
});

test('a saved trace is restored and malformed entries are dropped', () => {
  const trace = new Trace({ clock: fakeClock() });
  trace.tx('ATZ');
  trace.note('connected');
  const saved = JSON.parse(JSON.stringify(trace));
  saved.entries.push(['not a time', '>', 'x'], [1, '?', 'x'], 'junk');

  const restored = new Trace();
  restored.load(saved);
  assert.deepEqual(restored.lines(), trace.lines());

  restored.load(null);
  restored.load({ version: 2, entries: [] });
  assert.equal(restored.length, 2);
});

test('clear empties the log', () => {
  const trace = new Trace();
  trace.note('one');
  trace.clear();
  assert.equal(trace.length, 0);
  assert.equal(trace.text(), '');
});

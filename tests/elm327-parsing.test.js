import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELM327ResponseError, parseMode01, splitResponse } from '../src/elm327.js';

const asObject = (map) => Object.fromEntries(map);

test('split response drops echo and blank lines', () => {
  assert.deepEqual(splitResponse('010C1\r41 0C 1A F8\r\r', '010C1'), ['41 0C 1A F8']);
});

test('split response ignores NUL bytes from clones', () => {
  assert.deepEqual(splitResponse('\0OK\r', 'ATE0'), ['OK']);
});

test('single PID without spaces', () => {
  assert.deepEqual(asObject(parseMode01(['410C1AF8'])), { 12: [0x1a, 0xf8] });
});

test('single PID with spaces after the protocol search', () => {
  assert.deepEqual(asObject(parseMode01(['SEARCHING...', '41 0C 1A F8'])), { 12: [0x1a, 0xf8] });
});

test('NO DATA gives an empty result', () => {
  assert.equal(parseMode01(['NO DATA']).size, 0);
});

test('unknown command raises a fatal error', () => {
  assert.throws(
    () => parseMode01(['?'], '01491'),
    (error) => error instanceof ELM327ResponseError && error.code === '?' && !error.transient,
  );
});

test('STOPPED is transient', () => {
  assert.throws(
    () => parseMode01(['STOPPED']),
    (error) => error instanceof ELM327ResponseError && error.transient,
  );
});

test('bus init error is not swallowed', () => {
  assert.throws(() => parseMode01(['BUS INIT: ...ERROR']), ELM327ResponseError);
});

test('bus init progress line is ignored', () => {
  assert.deepEqual(asObject(parseMode01(['BUS INIT: ...OK', '410D32'])), { 13: [0x32] });
});

test('multi-PID answer in a single frame', () => {
  assert.deepEqual(asObject(parseMode01(['410C1AF80D32'])), { 12: [0x1a, 0xf8], 13: [0x32] });
});

test('multi-frame answer uses the byte count and drops padding', () => {
  // 12 bytes: 41 | 0C 1A F8 | 0D 32 | 11 80 | 49 40 | 04 99, last frame padded with 00.
  const lines = ['00C', '0:410C1AF80D32', '1:11804940049900'];
  assert.deepEqual(asObject(parseMode01(lines)), {
    12: [0x1a, 0xf8],
    13: [0x32],
    17: [0x80],
    73: [0x40],
    4: [0x99],
  });
});

test('first ECU wins when two answer', () => {
  assert.deepEqual(asObject(parseMode01(['410C1AF8', '410C0000'])), { 12: [0x1a, 0xf8] });
});

test('unknown PID stops parsing but keeps earlier values', () => {
  assert.deepEqual(asObject(parseMode01(['410C1AF8FF01'])), { 12: [0x1a, 0xf8] });
});

test('garbage lines are skipped', () => {
  assert.deepEqual(asObject(parseMode01(['ELM327 v1.5', '410D32'])), { 13: [0x32] });
});

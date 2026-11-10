import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAST_PIDS, FIELDS, PIDS, SLOW_PIDS, decodeSupported, responseLength } from '../src/pids.js';

const decode = (pid, bytes) => PIDS.get(pid).decode(bytes);

test('rpm is a quarter of the two-byte value', () => {
  assert.equal(decode(0x0c, [0x1a, 0xf8]), 1726);
});

test('speed is the raw byte in km/h', () => {
  assert.equal(decode(0x0d, [0x32]), 50);
});

test('percent PIDs scale 255 to 100', () => {
  assert.equal(decode(0x11, [0xff]), 100);
  assert.equal(decode(0x49, [0x80]), 50.2);
});

test('temperatures are offset by 40', () => {
  assert.equal(decode(0x05, [0x84]), 92);
  assert.equal(decode(0x0f, [0x00]), -40);
});

test('MAF is two bytes in hundredths', () => {
  assert.equal(decode(0x10, [0x0f, 0xa0]), 40);
});

test('support bitmap matches the SAE example', () => {
  // Example from SAE J1979 documentation: 41 00 BE 1F A8 13.
  assert.deepEqual(decodeSupported(0x00, [0xbe, 0x1f, 0xa8, 0x13]), [
    0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20,
  ]);
});

test('response length covers support and value PIDs', () => {
  assert.equal(responseLength(0x00), 4);
  assert.equal(responseLength(0x40), 4);
  assert.equal(responseLength(0x0c), 2);
  assert.equal(responseLength(0xff), undefined);
});

test('fields match the Raspberry logger column order', () => {
  assert.deepEqual(FIELDS, [
    'timestamp_ms',
    'rpm',
    'speed_kmh',
    'throttle_pct',
    'pedal_pct',
    'engine_load_pct',
    'coolant_c',
    'intake_air_c',
    'maf_gs',
    'map_kpa',
  ]);
  assert.deepEqual(FIELDS.slice(1), [...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name));
});

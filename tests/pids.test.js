import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIAG_FIELDS, DIAG_PIDS, FAST_PIDS, FIELDS, PIDS, SLOW_PIDS, decodeSupported, diagValue, responseLength } from '../src/pids.js';

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

test('oil and outside air use the same offset, the catalyst is in tenths', () => {
  assert.equal(decode(0x5c, [0x94]), 108);
  assert.equal(decode(0x46, [0x36]), 14);
  assert.equal(decode(0x3c, [0x1a, 0x90]), 640);
  assert.equal(decode(0x3c, [0x00, 0x00]), -40);
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

test('fields start with the Raspberry logger columns, the extra temperatures and the voltage follow, then diagnostics', () => {
  assert.deepEqual(FIELDS.slice(0, 14), [
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
    'oil_c',
    'ambient_c',
    'catalyst_c',
    'battery_v',
  ]);
  // Every column up to the voltage is a PID; the voltage is measured by the adapter itself.
  assert.deepEqual(FIELDS.slice(1, 13), [...FAST_PIDS, ...SLOW_PIDS].map((pid) => PIDS.get(pid).name));
  // The diagnostic columns come last, so the columns before keep their places in older logs.
  assert.deepEqual(FIELDS.slice(14), DIAG_FIELDS.map(({ name }) => name));
  assert.ok(FIELDS.includes('stft_b1_pct') && FIELDS.includes('o2_b2s1_v') && FIELDS.includes('mil_on'));
  assert.equal(new Set(FIELDS).size, FIELDS.length, 'no column twice');
});

test('diagnostic values are decoded as a scan tool shows them', () => {
  // Read off the E39 by Car Scanner: trims of +1.56 and +8.59 %, 9 degrees of timing, oxygen sensors at 0.57 and 0.16 V.
  assert.equal(decode(0x06, [130]), 1.6);
  assert.equal(decode(0x07, [139]), 8.6);
  assert.equal(decode(0x09, [128]), 0);
  assert.equal(decode(0x0e, [146]), 9);
  assert.deepEqual(decode(0x14, [114, 130]), { volts: 0.57, trim: 1.6 });
  assert.deepEqual(decode(0x15, [86, 0xff]), { volts: 0.43, trim: null });
  assert.deepEqual(decode(0x01, [0x83, 0x07, 0xe5, 0x00]), { mil: 1, codes: 3 });
  assert.deepEqual(decode(0x03, [1, 1]), { first: 1, second: 1 });
  assert.equal(decode(0x21, [0x01, 0x02]), 258);
  const field = (name) => DIAG_FIELDS.find((candidate) => candidate.name === name);
  const values = new Map([
    [0x01, decode(0x01, [0x83, 0, 0, 0])],
    [0x14, decode(0x14, [114, 0xff])],
  ]);
  assert.equal(diagValue(field('mil_on'), values), 1);
  assert.equal(diagValue(field('trouble_codes'), values), 3);
  assert.equal(diagValue(field('o2_b1s1_v'), values), 0.57);
  assert.equal(diagValue(field('o2_b1s1_trim_pct'), values), null);
  assert.equal(diagValue(field('timing_deg'), values), null);
  assert.equal(field('fuel_system_1').words(1), 'open loop: engine still cold');
  assert.equal(field('mil_on').words(0), 'off');
  assert.equal(field('obd_standard').words(6), 'EOBD (Europe)');
  // Every diagnostic PID can be answered in full.
  for (const pid of DIAG_PIDS) assert.ok(responseLength(pid) >= 1, `PID ${pid}`);
});

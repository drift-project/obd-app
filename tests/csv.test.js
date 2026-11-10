import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileName, toCsv } from '../src/csv.js';
import { FIELDS } from '../src/pids.js';

const COLUMNS = ['timestamp_ms', 'rpm', 'speed_kmh', 'throttle_pct', 'coolant_c'];

test('CSV has a header, empty cells for missing values and CRLF lines', () => {
  const rows = [
    [1793916437268, 6454.75, 52, 86.7, null],
    [1793916437339, 6412.5, 53, null, 92],
  ];
  assert.equal(
    toCsv(rows, COLUMNS),
    ['timestamp_ms,rpm,speed_kmh,throttle_pct,coolant_c', '1793916437268,6454.75,52,86.7,', '1793916437339,6412.5,53,,92', ''].join('\r\n'),
  );
});

test('the default header is the field list of the app', () => {
  assert.equal(toCsv([]), `${FIELDS.join(',')}\r\n`);
});

test('a zero value is kept, not treated as missing', () => {
  assert.equal(toCsv([[1, 0, 0, 0, 0]], COLUMNS).split('\r\n')[1], '1,0,0,0,0');
});

test('a row logged before columns were added gets empty cells for them', () => {
  assert.equal(toCsv([[1, 800, 0]], COLUMNS).split('\r\n')[1], '1,800,0,,');
});

test('file name follows the Raspberry logger pattern in local time', () => {
  assert.equal(fileName(new Date(2026, 10, 5, 9, 7, 3)), 'obd_data_20261105_090703.csv');
  assert.equal(fileName(new Date(2026, 0, 1, 23, 59, 59), 'obd_demo'), 'obd_demo_20260101_235959.csv');
});

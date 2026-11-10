import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileName, toCsv } from '../src/csv.js';
import { FIELDS } from '../src/pids.js';

test('CSV has the logger header, empty cells for missing values and CRLF lines', () => {
  const rows = [
    [1793916437268, 6454.75, 52, 86.7, 87.8, 83.9, null, null, null, null],
    [1793916437339, 6412.5, 53, 83.9, 85.5, null, 92, null, null, null],
  ];
  assert.equal(
    toCsv(rows),
    [
      FIELDS.join(','),
      '1793916437268,6454.75,52,86.7,87.8,83.9,,,,',
      '1793916437339,6412.5,53,83.9,85.5,,92,,,',
      '',
    ].join('\r\n'),
  );
});

test('a zero value is kept, not treated as missing', () => {
  assert.equal(toCsv([[1, 0, 0, 0, 0, null, null, null, null, null]]).split('\r\n')[1], '1,0,0,0,0,,,,,');
});

test('file name follows the Raspberry logger pattern in local time', () => {
  assert.equal(fileName(new Date(2026, 10, 5, 9, 7, 3)), 'obd_data_20261105_090703.csv');
  assert.equal(fileName(new Date(2026, 0, 1, 23, 59, 59), 'obd_demo'), 'obd_demo_20260101_235959.csv');
});

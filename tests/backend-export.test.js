// The file for the team's backend, from a real recording that comes with the
// app. The backend reads it with Python's csv.DictReader and GEOSGeometry.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { backendCsv } from '../src/backend-export.js';
import { driftTable } from '../src/drift-replay.js';
import { Recording, parseCsv, streamOf } from '../src/replay.js';
import { trackOf } from '../src/track.js';
import { unzip } from '../src/zip.js';

const decoder = new TextDecoder();

async function example(file) {
  const tables = [];
  for (const entry of await unzip(new Blob([readFileSync(new URL(`../examples/${file}`, import.meta.url))]))) {
    if (/\.csv$/i.test(entry.name)) tables.push({ stream: streamOf(entry.name), ...parseCsv(decoder.decode(entry.bytes)) });
  }
  const recorded = new Recording(tables);
  return new Recording([...tables.filter(({ stream }) => stream !== 'drift'), { stream: 'drift', ...driftTable(recorded) }]);
}

test('a drift run becomes rows the backend reads: time, place, speed, angle, acceleration, direction', async () => {
  const recording = await example('drifthing_log_20261110_202207.zip');
  const text = backendCsv(recording, trackOf(recording), { lateMs: 500 });
  const [header, ...lines] = text.trimEnd().split('\n');
  assert.equal(header, 'timestamp,location,speed_kmh,drift_angle,acceleration_g,direction');
  // Ten a second over about three minutes, less the moments before the heading was set.
  assert.ok(lines.length > 1200 && lines.length < 1900, `${lines.length} rows`);
  let previous = 0;
  let fastest = 0;
  let widest = 0;
  for (const line of lines) {
    const cells = line.split(',');
    assert.equal(cells.length, 6, line);
    const [timestamp, location, speed, angle, acceleration, direction] = cells;
    assert.match(timestamp, /^2026-11-10T19:\d\d:\d\d\.\d{3}Z$/);
    const time = Date.parse(timestamp);
    assert.ok(time > previous, 'in order of time');
    previous = time;
    const place = /^POINT\((20\.9\d+) (52\.2\d+)\)$/.exec(location);
    assert.ok(place, location);
    fastest = Math.max(fastest, Number(speed));
    widest = Math.max(widest, Math.abs(Number(angle)));
    assert.ok(Number(acceleration) >= 0 && Number(acceleration) < 2, acceleration);
    assert.ok(Number(direction) >= 0 && Number(direction) < 360, direction);
  }
  assert.ok(fastest > 50 && fastest < 80, `top speed ${fastest} km/h`);
  assert.ok(widest > 15 && widest < 40, `largest drift angle ${widest}`);
});

test('without positions there is nothing but the header', async () => {
  const recording = new Recording([{ stream: 'obd', columns: ['timestamp_ms', 'rpm'], data: Float64Array.from([1794340000000, 900]) }]);
  assert.equal(backendCsv(recording, null), 'timestamp,location,speed_kmh,drift_angle,acceleration_g,direction\n');
  assert.equal(trackOf(recording), null);
});

// The recordings that come with the app are real drives. Each is taken the
// whole way a replay takes it: archive, tables, drift angle worked out again,
// wheels against the ground, drifts and totals. What the numbers were when
// the drives were first looked at is written down here, loosely, so that a
// change to the estimator that spoils real data does not pass unnoticed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { driftTable } from '../src/drift-replay.js';
import { powerTable } from '../src/engine.js';
import { Recording, parseCsv, streamOf } from '../src/replay.js';
import { findDrifts, summarize } from '../src/summary.js';
import { wheelSlip } from '../src/wheels.js';
import { unzip } from '../src/zip.js';

const folder = new URL('../examples/', import.meta.url);
const examples = JSON.parse(readFileSync(new URL('index.json', folder), 'utf8'));
const decoder = new TextDecoder();

/** What the replay makes of an example. */
async function replayOf(file) {
  const tables = [];
  for (const entry of await unzip(new Blob([readFileSync(new URL(file, folder))]))) {
    if (/\.csv$/i.test(entry.name)) tables.push({ stream: streamOf(entry.name), ...parseCsv(decoder.decode(entry.bytes)) });
  }
  const recorded = new Recording(tables);
  const wheels = wheelSlip(recorded);
  const power = powerTable(recorded);
  const recording = new Recording([
    ...tables.map((table) => (table.stream === 'drift' ? { ...table, stream: 'drift_recorded' } : table)),
    { stream: 'drift', ...driftTable(recorded) },
    { stream: 'wheels', columns: wheels.columns, data: wheels.data },
    { stream: 'engine', ...power },
  ]);
  const drifts = findDrifts(recording);
  return { recorded, recording, wheels, drifts, totals: summarize(recording, drifts, wheels.spans) };
}

/** The drift angle of a recording while driving faster than 18 km/h, as absolute values in order of size. */
function anglesWhileDriving(recording, id) {
  const { times, values } = recording.series(id);
  const out = [];
  for (let index = 0; index < times.length; index += 1) {
    const speed = recording.value('gps.speed_ms', times[index], 3000);
    if (speed !== null && speed >= 5) out.push(Math.abs(values[index]));
  }
  return out.sort((a, b) => a - b);
}

const middle = (sorted) => sorted[Math.floor(sorted.length / 2)];

test('the list of examples names files that exist, each with a title', () => {
  assert.ok(examples.length >= 4);
  for (const { file, title, about } of examples) {
    assert.match(file, /^drifthing_log_\d{8}_\d{6}\.zip$/);
    assert.ok(title && about, file);
    assert.ok(readFileSync(new URL(file, folder)).length > 100000, file);
  }
});

test('the road drive: the angle logged with the compass wandered, worked out again it stays near zero', async () => {
  const { recorded, recording, wheels, drifts, totals } = await replayOf('drifthing_log_20261110_200914.zip');
  assert.deepEqual(recorded.skipped, []);
  const logged = anglesWhileDriving(recording, 'drift_recorded.drift_angle_deg');
  const again = anglesWhileDriving(recording, 'drift.drift_angle_deg');
  assert.ok(middle(logged) > 1, 'as logged');
  assert.ok(middle(again) < 0.6, `median ${middle(again)}`);
  assert.ok(again[Math.floor(again.length * 0.9)] < 1.5, `nine in ten below ${again[Math.floor(again.length * 0.9)]}`);
  // Two bursts of wheelspin out of junctions, the first of them a slide of a couple of seconds.
  assert.equal(wheels.spans.length, 2);
  assert.ok(wheels.factor > 0.98 && wheels.factor < 1.01, `factor ${wheels.factor}`);
  assert.ok(drifts.length >= 1 && drifts.length <= 2, `${drifts.length} drifts`);
  assert.ok(Math.abs(drifts[0].peak) > 10 && Math.abs(drifts[0].peak) < 25);
  assert.ok(drifts[0].slipPct > 50);
  // At the end the phone was picked up at 60 km/h: the heading is dropped instead of showing a drift of 70 degrees.
  const { times } = recording.series('drift.drift_angle_deg');
  assert.ok(recording.end - times.at(-1) > 3000, 'no angle in the last seconds');
  assert.ok(totals.distanceM > 3500 && totals.distanceM < 5000);
  assert.equal(totals.topRpm, 5411);
});

for (const [file, least] of [
  ['drifthing_log_20261110_202207.zip', { drifts: 4, spans: 5 }],
  ['drifthing_log_20261110_202918.zip', { drifts: 3, spans: 3 }],
  ['drifthing_log_20261110_203420.zip', { drifts: 8, spans: 8 }],
]) {
  test(`a drift run (${file}): slides of 20 to 40 degrees with the wheels running ahead`, async () => {
    const { recorded, recording, wheels, drifts, totals } = await replayOf(file);
    assert.deepEqual(recorded.skipped, []);
    assert.ok(drifts.length >= least.drifts, `${drifts.length} drifts`);
    assert.ok(wheels.spans.length >= least.spans, `${wheels.spans.length} wheel spans`);
    assert.ok(wheels.spans.every(({ kind }) => kind === 'spin'));
    assert.ok(Math.abs(totals.bestAngle) > 20 && Math.abs(totals.bestAngle) < 40, `best ${totals.bestAngle}`);
    assert.ok(totals.topSlipPct > 100, `slip ${totals.topSlipPct}`);
    assert.ok(totals.topWheelKmh >= 90 && totals.topSpeedKmh < 80);
    // The two measurements meet: at least one drift comes with the wheels far ahead of the ground. (Not every
    // one does: the car also slides off the throttle.)
    assert.ok(drifts.some((drift) => drift.slipPct >= 50));
    // Between the slides the car goes where it points.
    assert.ok(middle(anglesWhileDriving(recording, 'drift.drift_angle_deg')) < 2.5);
    // The phone stayed where it was: once set, the heading is never dropped in the middle of a run.
    const calibrated = recording.series('drift.calibrated').values;
    const first = calibrated.indexOf(1);
    assert.ok(first > 0 && calibrated.subarray(first).every((value) => value === 1));
    assert.ok(recording.has('engine.power_hp'));
  });
}

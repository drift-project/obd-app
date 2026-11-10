import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BatteryMonitor, chargePercent, chargingVerdict } from '../src/battery.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

/** Feed readings one second apart: each is [volts, rpm]. Returns the monitor and the time after the last one. */
function feed(monitor, readings, from = 0) {
  let time = from;
  for (const [volts, rpm] of readings) {
    monitor.add(time, volts, rpm);
    time += 1000;
  }
  return time;
}

const times = (count, reading) => Array.from({ length: count }, () => reading);

test('a rested standard battery is full at 12.6 V and empty at 11.8 V', () => {
  assert.equal(chargePercent(12.6), 100);
  assert.equal(chargePercent(12.4), 75);
  assert.equal(chargePercent(12.2), 50);
  assert.equal(chargePercent(12.0), 25);
  assert.equal(chargePercent(11.8), 0);
  // Between the quarters the charge follows the voltage evenly.
  close(chargePercent(12.3), 62.5);
  close(chargePercent(12.5), 87.5);
});

test('charge stays within 0 and 100 percent', () => {
  assert.equal(chargePercent(13.2), 100);
  assert.equal(chargePercent(10.5), 0);
  assert.equal(chargePercent(NaN), null);
  assert.equal(chargePercent(null), null);
});

test('an AGM battery reads higher for the same charge', () => {
  assert.equal(chargePercent(12.84, 'agm'), 100);
  assert.equal(chargePercent(12.24, 'agm'), 50);
  close(chargePercent(12.6, 'agm'), 80);
  // An unknown type is treated as a standard battery.
  assert.equal(chargePercent(12.4, 'gel'), 75);
});

test('the voltage with the engine running tells whether the alternator charges', () => {
  assert.equal(chargingVerdict(14.1), 'normal');
  assert.equal(chargingVerdict(13.6), 'normal');
  assert.equal(chargingVerdict(14.9), 'normal');
  assert.equal(chargingVerdict(13.3), 'weak');
  assert.equal(chargingVerdict(12.5), 'not charging');
  assert.equal(chargingVerdict(15.2), 'too high');
  assert.equal(chargingVerdict(undefined), null);
});

test('with the engine off the resting voltage is read', () => {
  const monitor = new BatteryMonitor();
  feed(monitor, times(4, [12.42, 0]));
  const seen = monitor.summary();
  assert.deepEqual(seen.rest, { volts: 12.42, afterDriving: false });
  assert.equal(seen.latest, 12.42);
  assert.equal(seen.running, false);
  assert.equal(seen.charging, null);
  assert.equal(seen.starting, null);
});

test('a short dip, such as the fuel pump priming, does not move the resting voltage', () => {
  const monitor = new BatteryMonitor();
  feed(monitor, [[12.4, 0], [12.1, 0], [12.4, 0], [12.4, 0], [12.4, 0]]);
  assert.equal(monitor.summary().rest.volts, 12.4);
});

test('a start is followed from the resting voltage through the starter to charging', () => {
  const monitor = new BatteryMonitor();
  let time = feed(monitor, times(5, [12.42, 0]));
  // The starter turns the engine: the voltage sags and the engine speed is far below idle.
  time = feed(monitor, [[10.6, 180], [10.9, 220]], time);
  // The engine fires.
  time = feed(monitor, times(4, [14.0, 850]), time);
  let seen = monitor.summary();
  assert.deepEqual(seen.rest, { volts: 12.42, afterDriving: false });
  assert.equal(seen.starting, 10.6);
  assert.equal(seen.running, true);
  // The first seconds after the start are not judged.
  assert.equal(seen.charging, null);
  feed(monitor, times(12, [14.1, 900]), time);
  seen = monitor.summary();
  assert.equal(seen.charging, 14.1);
  // What was measured before the start stays: it is the reading that tells the charge.
  assert.equal(seen.rest.volts, 12.42);
});

test('an engine that is slow to fire does not drag the resting voltage down', () => {
  const monitor = new BatteryMonitor();
  let time = feed(monitor, times(5, [12.42, 0]));
  // Four readings with the starter turning before the engine catches.
  time = feed(monitor, [[10.4, 190], [10.6, 200], [10.7, 210], [10.8, 230]], time);
  feed(monitor, times(3, [13.9, 800]), time);
  const seen = monitor.summary();
  assert.equal(seen.rest.volts, 12.42);
  assert.equal(seen.starting, 10.4);
});

test('a start that no reading caught leaves the starter voltage unknown', () => {
  const monitor = new BatteryMonitor();
  const time = feed(monitor, times(5, [12.5, 0]));
  feed(monitor, times(3, [14.0, 800]), time);
  assert.equal(monitor.summary().starting, null);
  assert.equal(monitor.summary().rest.volts, 12.5);
});

test('connected with the engine running there is no resting voltage', () => {
  const monitor = new BatteryMonitor();
  feed(monitor, times(15, [13.9, 750]));
  const seen = monitor.summary();
  assert.equal(seen.rest, null);
  assert.equal(seen.charging, 13.9);
  assert.equal(seen.running, true);
});

test('a voltage read after the engine has run is marked as reading high', () => {
  const monitor = new BatteryMonitor();
  const time = feed(monitor, times(15, [13.9, 750]));
  feed(monitor, times(4, [12.9, 0]), time);
  const seen = monitor.summary();
  assert.deepEqual(seen.rest, { volts: 12.9, afterDriving: true });
  assert.equal(seen.running, false);
});

test('a second start does not replace the voltage measured before the first', () => {
  const monitor = new BatteryMonitor();
  let time = feed(monitor, times(5, [12.3, 0]));
  time = feed(monitor, times(15, [14.0, 800]), time);
  // Switched off and started again: the battery now shows its surface charge.
  time = feed(monitor, times(5, [12.8, 0]), time);
  feed(monitor, times(15, [14.2, 800]), time);
  const seen = monitor.summary();
  assert.equal(seen.rest.volts, 12.3);
  assert.equal(seen.charging, 14.2);
});

test('charging is judged again after every start', () => {
  const monitor = new BatteryMonitor();
  let time = feed(monitor, times(15, [14.0, 800]));
  time = feed(monitor, times(3, [12.8, 0]), time);
  feed(monitor, times(3, [13.2, 800]), time);
  // Three seconds after the restart the old readings do not count and the new ones are too fresh.
  assert.equal(monitor.summary().charging, null);
});

test('readings without a known engine speed only update the newest voltage', () => {
  const monitor = new BatteryMonitor();
  monitor.add(0, 12.7, null);
  monitor.add(1000, NaN, 0);
  const seen = monitor.summary();
  assert.equal(seen.latest, 12.7);
  assert.equal(seen.rest, null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionClock } from '../src/clock.js';

/** A wall clock and a steady clock that the test moves by hand. */
function clocks(wallMs = 1_794_327_542_000, steadyMs = 5000) {
  const time = { wall: wallMs, steady: steadyMs };
  const clock = sessionClock({ wall: () => time.wall, steady: () => time.steady });
  const pass = (ms) => {
    time.wall += ms;
    time.steady += ms;
  };
  return { time, clock, pass };
}

test('the session clock starts at the wall clock and counts with the steady clock', () => {
  const { time, clock, pass } = clocks();
  assert.equal(clock.now(), 1_794_327_542_000);
  pass(1500);
  assert.equal(clock.now(), 1_794_327_543_500);
  // A reading stamped on the steady clock lands on the same time line.
  assert.equal(clock.fromTicks(time.steady - 20), 1_794_327_543_480);
});

test('a wall clock that is set in the middle of a drive does not move the recording', () => {
  const { time, clock, pass } = clocks();
  pass(1000);
  time.wall -= 3000; // the phone took the time from the network
  pass(1000);
  assert.equal(clock.now(), 1_794_327_544_000);
  // Catching up never goes back in time.
  assert.equal(clock.catchUp(), 0);
  assert.equal(clock.now(), 1_794_327_544_000);
});

test('after the phone slept the session clock moves on to the wall clock', () => {
  const { time, clock, pass } = clocks();
  pass(10000);
  // Ten minutes of sleep: the wall clock went on, the steady clock stood still.
  time.wall += 600000;
  assert.equal(clock.now(), 1_794_327_552_000, 'behind until it is told');
  assert.equal(clock.catchUp(), 600000);
  assert.equal(clock.now(), 1_794_328_152_000);
  pass(250);
  assert.equal(clock.now(), 1_794_328_152_250);
  assert.equal(clock.catchUp(), 0);
});

test('the two clocks reading a little apart is not taken for a sleep', () => {
  const { time, clock } = clocks();
  time.wall += 120;
  assert.equal(clock.catchUp(), 0);
  assert.equal(clock.now(), 1_794_327_542_000);
});

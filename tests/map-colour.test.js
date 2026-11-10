// The colour of the driven line: blue where the car goes the way it points,
// red where it slides at a large angle.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FULL_ANGLE, angleShade, shadeColor } from '../src/map.js';

test('the shade grows with the drift angle to either side and stops at the full angle', () => {
  assert.equal(angleShade(0), 0);
  assert.equal(angleShade(null), 0);
  assert.equal(angleShade(undefined), 0);
  assert.equal(angleShade(NaN), 0);
  const top = angleShade(FULL_ANGLE);
  assert.ok(top >= 8, `${top} shades`);
  assert.equal(angleShade(-FULL_ANGLE), top);
  assert.equal(angleShade(90), top);
  assert.equal(angleShade(-170), top);
  // More angle is never a lower shade, and left counts like right.
  let last = 0;
  for (let angle = 0; angle <= 60; angle += 0.5) {
    const shade = angleShade(angle);
    assert.ok(shade >= last, `${angle} degrees`);
    assert.equal(angleShade(-angle), shade);
    last = shade;
  }
  // A couple of degrees of noise on a straight stay in the first shade.
  assert.equal(angleShade(1.5), 0);
});

test('the colours run from blue to red', () => {
  const channels = (shade) => shadeColor(shade).match(/\d+/g).map(Number);
  const [r0, , b0] = channels(0);
  const [r1, , b1] = channels(angleShade(FULL_ANGLE));
  assert.ok(b0 > 200 && r0 < 100, shadeColor(0));
  assert.ok(r1 > 200 && b1 < 100, shadeColor(angleShade(FULL_ANGLE)));
  // On the way the red only rises and the blue only falls after the middle.
  let red = r0;
  for (let shade = 1; shade <= angleShade(FULL_ANGLE); shade += 1) {
    const [r] = channels(shade);
    assert.ok(r >= red, `shade ${shade}`);
    red = r;
  }
  // Shades outside the scale are held at its ends.
  assert.equal(shadeColor(-3), shadeColor(0));
  assert.equal(shadeColor(99), shadeColor(angleShade(FULL_ANGLE)));
});

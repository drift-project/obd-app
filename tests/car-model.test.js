// Which faces of the 3D car the camera shows. The painting itself needs a
// browser and was looked at there.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { camera } from '../src/camera.js';
import { CAR_FACES, MODEL_LENGTH, visibleFaces } from '../src/car-model.js';

const VIEW = { width: 390, height: 470 };
const names = (faces) => faces.map(({ name }) => name);

test('from behind, the camera sees the back and the roof of the car, not its front', () => {
  // Driving north with the camera following: the car points the way the camera looks.
  const faces = visibleFaces(camera({ ...VIEW, tilted: true, bearing: 0 }), { heading: 0, scale: 1 });
  const seen = names(faces);
  assert.ok(seen.includes('body back'));
  assert.ok(seen.includes('body top'));
  assert.ok(seen.includes('cabin roof'));
  assert.ok(seen.includes('rear window'));
  assert.ok(!seen.includes('body front'));
  assert.ok(!seen.includes('windscreen'));
  // The taillights are on the back.
  const back = faces.find(({ name }) => name === 'body back');
  assert.equal(back.lights.length, 2);
  assert.match(back.lights[0].color, /255, 48, 48/);
});

test('a car sliding sideways shows its side, and one coming towards the camera its front', () => {
  // Travelling north, the nose turned 90 degrees to the right (east): the camera, south of the car, sees its right side.
  const sideways = names(visibleFaces(camera({ ...VIEW, tilted: true, bearing: 0 }), { heading: 90, scale: 1 }));
  assert.ok(sideways.includes('body right'));
  assert.ok(!sideways.includes('body left'));
  const towards = names(visibleFaces(camera({ ...VIEW, tilted: true, bearing: 0 }), { heading: 180, scale: 1 }));
  assert.ok(towards.includes('body front') && towards.includes('windscreen'));
  assert.ok(!towards.includes('body back'));
});

test('the faces come furthest first, so the nearer ones are painted over them', () => {
  const faces = visibleFaces(camera({ ...VIEW, tilted: true, bearing: 40 }), { heading: 75, scale: 1.3 });
  assert.ok(faces.length >= 6);
  assert.ok(faces.every(({ depth }, index) => index === 0 || depth <= faces[index - 1].depth));
  // The roof of the cabin is the top of the car, so it is painted after the body under it.
  const order = names(faces);
  assert.ok(order.indexOf('cabin roof') > order.indexOf('body top'));
});

test('lit by a sun high up, tops are brighter than sides, and the model is the size it claims', () => {
  const faces = visibleFaces(camera({ ...VIEW, tilted: true, bearing: 0 }), { heading: 0, scale: 1 });
  const red = (name) => Number(/rgb\((\d+)/.exec(faces.find((face) => face.name === name).color)[1]);
  assert.ok(red('body top') > red('body back'));
  const ys = CAR_FACES.flatMap(({ corners }) => corners.map(([, y]) => y));
  assert.equal(Math.max(...ys) - Math.min(...ys), MODEL_LENGTH);
});

test('seen from straight above, only what faces up is drawn: tops and the sloping glass', () => {
  const seen = names(visibleFaces(camera(VIEW), { heading: 30, scale: 1 }));
  assert.ok(seen.includes('body top') && seen.includes('cabin roof') && seen.includes('windscreen'));
  for (const side of ['body front', 'body back', 'body left', 'body right', 'wheel 1 left']) assert.ok(!seen.includes(side), side);
});

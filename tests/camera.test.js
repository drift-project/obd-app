// The sums of the map camera. The browser draws the tiles with the same sums
// through CSS; in the browser the two were checked against each other.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAR_PX, camera, groundCss, inView, toGround, toScreen, visibleGround } from '../src/camera.js';

const VIEW = { width: 390, height: 470 };
const near = (actual, expected, tolerance = 1e-6, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} is not ${expected}`);

test('flat, the map is only moved: the car in the middle, north up, nothing smaller', () => {
  const cam = camera({ ...VIEW, bearing: 70 });
  assert.equal(cam.bearing, 0, 'a flat map is not turned');
  const car = toScreen(cam, 0, 0);
  assert.deepEqual([car.x, car.y, car.scale], [195, 235, 1]);
  // 100 pixels east of the car is 100 pixels to the right of it, 50 north is 50 above.
  const point = toScreen(cam, 100, -50);
  assert.deepEqual([point.x, point.y, point.scale], [295, 185, 1]);
  assert.deepEqual(toGround(cam, 295, 185), { x: 100, y: -50 });
});

test('in 3D the car sits low in the view and what lies ahead goes up the screen, smaller', () => {
  const cam = camera({ ...VIEW, tilted: true, bearing: 0 });
  const car = toScreen(cam, 0, 0);
  near(car.x, 195);
  near(car.y, 470 * 0.78);
  near(car.scale, 1);
  // Driving north, north is up the screen.
  let previous = car;
  for (const distance of [50, 200, 800, 3000]) {
    const ahead = toScreen(cam, 0, -distance);
    near(ahead.x, 195);
    assert.ok(ahead.y < previous.y, `${distance} px ahead is higher up`);
    assert.ok(ahead.scale < previous.scale, `${distance} px ahead is smaller`);
    assert.ok(ahead.y > cam.horizon, 'below the horizon');
    previous = ahead;
  }
  // Behind the car is lower down and larger.
  const behind = toScreen(cam, 0, 60);
  assert.ok(behind.y > car.y && behind.scale > 1);
  // To the right of the direction of travel is to the right on the screen.
  assert.ok(toScreen(cam, 40, -100).x > 195);
});

test('the view turns with the bearing: the direction of travel always points up the screen', () => {
  for (const bearing of [0, 45, 90, 180, 271.5]) {
    const cam = camera({ ...VIEW, tilted: true, bearing });
    const radians = (bearing * Math.PI) / 180;
    // 300 pixels along the bearing, east being +x and north -y on the map.
    const ahead = toScreen(cam, 300 * Math.sin(radians), -300 * Math.cos(radians));
    near(ahead.x, 195, 1e-6, `bearing ${bearing}`);
    assert.ok(ahead.y < cam.carY);
    // And 50 pixels to the right of it, seen from the car, is right of the middle.
    const right = toScreen(cam, 50 * Math.cos(radians), 50 * Math.sin(radians));
    assert.ok(right.x > 195, `bearing ${bearing}`);
    near(right.y, cam.carY, 1e-6);
  }
});

test('height above the ground is drawn upwards and nearer', () => {
  const cam = camera({ ...VIEW, tilted: true, bearing: 30 });
  const ground = toScreen(cam, 10, -10);
  const roof = toScreen(cam, 10, -10, 15);
  assert.ok(roof.y < ground.y);
  assert.ok(roof.scale > ground.scale);
  assert.ok(roof.depth < ground.depth);
  assert.ok(inView(cam, 0, 0, 15).z > 0);
});

test('a point on the screen below the horizon leads back to the ground point drawn there', () => {
  const cam = camera({ ...VIEW, tilted: true, bearing: 123 });
  for (const [x, y] of [[0, 0], [37, -250], [-120, 90], [400, -900]]) {
    const screen = toScreen(cam, x, y);
    const ground = toGround(cam, screen.x, screen.y);
    near(ground.x, x, 1e-6, 'x');
    near(ground.y, y, 1e-6, 'y');
  }
  // Above the horizon there is no ground.
  assert.equal(toGround(cam, 195, cam.horizon - 5), null);
  assert.ok(cam.horizon > 0 && cam.horizon < cam.carY);
});

test('the visible ground reaches from below the car to the haze, wider far away', () => {
  const cam = camera({ ...VIEW, tilted: true, bearing: 90 });
  const corners = visibleGround(cam);
  assert.equal(corners.length, 4);
  // Facing east: the far corners are about FAR_PX east of the car, the near ones a little west of it.
  near(corners[2].x, FAR_PX, 1e-6);
  near(corners[3].x, FAR_PX, 1e-6);
  assert.ok(corners[0].x < 0 && corners[0].x > -300);
  const nearWidth = Math.abs(corners[1].y - corners[0].y);
  const farWidth = Math.abs(corners[2].y - corners[3].y);
  assert.ok(farWidth > 2 * nearWidth, `${farWidth} against ${nearWidth}`);
  // Every corner of a flat view is a corner of the view.
  const flat = visibleGround(camera(VIEW));
  assert.deepEqual(flat, [
    { x: -195, y: 235 },
    { x: 195, y: 235 },
    { x: 195, y: -235 },
    { x: -195, y: -235 },
  ]);
});

test('the CSS of the ground follows the same sums', () => {
  const tilted = groundCss(camera({ ...VIEW, tilted: true, bearing: 90 }), 1000, 2000);
  assert.match(tilted.transform, /^translate3d\(195\.00px, 366\.60px, 0\) rotateX\(1\.04720rad\) rotateZ\(-1\.57080rad\) translate3d\(-1000\.00px, -2000\.00px, 0\)$/);
  assert.equal(tilted.perspective, '423.00px');
  assert.equal(tilted.origin, '195.00px 366.60px');
  const flat = groundCss(camera(VIEW), 1000, 2000);
  assert.equal(flat.transform, 'translate3d(-805.00px, -1765.00px, 0)');
  assert.equal(flat.perspective, 'none');
});

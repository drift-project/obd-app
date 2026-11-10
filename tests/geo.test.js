import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TILE_SIZE, advance, metersPerPixel, project, tilesInView } from '../src/geo.js';

const close = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('the whole world is one tile at zoom 0 and doubles with every level', () => {
  assert.deepEqual(project(0, 0, 0), { x: 128, y: 128 });
  assert.deepEqual(project(0, 0, 3), { x: 1024, y: 1024 });
  close(project(0, -180, 0).x, 0, 1e-9);
  close(project(0, 180, 0).x, 256, 1e-9);
  // The map ends at the latitude where it becomes a square; beyond it positions stay on the edge.
  close(project(85.05112878, 0, 0).y, 0, 1e-6);
  close(project(89.9, 0, 0).y, 0, 1e-6);
  close(project(-89.9, 0, 0).y, 256, 1e-6);
});

test('a place lands in the tile the tile servers number for it', () => {
  // Centre of Warsaw at zoom 16, with the latitude formula of the OpenStreetMap wiki.
  const latitude = 52.2296756;
  const longitude = 21.0122287;
  const count = 2 ** 16;
  const expectedX = Math.floor(((longitude + 180) / 360) * count);
  const expectedY = Math.floor(((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * count);
  const point = project(latitude, longitude, 16);
  assert.equal(Math.floor(point.x / TILE_SIZE), expectedX);
  assert.equal(Math.floor(point.y / TILE_SIZE), expectedY);
  assert.equal(expectedX, 36593);
});

test('the view is covered by the tiles around its centre', () => {
  // Centred on a corner where four tiles meet.
  const corner = { x: 10 * TILE_SIZE, y: 20 * TILE_SIZE };
  assert.deepEqual(tilesInView(corner, 512, 512, 6), [
    { x: 9, y: 19, left: 0, top: 0 },
    { x: 10, y: 19, left: 256, top: 0 },
    { x: 9, y: 20, left: 0, top: 256 },
    { x: 10, y: 20, left: 256, top: 256 },
  ]);
  // Centred in the middle of a tile: that tile and a strip of its neighbours.
  const middle = { x: 10.5 * TILE_SIZE, y: 20.5 * TILE_SIZE };
  const tiles = tilesInView(middle, 300, 300, 6);
  assert.equal(tiles.length, 9);
  assert.deepEqual(tiles[4], { x: 10, y: 20, left: 22, top: 22 });
});

test('a small view inside one tile needs only that tile', () => {
  const tiles = tilesInView({ x: 10.5 * TILE_SIZE, y: 20.5 * TILE_SIZE }, 100, 100, 6);
  assert.deepEqual(tiles, [{ x: 10, y: 20, left: -78, top: -78 }]);
});

test('columns wrap around the date line, rows beyond the poles are left out', () => {
  const tiles = tilesInView({ x: 0, y: 0 }, 256, 256, 2);
  // West of the first column is the last one; there is nothing north of the first row.
  assert.deepEqual(tiles, [
    { x: 3, y: 0, left: -128, top: 128 },
    { x: 0, y: 0, left: 128, top: 128 },
  ]);
});

test('a step along a course moves the right way by the right amount', () => {
  const north = advance(52, 21, 0, 111.195);
  close(north.latitude, 52.001, 1e-6);
  close(north.longitude, 21, 1e-9);
  // A degree of longitude is half as long at 60 degrees north.
  const east = advance(60, 21, 90, 111.195);
  close(east.latitude, 60, 1e-9);
  close(east.longitude, 21.002, 1e-5);
  const southWest = advance(0, 0, 225, 100);
  assert.ok(southWest.latitude < 0 && southWest.longitude < 0);
});

test('map scale matches the size of the Earth', () => {
  close(metersPerPixel(0, 0), 156543, 1);
  close(metersPerPixel(60, 0), 78271.5, 1);
  // About 30 cm a pixel at street level in Warsaw.
  close(metersPerPixel(52.23, 18), 0.366, 0.01);
});

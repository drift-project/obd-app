// In the car the app starts from the service worker cache, with no server to
// fall back on. A file missing from the cache list breaks that start, so the
// list is checked against what the page actually loads.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function cachedAssets() {
  const list = /const ASSETS = \[([\s\S]*?)\];/.exec(read('sw.js'))[1];
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const missing = (paths) => {
  const assets = new Set(cachedAssets());
  return [...new Set(paths)].filter((path) => !assets.has(path));
};

test('every script of the app is in the offline cache list', () => {
  const scripts = readdirSync(new URL('src/', root))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `src/${name}`);
  assert.ok(scripts.length > 0);
  assert.deepEqual(missing(scripts), []);
});

test('every file the page, the stylesheet and the manifest refer to is in the offline cache list', () => {
  const referenced = [
    ...[...read('index.html').matchAll(/(?:href|src)="([^"#:]+)"/g)].map((match) => match[1]),
    ...[...read('styles.css').matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]),
    ...JSON.parse(read('manifest.webmanifest')).icons.map((icon) => icon.src),
  ];
  assert.ok(referenced.includes('src/app.js') && referenced.includes('styles.css'));
  assert.deepEqual(missing(referenced), []);
});

test('every file in the offline cache list exists', () => {
  const absent = cachedAssets().filter((path) => path !== './' && !existsSync(new URL(path, root)));
  assert.deepEqual(absent, []);
});

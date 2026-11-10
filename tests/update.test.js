// When a new release takes over, the page reloads itself into it or offers it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchUpdates } from '../src/update.js';

/** A page with navigator.serviceWorker as far as the page uses it, run by `controller`. */
function page({ controller = { release: 'N' }, busy = false, touched = false } = {}) {
  const calls = [];
  const state = { busy, touched };
  const container = new EventTarget();
  container.controller = controller;
  const waiting = watchUpdates(container, {
    busy: () => state.busy,
    touched: () => state.touched,
    reload: () => calls.push('reload'),
    offer: () => calls.push('offer'),
  });
  return { calls, state, waiting, takeOver: () => container.dispatchEvent(new Event('controllerchange')) };
}

test('a new release reloads a page nobody has touched yet', () => {
  const idle = page();
  assert.equal(idle.waiting(), false);
  idle.takeOver();
  assert.deepEqual(idle.calls, ['reload']);
  assert.equal(idle.waiting(), true);
});

test('a page in use is offered the new release, and one that records is never reloaded', () => {
  const used = page({ touched: true });
  used.takeOver();
  assert.deepEqual(used.calls, ['offer']);
  const recording = page({ busy: true });
  recording.takeOver();
  assert.deepEqual(recording.calls, ['offer']);
  assert.equal(recording.waiting(), true);
});

test('the first worker of a browser brings nothing newer, and a release is offered once', () => {
  const first = page({ controller: null });
  first.takeOver();
  assert.deepEqual(first.calls, []);
  assert.equal(first.waiting(), false);
  const used = page({ touched: true });
  used.takeOver();
  used.takeOver();
  assert.deepEqual(used.calls, ['offer']);
});

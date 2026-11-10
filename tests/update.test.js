// A new release waits until a loaded page lets it take over, and the page then loads itself again or offers it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchUpdates } from '../src/update.js';

/** A service worker as the page sees it. */
class FakeWorker extends EventTarget {
  constructor(state = 'installing') {
    super();
    this.state = state;
    this.messages = [];
  }

  postMessage(data) {
    this.messages.push(data);
  }

  become(state) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

/** A page with navigator.serviceWorker and its registration, as far as the page uses them. */
function page({ controlled = true, busy = false, touched = false, waiting = null } = {}) {
  const calls = [];
  const state = { busy, touched };
  const container = new EventTarget();
  container.controller = controlled ? new FakeWorker('activated') : null;
  const registration = new EventTarget();
  registration.waiting = waiting;
  registration.installing = null;
  const update = watchUpdates(container, registration, {
    busy: () => state.busy,
    touched: () => state.touched,
    reload: () => calls.push('reload'),
    offer: () => calls.push('offer'),
  });
  return {
    calls,
    state,
    update,
    /** The browser has found a new release and starts storing it. */
    found: () => {
      const worker = new FakeWorker();
      registration.installing = worker;
      registration.dispatchEvent(new Event('updatefound'));
      return worker;
    },
    /** The new release has taken over. */
    tookOver: () => container.dispatchEvent(new Event('controllerchange')),
  };
}

test('a release stored while the page is idle takes over when the page lets it, and the page reloads', () => {
  const idle = page();
  const next = idle.found();
  assert.deepEqual(next.messages, [], 'not while it is still downloading');
  assert.equal(idle.update.waiting(), false);
  next.become('installed');
  assert.deepEqual(next.messages, ['take-over']);
  assert.deepEqual(idle.calls, [], 'the page loads again only once the new release has taken over');
  idle.tookOver();
  assert.deepEqual(idle.calls, ['reload']);
});

test('a page in use is offered the release, and lets it take over with Reload', () => {
  const used = page({ touched: true });
  const next = used.found();
  next.become('installed');
  assert.deepEqual(used.calls, ['offer']);
  assert.deepEqual(next.messages, []);
  assert.equal(used.update.waiting(), true);
  used.update.takeOver();
  assert.deepEqual(next.messages, ['take-over']);
  used.tookOver();
  assert.deepEqual(used.calls, ['offer', 'reload']);
});

test('a page that records is offered the release and never reloaded by it', () => {
  const recording = page({ busy: true });
  const next = recording.found();
  next.become('installed');
  assert.deepEqual(recording.calls, ['offer']);
  assert.deepEqual(next.messages, []);
});

test('a release already waiting when the page was loaded is found', () => {
  const waiting = new FakeWorker('installed');
  const idle = page({ waiting });
  assert.deepEqual(waiting.messages, ['take-over']);
  idle.tookOver();
  assert.deepEqual(idle.calls, ['reload']);
});

test('the first worker of a browser brings nothing newer: the page is left alone', () => {
  const first = page({ controlled: false });
  const worker = first.found();
  worker.become('installed');
  first.tookOver();
  assert.deepEqual(first.calls, []);
  assert.deepEqual(worker.messages, []);
});

test('Reload without a release that can take over just loads the page again', () => {
  const used = page({ touched: true });
  const next = used.found();
  next.become('installed');
  next.become('redundant');
  used.update.takeOver();
  assert.deepEqual(next.messages, []);
  assert.deepEqual(used.calls, ['offer', 'reload']);
});

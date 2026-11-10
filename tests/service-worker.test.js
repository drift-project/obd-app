// The service worker decides whether the phone starts the app with no network
// and whether a published fix arrives with the next reload. Here it runs
// against a fake cache storage, a fake server and a timeout fired by hand.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pages.test';
const BASE = `${ORIGIN}/obd-app/`;
const PAGE = BASE;
const SCRIPT = `${BASE}src/app.js`;
const OWN_PREFIX = 'drifthing-obd-';

const reply = (body, status = 200) => ({
  body,
  status,
  ok: status >= 200 && status < 300,
  clone: () => reply(body, status),
});

const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  const result = {};
  result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }));
  return result;
}

class FakeRequest {
  constructor(input, init = {}) {
    const from = typeof input === 'string' ? { url: input } : input;
    this.url = new URL(from.url, BASE).href;
    this.method = init.method ?? from.method ?? 'GET';
    this.cache = init.cache ?? from.cache ?? 'default';
  }
}

/** Load sw.js with fake browser objects and return handles to drive and inspect it. */
function startWorker({ otherCaches = [] } = {}) {
  const handlers = {};
  const storage = new Map(otherCaches.map((name) => [name, new Map()]));
  const asked = []; // every request that reached the server
  const server = new Map(); // url -> function returning the answer
  const timeouts = [];
  const counts = { skipWaiting: 0, claim: 0 };
  let writesFail = false;

  const fetch = (input, init = {}) => {
    const request = new FakeRequest(input, init);
    asked.push({ url: request.url, cache: request.cache });
    const respond = server.get(request.url);
    return respond ? respond() : Promise.resolve(reply(`fresh ${request.url}`));
  };

  const withoutQuery = (url) => url.split('?')[0];
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) {
            const answer = await fetch(request);
            if (!answer.ok) throw new TypeError(`cannot store ${request.url}`);
            entries.set(request.url, answer);
          }
        },
        async put(request, answer) {
          if (writesFail) throw new DOMException('disk full', 'QuotaExceededError');
          entries.set(request.url, answer);
        },
        async match(request, { ignoreSearch = false } = {}) {
          const same = (url) => (ignoreSearch ? withoutQuery(url) === withoutQuery(request.url) : url === request.url);
          return [...entries].find(([url]) => same(url))?.[1];
        },
      };
    },
    keys: async () => [...storage.keys()],
    delete: async (name) => storage.delete(name),
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => {
      counts.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        counts.claim += 1;
      },
    },
  };
  const setTimeout = (callback) => timeouts.push(callback);

  // The worker script runs as it is, with these objects as its whole global scope.
  runInNewContext(source, { self, caches, fetch, Request: FakeRequest, setTimeout, URL }, { filename: 'sw.js' });

  const dispatch = (type, request) => {
    const waits = [];
    const event = {
      request,
      response: undefined,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        event.response = Promise.resolve(promise);
      },
      settled: () => Promise.all(waits),
    };
    handlers[type](event);
    return event;
  };

  const current = () => [...storage.keys()].find((name) => name.startsWith(OWN_PREFIX) && !otherCaches.includes(name));
  return {
    asked,
    server,
    counts,
    current,
    install: () => dispatch('install').settled(),
    activate: () => dispatch('activate').settled(),
    get: (url, method = 'GET') => dispatch('fetch', new FakeRequest(url, { method })),
    fireTimeout: () => timeouts.splice(0).forEach((callback) => callback()),
    failWrites: () => {
      writesFail = true;
    },
    cacheNames: () => [...storage.keys()],
    storedUrls: () => [...storage.get(current()).keys()],
    storedBody: (url) => storage.get(current()).get(url)?.body,
    keep: (url, body) => storage.get(current()).set(url, reply(body)),
  };
}

async function installed(options) {
  const worker = startWorker(options);
  await worker.install();
  return worker;
}

test('install stores the app and asks the server for every file', async () => {
  const worker = await installed();
  const urls = worker.storedUrls();
  assert.ok(urls.includes(PAGE) && urls.includes(SCRIPT) && urls.includes(`${BASE}styles.css`), urls.join(', '));
  assert.equal(worker.asked.length, urls.length);
  // 'no-cache' makes the browser check with the server instead of trusting its HTTP cache.
  assert.ok(worker.asked.every((request) => request.cache === 'no-cache'));
  assert.equal(worker.counts.skipWaiting, 1);
});

test('activation removes only the older caches of this app and takes over open pages', async () => {
  // Every site of one organization shares the github.io origin, and with it the cache storage.
  const worker = await installed({ otherCaches: [`${OWN_PREFIX}v1`, 'another-site-v7'] });
  await worker.activate();
  assert.deepEqual(worker.cacheNames(), ['another-site-v7', worker.current()]);
  assert.equal(worker.counts.claim, 1);
});

test('a reachable server wins and its answer replaces the stored copy', async () => {
  const worker = await installed();
  worker.keep(SCRIPT, 'old');
  worker.server.set(SCRIPT, async () => reply('new'));
  const event = worker.get(SCRIPT);
  assert.equal((await event.response).body, 'new');
  await event.settled();
  assert.equal(worker.storedBody(SCRIPT), 'new');
  assert.deepEqual(worker.asked.at(-1), { url: SCRIPT, cache: 'no-cache' });
});

test('without a connection the stored copy is used, whatever the query string', async () => {
  const worker = await installed();
  worker.keep(PAGE, 'stored page');
  const url = `${PAGE}?car=kline`;
  worker.server.set(url, offline);
  assert.equal((await worker.get(url).response).body, 'stored page');
});

test('an error answer from the server does not replace the stored copy', async () => {
  const worker = await installed();
  worker.keep(SCRIPT, 'old');
  worker.server.set(SCRIPT, async () => reply('server error', 503));
  const event = worker.get(SCRIPT);
  assert.equal((await event.response).body, 'old');
  await event.settled();
  assert.equal(worker.storedBody(SCRIPT), 'old');
});

test('an error answer for a file that is not stored is passed on', async () => {
  const worker = await installed();
  const url = `${BASE}missing.js`;
  worker.server.set(url, async () => reply('not found', 404));
  const event = worker.get(url);
  assert.equal((await event.response).status, 404);
  await event.settled();
  assert.equal(worker.storedBody(url), undefined);
});

test('a slow server is not waited for, but its answer is kept for the next start', async () => {
  const worker = await installed();
  worker.keep(SCRIPT, 'old');
  const slow = deferred();
  worker.server.set(SCRIPT, () => slow.promise);
  const event = worker.get(SCRIPT);
  worker.fireTimeout();
  assert.equal((await event.response).body, 'old');
  slow.resolve(reply('new'));
  await event.settled();
  assert.equal(worker.storedBody(SCRIPT), 'new');
});

test('a file that is not stored waits for a slow server', async () => {
  const worker = await installed();
  const url = `${BASE}late.js`;
  const slow = deferred();
  worker.server.set(url, () => slow.promise);
  const event = worker.get(url);
  worker.fireTimeout();
  let answered = false;
  event.response.then(() => {
    answered = true;
  });
  await nextTurn();
  assert.equal(answered, false);
  slow.resolve(reply('late but complete'));
  assert.equal((await event.response).body, 'late but complete');
});

test('a file that is neither stored nor reachable fails', async () => {
  const worker = await installed();
  const url = `${BASE}missing.js`;
  worker.server.set(url, offline);
  const event = worker.get(url);
  await assert.rejects(event.response, TypeError);
  await event.settled();
});

test('a full disk does not turn a good answer into a failure', async () => {
  const worker = await installed();
  worker.failWrites();
  worker.server.set(SCRIPT, async () => reply('new'));
  const event = worker.get(SCRIPT);
  assert.equal((await event.response).body, 'new');
  await event.settled();
});

test('requests to other sites and requests that change data are left to the browser', async () => {
  const worker = await installed();
  const before = worker.asked.length;
  assert.equal(worker.get('https://elsewhere.test/logo.png').response, undefined);
  assert.equal(worker.get(SCRIPT, 'POST').response, undefined);
  assert.equal(worker.asked.length, before);
});

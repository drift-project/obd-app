// The service worker decides whether the phone starts the app with no network,
// whether a published release arrives, and whether a page ever gets files of
// two releases at once. Here it runs against a fake cache storage, a fake
// server and a timeout fired by hand; two releases of it can share them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pages.test';
const BASE = `${ORIGIN}/obd-app/`;
const PAGE = BASE;
const SCRIPT = `${BASE}src/app.js`;
const MAP = `${BASE}src/map.js`;
const STYLES = `${BASE}styles.css`;
const EXAMPLE = `${BASE}examples/drifthing_log_20261110_202207.zip`;
const OWN_PREFIX = 'drifthing-obd-';

class FakeHeaders {
  #entries = new Map();

  constructor(init = {}) {
    for (const [name, value] of init instanceof FakeHeaders ? init.entries() : Object.entries(init)) this.set(name, value);
  }

  set(name, value) {
    this.#entries.set(name.toLowerCase(), String(value));
  }

  get(name) {
    return this.#entries.get(name.toLowerCase()) ?? null;
  }

  entries() {
    return [...this.#entries];
  }
}

class FakeResponse {
  constructor(body, { status = 200, statusText = '', headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = new FakeHeaders(headers);
  }

  clone() {
    return new FakeResponse(this.body, { status: this.status, statusText: this.statusText, headers: this.headers });
  }
}

// What a static host sends: the browser may keep the file for ten minutes without asking again.
const reply = (body, status = 200) => new FakeResponse(body, { status, headers: { 'Cache-Control': 'max-age=600', 'Content-Type': 'text/javascript' } });

const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const releaseOf = (answer) => answer.body.split(' ')[0];

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

/**
 * A phone with its cache storage and the server it loads the app from. Every
 * file on the server answers with the name of the release published there
 * and its address, unless `server` holds an answer of its own for it.
 */
function site({ otherCaches = [] } = {}) {
  const storage = new Map(otherCaches.map((name) => [name, new Map()]));
  const asked = []; // every request that reached the server
  const server = new Map(); // url -> function returning the answer
  const timeouts = [];
  let published = 'N';
  let connected = true;
  let writesFail = false;

  const fetch = (input, init = {}) => {
    const request = new FakeRequest(input, init);
    asked.push({ url: request.url, cache: request.cache });
    if (!connected) return offline();
    const respond = server.get(request.url);
    return respond ? respond() : Promise.resolve(reply(`${published} ${request.url}`));
  };

  const withoutQuery = (url) => url.split('?')[0];
  const open = async (name) => {
    if (!storage.has(name)) storage.set(name, new Map());
    const entries = storage.get(name);
    return {
      // As in the browser: every answer has to arrive and be good, or nothing is stored.
      async addAll(requests) {
        const answers = [];
        for (const request of requests) {
          const answer = await fetch(request);
          if (!answer.ok) throw new TypeError(`cannot store ${request.url}`);
          answers.push([request.url, answer]);
        }
        for (const [url, answer] of answers) entries.set(url, answer);
      },
      async put(request, answer) {
        if (writesFail) throw new DOMException('disk full', 'QuotaExceededError');
        entries.set(request.url, answer);
      },
      async match(request, { ignoreSearch = false } = {}) {
        const url = typeof request === 'string' ? request : request.url;
        const same = (stored) => (ignoreSearch ? withoutQuery(stored) === withoutQuery(url) : stored === url);
        return [...entries].find(([stored]) => same(stored))?.[1]?.clone();
      },
    };
  };

  /** The worker of one release: the source as it is, or with its cache named after `release`. */
  function worker(release = null) {
    const code = release === null ? source : source.replace(/const CACHE = [^;]+;/, `const CACHE = '${OWN_PREFIX}${release}';`);
    assert.ok(release === null || code !== source, 'the cache name of sw.js was found');
    const handlers = {};
    const counts = { skipWaiting: 0, claim: 0 };
    const opened = new Set();
    const caches = {
      open: (name) => {
        opened.add(name);
        return open(name);
      },
      keys: async () => [...storage.keys()],
      delete: async (name) => storage.delete(name),
    };
    const self = {
      location: { origin: ORIGIN, href: `${BASE}sw.js` },
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
    runInNewContext(code, { self, caches, fetch, Request: FakeRequest, Response: FakeResponse, Headers: FakeHeaders, setTimeout, URL }, { filename: 'sw.js' });

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

    const cacheName = () => [...opened].find((name) => name.startsWith(OWN_PREFIX));
    return {
      counts,
      cacheName,
      install: () => dispatch('install').settled(),
      activate: () => dispatch('activate').settled(),
      get: (url, method = 'GET') => dispatch('fetch', new FakeRequest(url, { method })),
      storedUrls: () => [...storage.get(cacheName()).keys()],
      storedBody: (url) => storage.get(cacheName()).get(url)?.body,
      keep: (url, body) => storage.get(cacheName()).set(url, reply(body)),
      drop: (url) => storage.get(cacheName()).delete(url),
    };
  }

  return {
    asked,
    server,
    worker,
    /** A new release on the server. */
    publish: (release) => {
      published = release;
    },
    disconnect: () => {
      connected = false;
    },
    failWrites: () => {
      writesFail = true;
    },
    fireTimeout: () => timeouts.splice(0).forEach((callback) => callback()),
    cacheNames: () => [...storage.keys()],
  };
}

/** A phone that has installed the release on the server and runs it. */
async function running(options) {
  const phone = site(options);
  const worker = phone.worker();
  await worker.install();
  await worker.activate();
  return { phone, worker };
}

test('install stores the app and asks the server for every file', async () => {
  const phone = site();
  const worker = phone.worker();
  await worker.install();
  const urls = worker.storedUrls();
  assert.ok(urls.includes(PAGE) && urls.includes(SCRIPT) && urls.includes(STYLES), urls.join(', '));
  assert.equal(phone.asked.length, urls.length);
  // 'no-cache' makes the browser check with the server instead of trusting its HTTP cache.
  assert.ok(phone.asked.every((request) => request.cache === 'no-cache'));
  assert.equal(worker.counts.skipWaiting, 1);
});

test('activation removes only the older caches of this app and takes over open pages', async () => {
  // Every site of one organization shares the github.io origin, and with it the cache storage.
  const { phone, worker } = await running({ otherCaches: [`${OWN_PREFIX}v1`, 'another-site-v7'] });
  assert.deepEqual(phone.cacheNames(), ['another-site-v7', worker.cacheName()]);
  assert.equal(worker.counts.claim, 1);
});

test('the files of the app come from the release on the phone, without asking the server', async () => {
  const { phone, worker } = await running();
  phone.publish('N+1');
  const before = phone.asked.length;
  for (const url of [PAGE, `${PAGE}?car=kline`, `${BASE}index.html`, SCRIPT, MAP]) {
    const answer = await worker.get(url).response;
    assert.equal(answer.body, `N ${url.split('?')[0]}`);
  }
  assert.equal(phone.asked.length, before);
});

test('a file of the app is marked for the browser to ask for it again at the next load', async () => {
  // Kept for ten minutes as the host allows, a module of the release before could join the next page.
  const { worker } = await running();
  const answer = await worker.get(SCRIPT).response;
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('Cache-Control'), 'no-cache');
  assert.equal(answer.headers.get('Content-Type'), 'text/javascript');
});

test('without a connection the app starts from the phone, whatever the query string', async () => {
  const { phone, worker } = await running();
  phone.disconnect();
  assert.equal((await worker.get(`${PAGE}?car=kline`).response).body, `N ${PAGE}`);
  assert.equal((await worker.get(SCRIPT).response).body, `N ${SCRIPT}`);
});

test('a page loaded while the next release downloads gets every file from the release before', async () => {
  // Release N runs and N+1 is published; some of its files come fast, one slower than any timeout.
  const { phone, worker } = await running();
  phone.publish('N+1');
  const slow = deferred();
  phone.server.set(MAP, () => slow.promise);
  // The browser has found the worker of N+1, which stores the release before it takes over.
  const next = phone.worker('next');
  const installing = next.install();
  const loads = [PAGE, SCRIPT, MAP, STYLES].map((url) => worker.get(url).response);
  await nextTurn();
  phone.fireTimeout();
  const page = await Promise.all(loads);
  assert.deepEqual(page.map(releaseOf), ['N', 'N', 'N', 'N']);
  assert.equal(next.counts.skipWaiting, 0, 'not before the slow file is there');
  slow.resolve(reply(`N+1 ${MAP}`));
  await installing;
  await next.activate();
  // From now on every file is of N+1, and N is gone.
  const after = await Promise.all([PAGE, SCRIPT, MAP, STYLES].map((url) => next.get(url).response));
  assert.deepEqual(after.map(releaseOf), ['N+1', 'N+1', 'N+1', 'N+1']);
  assert.deepEqual(phone.cacheNames(), [next.cacheName()]);
});

test('a download of the next release that breaks off leaves the running one as it was', async () => {
  const { phone, worker } = await running();
  phone.publish('N+1');
  phone.server.set(MAP, offline);
  const next = phone.worker('next');
  await assert.rejects(next.install());
  assert.equal(next.counts.skipWaiting, 0);
  assert.equal(next.storedUrls().length, 0, 'nothing of N+1 is kept');
  assert.equal((await worker.get(MAP).response).body, `N ${MAP}`);
  assert.equal((await worker.get(SCRIPT).response).body, `N ${SCRIPT}`);
  // The next time the app is opened the download is complete, and N+1 takes over.
  phone.server.delete(MAP);
  const again = phone.worker('next');
  await again.install();
  await again.activate();
  assert.equal((await again.get(MAP).response).body, `N+1 ${MAP}`);
  assert.deepEqual(phone.cacheNames(), [again.cacheName()]);
});

test('a file of the app the browser has dropped is fetched from the server', async () => {
  const { phone, worker } = await running();
  worker.drop(SCRIPT);
  phone.publish('N+1');
  assert.equal((await worker.get(SCRIPT).response).body, `N+1 ${SCRIPT}`);
});

test('another file of the site comes from the server when it can, and is kept', async () => {
  const { phone, worker } = await running();
  worker.keep(EXAMPLE, 'old');
  phone.server.set(EXAMPLE, async () => reply('new'));
  const event = worker.get(EXAMPLE);
  assert.equal((await event.response).body, 'new');
  await event.settled();
  assert.equal(worker.storedBody(EXAMPLE), 'new');
  assert.deepEqual(phone.asked.at(-1), { url: EXAMPLE, cache: 'no-cache' });
});

test('without a connection another file of the site that was kept is used', async () => {
  const { phone, worker } = await running();
  worker.keep(EXAMPLE, 'kept');
  phone.disconnect();
  assert.equal((await worker.get(`${EXAMPLE}?again=1`).response).body, 'kept');
});

test('an error answer from the server does not replace the kept copy', async () => {
  const { phone, worker } = await running();
  worker.keep(EXAMPLE, 'old');
  phone.server.set(EXAMPLE, async () => reply('server error', 503));
  const event = worker.get(EXAMPLE);
  assert.equal((await event.response).body, 'old');
  await event.settled();
  assert.equal(worker.storedBody(EXAMPLE), 'old');
});

test('an error answer for a file that is not kept is passed on', async () => {
  const { phone, worker } = await running();
  const url = `${BASE}missing.js`;
  phone.server.set(url, async () => reply('not found', 404));
  const event = worker.get(url);
  assert.equal((await event.response).status, 404);
  await event.settled();
  assert.equal(worker.storedBody(url), undefined);
});

test('a slow server is not waited for, but its answer is kept for the next time', async () => {
  const { phone, worker } = await running();
  worker.keep(EXAMPLE, 'old');
  const slow = deferred();
  phone.server.set(EXAMPLE, () => slow.promise);
  const event = worker.get(EXAMPLE);
  phone.fireTimeout();
  assert.equal((await event.response).body, 'old');
  slow.resolve(reply('new'));
  await event.settled();
  assert.equal(worker.storedBody(EXAMPLE), 'new');
});

test('a file that is not kept waits for a slow server', async () => {
  const { phone, worker } = await running();
  const url = `${BASE}late.js`;
  const slow = deferred();
  phone.server.set(url, () => slow.promise);
  const event = worker.get(url);
  phone.fireTimeout();
  let answered = false;
  event.response.then(() => {
    answered = true;
  });
  await nextTurn();
  assert.equal(answered, false);
  slow.resolve(reply('late but complete'));
  assert.equal((await event.response).body, 'late but complete');
});

test('a file that is neither kept nor reachable fails', async () => {
  const { phone, worker } = await running();
  const url = `${BASE}missing.js`;
  phone.server.set(url, offline);
  const event = worker.get(url);
  await assert.rejects(event.response, TypeError);
  await event.settled();
});

test('a full disk does not turn a good answer into a failure', async () => {
  const { phone, worker } = await running();
  phone.failWrites();
  phone.server.set(EXAMPLE, async () => reply('new'));
  const event = worker.get(EXAMPLE);
  assert.equal((await event.response).body, 'new');
  await event.settled();
});

test('requests to other sites and requests that change data are left to the browser', async () => {
  const { phone, worker } = await running();
  const before = phone.asked.length;
  assert.equal(worker.get('https://elsewhere.test/logo.png').response, undefined);
  assert.equal(worker.get(SCRIPT, 'POST').response, undefined);
  assert.equal(phone.asked.length, before);
});

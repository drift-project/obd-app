// Offline support and updates. The app starts in the car without a connection
// to the server it was loaded from, and every start runs the files of one
// release: the page and the modules it imports change together from one
// release to the next, and a mix of two can break in ways that are hard to
// make out from a distance.
//
// Each release comes with a new copy of this file, as its cache is named after
// the version of the app (APP_VERSION in src/app.js; a test checks the two
// agree). Only a changed copy makes the phones fetch a release: the browser
// looks for one whenever the app is opened. The new copy stores
// the whole app in a cache of its own; a slow or broken connection leaves the
// running release as it is, and the download is tried again the next time.
// Stored, the new release waits: a page that has loaded all its files lets it
// take over ('take-over', see src/update.js) and loads itself again, and
// otherwise it takes over by itself once no page of the release before is
// open. It never takes over while a page is still loading the files of the
// release before. Once it has, the caches of older releases are removed.
//
// The files of the app are answered from the cache of the running release,
// without asking the server, and marked 'no-cache' for the browser. Without
// that mark a page loaded after an update could take a module the browser
// still holds in memory from the release before. Anything else of this site
// (the example recordings) is asked from the server first, and a good answer
// is stored; the stored copy is used when the server cannot be reached,
// answers with an error or needs longer than the timeout.

// Cache storage belongs to the whole origin, and a static host may serve other
// sites from other folders of the same origin. Only caches with this prefix
// are ever removed here.
const CACHE_PREFIX = 'drifthing-obd-';
const CACHE = `${CACHE_PREFIX}0.10.1`;
const NETWORK_TIMEOUT_MS = 2500;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/app.js',
  'src/backend-export.js',
  'src/battery.js',
  'src/camera.js',
  'src/car-model.js',
  'src/chart.js',
  'src/clock.js',
  'src/csv.js',
  'src/demo-drive.js',
  'src/drift-replay.js',
  'src/drift.js',
  'src/elm327.js',
  'src/engine.js',
  'src/geo.js',
  'src/grip-chart.js',
  'src/map.js',
  'src/pids.js',
  'src/poller.js',
  'src/replay-view.js',
  'src/replay.js',
  'src/samples.js',
  'src/sensors.js',
  'src/simulator.js',
  'src/storage.js',
  'src/summary.js',
  'src/trace.js',
  'src/track.js',
  'src/transports.js',
  'src/trim.js',
  'src/update.js',
  'src/voice.js',
  'src/wheels.js',
  'src/zip.js',
  'assets/logo.svg',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/fonts/saira-extrabold-italic.ttf',
];
// The files of the app by their full address without a query: './?car=kline' is the page too.
const APP_FILES = new Set(ASSETS.map((path) => new URL(path, self.location.href).href));

self.addEventListener('install', (event) => {
  // All or nothing: one file that cannot be fetched fails the install, and the running release stays.
  // 'no-cache' makes the browser check every file with the server instead of trusting its HTTP cache.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'no-cache' })))));
});

// A page of the release before has loaded all its files and is not recording: the new release may take over.
self.addEventListener('message', (event) => {
  if (event.data === 'take-over') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE))
      .then((outdated) => Promise.all(outdated.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** A stored file of the app, marked so that the browser asks for it again at the next load. */
function unshared(stored) {
  const headers = new Headers(stored.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(stored.body, { status: stored.status, statusText: stored.statusText, headers });
}

/** A file of the app from the running release; from the server only if the browser has dropped the stored copy. */
async function appFile(request, url) {
  const cache = await caches.open(CACHE);
  const stored = await cache.match(url, { ignoreVary: true });
  return stored ? unshared(stored) : fetch(request);
}

/** Ask the server and keep a good answer for later. */
async function fromServer(request) {
  const response = await fetch(request, { cache: 'no-cache' });
  if (response.ok) {
    const copy = response.clone();
    // A full disk must not turn a good answer into a failure.
    await caches
      .open(CACHE)
      .then((cache) => cache.put(request, copy))
      .catch(() => {});
  }
  return response;
}

/** The server's answer if it is good and in time, otherwise the stored copy. */
async function answer(request, fresh) {
  const tooLate = new Promise((resolve) => {
    setTimeout(resolve, NETWORK_TIMEOUT_MS);
  });
  const response = await Promise.race([fresh, tooLate]).catch(() => undefined);
  if (response?.ok) return response;
  const cache = await caches.open(CACHE);
  const stored = await cache.match(request, { ignoreSearch: true });
  // Nothing stored: an error answer is passed on, and a slow server is waited for.
  return stored ?? response ?? fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  if (APP_FILES.has(url.href)) {
    event.respondWith(appFile(request, url.href));
    return;
  }
  const fresh = fromServer(request);
  // Keeps the worker alive until a slow answer has been stored.
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(answer(request, fresh));
});

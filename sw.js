// Offline support: the app starts in the car without a connection to the
// server it was loaded from, and picks up a new version as soon as the server
// can be reached again.
//
// Every request asks the server first, and a good answer replaces the stored
// copy. The stored copy is used when the server cannot be reached, answers
// with an error or needs longer than the timeout. A slow answer is still
// stored, so the next start has it.
//
// The browser's own HTTP cache is always revalidated ('no-cache'). A static
// host may let it serve a file for minutes without asking the server, which
// would keep an old version alive after an update.

// Cache storage belongs to the whole origin, and a static host may serve other
// sites from other folders of the same origin. Only caches with this prefix
// are ever removed here.
const CACHE_PREFIX = 'drifthing-obd-';
const CACHE = `${CACHE_PREFIX}v11`;
const NETWORK_TIMEOUT_MS = 2500;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/app.js',
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
  'src/wheels.js',
  'src/zip.js',
  'assets/logo.svg',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/fonts/saira-extrabold-italic.ttf',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
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
  const fresh = fromServer(request);
  // Keeps the worker alive until a slow answer has been stored.
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(answer(request, fresh));
});

// Offline support: the app keeps working in the car without a connection to
// the machine it was loaded from. Network first, so a reachable server always
// wins; the cache answers when the request fails or takes too long.

const CACHE = 'drifthing-obd-v1';
const NETWORK_TIMEOUT_MS = 2500;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/app.js',
  'src/csv.js',
  'src/elm327.js',
  'src/pids.js',
  'src/poller.js',
  'src/simulator.js',
  'src/storage.js',
  'src/transports.js',
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
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

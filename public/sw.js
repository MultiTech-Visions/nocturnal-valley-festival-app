// Offline cache for the app shell.
//
// VERSION names the cache and is what makes the browser reinstall this
// worker: only a change to THIS file's bytes triggers an update check.
// Bump it whenever the asset list below changes.
//
// It is deliberately not the only thing keeping clients current. A deploy
// that lands sw.js before the files it caches -- or a bump forgotten
// entirely -- used to strand a phone on an old build with no way back
// short of unregistering the worker by hand. So every asset below is now
// served cache-first and revalidated in the background: the cached copy
// answers instantly and works offline, while a fresh copy is fetched and
// stored for the next load. A stale client heals itself on the following
// reload instead of waiting for someone to notice.
const VERSION = 'V3';
const CACHE = `nv-${VERSION}`;
const ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/public/app.css',
  '/public/app.js',
  '/public/viewer.js',
  '/public/geo.js',
  '/public/store.js',
  '/public/share.js',
  '/public/points.js',
  '/public/qrcode.min.js',
  '/public/jsQR.min.js',
  '/public/calibration.json',
  '/public/map.jpg',
  '/public/icon-192.png',
  '/public/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses the browser's own HTTP cache, so a fresh
      // install can't fill itself with the copies it was meant to replace.
      // addAll stays all-or-nothing: one failed asset fails the install, so
      // the app never reports "ready" with a half-filled cache.
      .then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // /calibrate is password-protected and must never be cached: a cached copy
  // would be served without the server ever seeing the credentials again.
  if (!ASSETS.includes(url.pathname)) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(url.pathname);

      const fresh = fetch(e.request)
        .then((res) => {
          // Only a real 200 replaces a good cached copy. An error page or a
          // redirect to a login screen must not become the offline map.
          if (res.ok && res.status === 200) cache.put(url.pathname, res.clone());
          return res;
        })
        .catch((err) => {
          // Offline is the normal case here, not a fault: the cached copy
          // below is the answer. Rethrow only when there is nothing cached.
          if (hit === undefined) throw err;
          return null;
        });

      if (hit === undefined) return fresh;
      // Don't make the page wait on the network; let the refresh finish
      // after the response has already gone out.
      e.waitUntil(fresh);
      return hit;
    })
  );
});

// The page asks whether every asset is cached before showing "Ready offline".
self.addEventListener('message', (e) => {
  if (e.data !== 'status') return;
  caches.open(CACHE)
    .then((c) => Promise.all(ASSETS.map((a) => c.match(a))))
    .then((hits) => e.ports[0].postMessage({ version: VERSION, ready: hits.every((h) => h !== undefined) }));
});

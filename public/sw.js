// Bump VERSION on every deploy that changes any file below. The browser
// only reinstalls the service worker when this file's bytes change.
const VERSION = 'v1';
const CACHE = `nv-${VERSION}`;
const ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/public/app.css',
  '/public/app.js',
  '/public/viewer.js',
  '/public/geo.js',
  '/public/calibration.json',
  '/public/map.jpg',
  '/public/icon-192.png',
  '/public/icon-512.png'
];

self.addEventListener('install', (e) => {
  // addAll is all-or-nothing: one failed asset fails the install, so the
  // app never reports "ready" with a half-filled cache.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET' || url.origin !== location.origin || !ASSETS.includes(url.pathname)) return;
  e.respondWith(
    caches.match(url.pathname, { cacheName: CACHE }).then((hit) => (hit !== undefined ? hit : fetch(e.request)))
  );
});

// The page asks whether every asset is cached before showing "Ready offline".
self.addEventListener('message', (e) => {
  if (e.data !== 'status') return;
  caches.open(CACHE)
    .then((c) => Promise.all(ASSETS.map((a) => c.match(a))))
    .then((hits) => e.ports[0].postMessage({ version: VERSION, ready: hits.every((h) => h !== undefined) }));
});

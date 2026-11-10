// Spellbinder service worker — enables the install prompt and offline shell.
// Strategy: network-first for same-origin GETs (deploys show up immediately
// when online), cache fallback when offline. Cross-origin requests (Supabase
// API/Auth, Scryfall) are never intercepted or cached.
// The Phase 7c fingerprint pack (~15 MB) lives in its own cache: it changes
// at most when a new set releases, so app updates must never evict it.
const CACHE = 'spellbinder-v16';
const PACK_CACHE = 'spellbinder-fingerprint-v1';
const PACK_FILES = ['fingerprint-pack.bin', 'fingerprint-meta.json'];
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './fingerprint.js',
  './config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './privacy.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== PACK_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Fingerprint pack: cache-first from its dedicated cache, forever — the
  // page fetches it lazily on first Live scan open and never again.
  if (PACK_FILES.some((f) => url.pathname.endsWith('/' + f))) {
    event.respondWith(
      caches.open(PACK_CACHE).then((cache) =>
        cache.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
          if (res.ok) cache.put(event.request, res.clone()).catch(() => {});
          return res;
        })))
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

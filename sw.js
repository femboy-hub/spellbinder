// Spellbinder service worker — enables the install prompt and offline shell.
// Strategy: network-first for same-origin GETs (deploys show up immediately
// when online), cache fallback when offline. Cross-origin requests (Supabase
// API/Auth, Scryfall) are never intercepted or cached.
// The Phase 7c fingerprint pack (~15 MB) lives in its own cache: it changes
// at most when a new set releases, so app updates must never evict it.
const CACHE = 'spellbinder-v25';
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

// Package v18 — trade-request push notifications. The payload is sent by
// the send-push Edge Function as JSON:
//   { title, body, icon, data: { url: '/#trades', trade_id } }
// A plain-text payload (or none) still shows a sensible notification.
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); }
    catch (e) { payload = { body: event.data.text() }; }
  }
  const title = payload.title || 'New trade request';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    data: payload.data || { url: '/#trades' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an existing Spellbinder tab and takes
// it to the Trades view; with no tab open it opens one there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/#trades';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          if ('navigate' in client) {
            return client.navigate(target)
              .then((navigated) => (navigated || client).focus())
              .catch(() => client.focus());
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});

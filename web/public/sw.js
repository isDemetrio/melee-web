/*
 * Service worker: caches the shell only.
 *
 * Split of responsibilities, deliberately:
 *  - the shell (HTML, JS, CSS, the .wasm binary) is cache-first with a versioned cache
 *    name, so a new deployment invalidates it by changing the name;
 *  - game data is NOT cached here. It lives in OPFS, content-addressed by SHA-256, and is
 *    managed by the asset layer (docs/SPEC_PIANO.md §2.3). Caching a 100 MB asset in the
 *    HTTP cache would be evicted without warning; OPFS with `navigator.storage.persist()`
 *    is the supported place for it.
 */

const CACHE = 'melee-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve the API from cache: TURN credentials expire and the manifest changes.
  if (url.pathname.startsWith('/api/')) return;

  // The spike core is rebuilt per commit and must never be served from cache.
  if (url.pathname.startsWith('/spike-core/')) return;

  const isShell =
    SHELL.includes(url.pathname) ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.wasm');

  if (!isShell) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

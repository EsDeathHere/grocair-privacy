/* =========================================================
   Grocair — Service Worker (PWA offline)
   Strategi: navigasi network-first + fallback cache;
             aset statis stale-while-revalidate.
   Pesan {type:'SKIP_WAITING'} memaksa SW baru aktif segera.
   ========================================================= */

'use strict';

const CACHE = 'grocair-portfolio-demo-v1';
const ASSET = [
  './',
  './index.html',
  './styles.css',
  './print.css',
  './fonts.css',
  './sanitize.js',
  './store.js',
  './auth.js',
  './license.js',
  './flavor.js',
  './entitlement.js',
  './billing-mock.js',
  './receipt.js',
  './backup.js',
  './app.js',
  './demo.js',
  './scanner.js',
  './vendor/zxing.min.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSET)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('grocair-portfolio-demo-') && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);

  // Navigasi (halaman HTML): network-first, fallback ke cache.
  if (ev.request.mode === 'navigate') {
    ev.respondWith(
      fetch(ev.request).then((res) => {
        const klon = res.clone();
        caches.open(CACHE).then((cache) => cache.put(ev.request, klon));
        return res;
      }).catch(() => caches.match(ev.request).then((res) => res || caches.match('./index.html')))
    );
    return;
  }

  // Aset statis: stale-while-revalidate.
  ev.respondWith(
    caches.match(ev.request).then((cached) => {
      const fetchPromise = fetch(ev.request).then((res) => {
        if (res.ok) {
          const klon = res.clone();
          caches.open(CACHE).then((cache) => cache.put(ev.request, klon));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Pesan dari UI: {type:'SKIP_WAITING'} -> aktifkan SW baru segera.
self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

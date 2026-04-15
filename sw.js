const CACHE_NAME = 'rabi-kapada-v2'; // Updated to v2 to bust the old cache
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

// Install and cache
self.addEventListener('install', event => {
  self.skipWaiting(); // Force the new version to take over immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Clean up old caches (deletes v1)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// NETWORK FIRST STRATEGY: Always get the newest code if online, fallback to offline cache
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

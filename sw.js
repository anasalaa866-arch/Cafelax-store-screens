// CAFELAX Signage - Service Worker
// Caches all media for full offline support

const CACHE_NAME = 'cafelax-signage-v1';
const MEDIA_CACHE = 'cafelax-media-v1';

// Cache the app shell on install
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/display.html',
        '/'
      ]);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Smart fetch strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // API calls: network only (don't cache)
  if (url.pathname.startsWith('/api/')) {
    return; // browser handles normally
  }
  
  // Media files (images/videos): cache-first, then network
  if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          // ارجع من الكاش فوراً، وحدث في الخلفية
          fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response);
          }).catch(() => {});
          return cached;
        }
        // مش في الكاش، حمّل من النت
        try {
          const response = await fetch(event.request);
          if (response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          return new Response('', { status: 503 });
        }
      })
    );
    return;
  }
  
  // HTML/CSS/JS: network-first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Clean up old media periodically (optional)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAN_CACHE') {
    caches.delete(MEDIA_CACHE).then(() => {
      caches.open(MEDIA_CACHE);
    });
  }
});

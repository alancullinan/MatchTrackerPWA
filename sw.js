const CACHE_NAME = 'match-tracker-v1.2.9';
const urlsToCache = [
  '/',
  '/index.html',
  '/script.js',
  '/styles.css',
  '/tailwind-minimal.css',
  '/manifest.json',
  // Icons
  '/icons/back-grey-blue.svg',
  '/icons/back.svg',
  '/icons/burger.svg',
  '/icons/card.svg',
  '/icons/delete.svg',
  '/icons/edit-grey-blue.svg',
  '/icons/edit.svg',
  '/icons/export.svg',
  '/icons/flag-grey-green.svg',
  '/icons/flag-grey-orange.svg',
  '/icons/flag-grey-white.svg',
  '/icons/flag.svg',
  '/icons/foul.svg',
  '/icons/greenflag.svg',
  '/icons/kickout.svg',
  '/icons/miss.svg',
  '/icons/note.svg',
  '/icons/orangeflag.svg',
  '/icons/pause.svg',
  '/icons/play.svg',
  '/icons/players.svg',
  '/icons/plus-blue-white.svg',
  '/icons/plus.svg',
  '/icons/redcard.svg',
  '/icons/stats.svg',
  '/icons/sub.svg',
  '/icons/team-grey-blue.svg',
  '/icons/trash-grey-pink.svg',
  '/icons/whiteflag.svg',
  '/icons/yellowcard.svg',
  // App icons (will be created)
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-128x128.png',
  '/icons/icon-144x144.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-384x384.png',
  '/icons/icon-512x512.png'
];

// Install event - cache resources
self.addEventListener('install', event => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching files');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('Service Worker: Installed');
        return self.skipWaiting();
      })
      .catch(err => {
        console.error('Service Worker: Cache failed', err);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('Service Worker: Activated');
      return self.clients.claim();
    })
  );
});

// Fetch event - serve cached content when offline
self.addEventListener('fetch', event => {
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return cached version or fetch from network
        if (response) {
          console.log('Service Worker: Serving from cache', event.request.url);
          return response;
        }
        
        console.log('Service Worker: Fetching from network', event.request.url);
        return fetch(event.request).then(response => {
          // Don't cache non-successful responses
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Clone the response
          const responseToCache = response.clone();

          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });

          return response;
        });
      })
      .catch(() => {
        // If both cache and network fail, show offline page for HTML requests
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      })
  );
});

// Handle background sync for data backup (future enhancement)
self.addEventListener('sync', event => {
  if (event.tag === 'background-sync') {
    console.log('Service Worker: Background sync triggered');
    // Future: Sync data when connection is restored
  }
});

// Handle push notifications (future enhancement)
self.addEventListener('push', event => {
  if (event.data) {
    const options = {
      body: event.data.text(),
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: 1
      }
    };
    
    event.waitUntil(
      self.registration.showNotification('Match Tracker', options)
    );
  }
});
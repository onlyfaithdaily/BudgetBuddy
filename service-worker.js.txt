// service-worker.js — BudgetBuddy (offline-capable PWA)
// IMPORTANT: bump CACHE_NAME when updating files so clients refresh their caches.

const CACHE_NAME = 'BUDGETBUDDY_CACHE_v3';
const APP_SHELL = [
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-256.png'
];

// Optional external libs we try to cache (CDN). If you prefer, host locally and update these paths.
const EXTERNAL_CACHES = [
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
  // Immediately take over (after activation) -- helpful when releasing updates.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        // Cache app shell
        await cache.addAll(APP_SHELL);
        // Try to cache external libs (best-effort)
        for (const url of EXTERNAL_CACHES) {
          try {
            const resp = await fetch(url, { mode: 'no-cors' });
            // if network returns something usable, put it; otherwise skip
            if (resp && resp.ok) await cache.put(url, resp.clone());
          } catch (e) {
            // ignore failures (still offline-capable with local files)
            console.warn('Failed to prefetch external lib', url, e);
          }
        }
      } catch (err) {
        console.error('SW install caching failed', err);
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  // Remove old caches
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const deletions = keys.map(k => {
        if (k !== CACHE_NAME) return caches.delete(k);
        return null;
      });
      await Promise.all(deletions);
      await self.clients.claim();
    })
  );
});

// Utility: is the request for an app-shell core file?
function isAppShellRequest(request) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\//, '');
    return APP_SHELL.includes(pathname) || APP_SHELL.includes(url.pathname);
  } catch (e) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests handled
  if (req.method !== 'GET') return;

  const requestURL = new URL(req.url);

  // Strategy:
  // - Network-first for app shell files & CDN libs (so updates get picked up)
  // - Cache-first for other static assets
  // - Fallback to cached index.html for navigation requests if offline

  // If navigation (user typed URL / refresh) -> serve index.html fallback for SPA
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(response => {
        // update cache with latest index.html
        return caches.open(CACHE_NAME).then(cache => {
          cache.put('index.html', response.clone());
          return response;
        });
      }).catch(() => caches.match('index.html'))
    );
    return;
  }

  // If request is for app shell or known external CDN -> network-first
  if (isAppShellRequest(req) || EXTERNAL_CACHES.some(u => req.url.startsWith(u))) {
    event.respondWith(
      fetch(req).then(response => {
        // cache the response and return it
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return response;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('index.html')))
    );
    return;
  }

  // For other requests (images, css, fonts) -> cache-first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        // don't cache opaque responses from cross-origin unless you want to
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return response;
      }).catch(() => {
        // fallback to index.html for unknown requests if available (useful offline)
        return caches.match('index.html');
      });
    })
  );
});

// Allow the page to trigger skipWaiting (to immediately activate a waiting SW)
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

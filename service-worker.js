self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("budget-cache").then(cache => {
      return cache.addAll([
        "index.html",
        "style.css",
        "app.js",
        "manifest.json",
        "icon-256.png"
      ]);
    })
  );
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(response => response || fetch(e.request))
  );
});

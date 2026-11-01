/* ============================================================
   Solin v3 — sw.js
   Offline-capable Progressive Web App Service Worker.
   Uses network-first with cache fallback for HTML/JS/CSS and
   GET API reads (/api/v1/kamra, /api/v1/inventory) so recipes
   and pantry work seamlessly in the kitchen even on spotty Wi-Fi.
   ============================================================ */

const CACHE_NAME = "solin-pwa-v1";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache media streams or auth endpoints
  if (url.pathname.startsWith("/media/") || url.pathname.startsWith("/api/v1/auth/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/api/v1/kamra" || url.pathname === "/api/v1/inventory")) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

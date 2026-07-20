const CACHE = "xuanche-pwa-v0.6.0-mobile-controls-v2";
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/images/chulingxiao-v1.webp",
  "/icons/xuanche-192.png",
  "/icons/xuanche-512.png",
  "/icons/xuanche.svg"
];
const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
    return;
  }
  event.respondWith(networkFirst(request));
});

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (isCacheable(response)) await cache.put(request, response.clone()).catch(() => undefined);
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

async function networkFirst(request, fallback = "") {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone()).catch(() => undefined);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallback) {
      const fallbackResponse = await cache.match(fallback);
      if (fallbackResponse) return fallbackResponse;
    }
    throw error;
  }
}

function isCacheable(response) {
  return response.ok && response.type !== "opaque";
}

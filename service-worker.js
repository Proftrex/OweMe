const CACHE_NAME = 'oweme-shell-v1';
const SUPABASE_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.webmanifest',
  './assets/owelogo.png'
];
const APP_SHELL_PATHS = new Set(
  APP_SHELL.map((path) => new URL(path, self.location.href).pathname)
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(APP_SHELL);
        try {
          const response = await fetch(SUPABASE_SCRIPT_URL);
          if (response.ok) await cache.put(SUPABASE_SCRIPT_URL, response);
        } catch {}
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith('oweme-shell-') && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.href === SUPABASE_SCRIPT_URL) {
    event.respondWith(
      fetch(request)
        .then((response) => caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, response.clone()))
          .then(() => response))
        .catch(() => caches.match(request))
    );
    return;
  }

  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (!APP_SHELL_PATHS.has(requestUrl.pathname)) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => cachedResponse || fetch(request))
  );
});
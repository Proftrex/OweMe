
self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  let data = {};

  try {
    data = event.data.json();
  } catch {
    data = {
      title: 'OweMe',
      message: event.data.text()
    };
  }

  const title = data.title || 'OweMe';
  const options = {
    body: data.message || '',
    icon: './assets/owelogo.png',
    badge: './assets/owelogo.png',
    data: {
      notificationId: data.notificationId || null,
      groupId: data.groupId || null,
      expenseId: data.expenseId || null,
      settlementId: data.settlementId || null
    },
    tag: data.notificationId || undefined,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((clientList) => {

      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'OWEME_NOTIFICATION_CLICK',
            notificationId: data.notificationId,
            groupId: data.groupId,
            expenseId: data.expenseId,
            settlementId: data.settlementId
          });

          return client.focus();
        }
      }

      if (clients.openWindow) {
        let url = './';

        if (data.groupId) {
          url += '?group=' + encodeURIComponent(data.groupId);
        }

        return clients.openWindow(url);
      }
    })
  );
});

const CACHE_NAME = 'oweme-shell-v12';
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
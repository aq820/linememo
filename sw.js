/* Offline app shell only. Notion content and API responses are never cached. */
const CACHE_NAME = 'ncm-pwa-v1';
const ROOT_URL = new URL('./', self.registration.scope);
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/favicon.ico',
  './icons/favicon-16x16.png',
  './icons/favicon-32x32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];
const SHELL_URLS = SHELL_FILES.map(path => new URL(path, ROOT_URL).href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('ncm-pwa-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ROOT_URL.pathname)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await caches.match(ROOT_URL.href)) || (await caches.match(new URL('./index.html', ROOT_URL).href));
      }
      return new Response('Offline: this app resource is not cached.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

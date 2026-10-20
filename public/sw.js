/* 只缓存应用资源，不缓存仓库 API 或附件，防止切仓库时混入旧数据。 */
const CACHE = 'tracery-shell-__SHELL_VERSION__';
const ASSETS = __SHELL_ASSETS__;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('tracery-shell-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(4000) });
        return response.ok ? await cache.match('/index.html') || response : response;
      } catch { return await cache.match('/offline.html'); }
    })());
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => await cache.match(url.pathname) || fetch(event.request)));
  }
});

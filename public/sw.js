// Offline cache: pages network-first, everything else cache-first (built assets are content-hashed).
// Every built file is cached at install, so a page that stays open across a deploy can still load its
// lazy chunks after the server has replaced them. Files of the current and the previous build are kept.
const CACHE = 'butcher-v1';
const ASSETS = []; // filled in by the build (vite.config.ts)
const LIST = './__assets.json';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icons/icon-192.png', ...ASSETS])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== 'butcher-share') await caches.delete(k);
    const c = await caches.open(CACHE), url = (p) => new URL(p, self.registration.scope).href;
    const prev = await c.match(LIST).then((r) => (r ? r.json() : []), () => []);
    const keep = new Set([...ASSETS, ...prev].map(url));
    for (const req of await c.keys()) if (new URL(req.url).pathname.includes('/assets/') && !keep.has(req.url)) await c.delete(req);
    await c.put(LIST, new Response(JSON.stringify(ASSETS), { headers: { 'content-type': 'application/json' } }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // share target (manifest.webmanifest): keep the shared files for the page, then open it
  if (req.method === 'POST' && new URL(req.url).searchParams.has('share')) {
    e.respondWith((async () => {
      const form = await req.formData(), c = await caches.open('butcher-share');
      for (const k of await c.keys()) await c.delete(k);
      const files = form.getAll('files').filter((f) => typeof f !== 'string');
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await c.put(`./__share/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || '') } }));
      }
      return Response.redirect(new URL('./?shared', self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  const nav = req.mode === 'navigate';
  const put = (res) => {
    // a missing file comes back as the app page (SPA fallback); never store that under a script's URL
    const html = (res.headers.get('content-type') || '').includes('text/html');
    if ((res.ok || res.type === 'opaque') && (nav || !html)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  };
  if (nav) {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req).then((r) => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then(put)));
});

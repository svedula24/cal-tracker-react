// Kalo's service worker: the home-screen app opens without a connection (the data lives on the
// device; sync catches up later). Registered from public/index.html; copied to the export's root.
//
// Precache: `node scripts/sw-manifest.mjs <dist>` runs after `expo export` (npm run build:web). It
// lists the whole build in <dist>/sw-files.json and stamps its content hash into VERSION below.
// Installing a worker caches every file of that list, so after one launch online every screen opens
// offline, the lazy ones (Food Database's bundled list, the scanner's decoder) included.
//
// Requests:
// - the app page (navigations, any route): network first, so every launch online gets the latest
//   deploy; the cached page when the network fails or takes over NAVIGATION_TIMEOUT_MS (a late
//   answer still refreshes the cache);
// - Expo's hashed bundles and assets (/_expo/static/, /assets/): cache first. Their names change
//   with their contents, so a cached one is never stale. Only real files are cached: an HTML answer
//   there is the host's SPA fallback for a missing file, and is passed on, never kept.
// Every other request — the API (/api/, /mcp, /oauth/, /.well-known/, /docs), other hosts, anything
// that isn't a GET — is not touched: the browser sends it as if there were no service worker.
//
// Updates: the browser checks this file on each launch. A new build has a new VERSION: its worker
// precaches the new build, takes over at once and deletes the old caches; the page already open
// keeps running, and the next launch is the new build.
//
// Kill switch (a broken worker in the field): deploy this file as just
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
//     .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
//     .then(() => self.registration.unregister())));
// The next launch online installs it, it empties the caches and unregisters itself, and the launch
// after that is a plain web page again. (Keep /sw.js served, never 404: a 404 leaves the old worker.)
const VERSION = 'kalo-dev'; // replaced by scripts/sw-manifest.mjs with the build's hash
const PAGE = '/';
const NAVIGATION_TIMEOUT_MS = 4000;
const BATCH = 20; // files fetched at a time while precaching
// Paths the API server answers on the app's host (vercel.json routes them to FastAPI).
const SERVER = /^\/(api|mcp|oauth|\.well-known|docs|redoc|openapi\.json)(\/|$)/;

const hashed = (url) => url.pathname.startsWith('/_expo/static/') || url.pathname.startsWith('/assets/');
const isHtml = (response) => (response.headers.get('content-type') || '').includes('text/html');

// Precache the build, all or nothing: if any file fails (offline, a deploy mid-way), the install
// fails, the worker in place keeps serving the build it has, and the browser tries again on a later
// launch. A half-cached build would open blank offline, which is worse than the old one.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      let files = [PAGE];
      // A failed request (offline, a timeout) fails the install, so the old, complete cache stays. Only
      // a list the server says isn't there (404, or the SPA fallback's HTML) means a dev build: the page only.
      const list = await fetch('/sw-files.json', { cache: 'no-cache' });
      if (list.ok && !isHtml(list)) files = await list.json();
      for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(
          files.slice(i, i + BATCH).map(async (path) => {
            const response = await fetch(new Request(path, { cache: 'no-cache' }));
            if (!response.ok || (hashed(new URL(path, self.location.origin)) && isHtml(response))) {
              throw new Error(`precache: ${path} answered ${response.status}`);
            }
            await cache.put(path, response);
          }),
        );
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Not the server's own pages (OAuth consent, FastAPI's /docs and the like): never cached.
    if (SERVER.test(url.pathname)) return;
    event.respondWith(page(event));
  } else if (hashed(url)) {
    event.respondWith(file(request));
  }
});

/** The app page: the network's (kept for offline), else the cached one. Every route is this page. */
async function page(event) {
  const cache = await caches.open(VERSION);
  // Kept only if it is the app's page (its root element), never a server page under another path.
  const keep = async (response) => {
    if (!response.ok || !isHtml(response)) return;
    if ((await response.clone().text()).includes('<div id="root">')) await cache.put(PAGE, response);
  };
  const network = fetch(event.request);
  try {
    const response = await withTimeout(network, NAVIGATION_TIMEOUT_MS);
    event.waitUntil(keep(response.clone()).catch(() => {}));
    return response;
  } catch {
    // Offline or too slow: the cached page now, and a late answer, if one comes, for next time.
    event.waitUntil(network.then(keep).catch(() => {}));
    const cached = await cache.match(PAGE);
    return cached || network; // nothing cached yet: the network's answer after all
  }
}

/** A hashed bundle or asset: the cached copy, else the network's (cached only if a real file). */
async function file(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && !isHtml(response)) await cache.put(request, response.clone());
  return response;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

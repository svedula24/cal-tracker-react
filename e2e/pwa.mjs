// ────────────────────────────────────────────────────────────────────────────
// Kalo as an iPhone home-screen web app, and its web barcode scanner. Run after
// the API build: `npm run verify:api` (which runs this file too, on dist-api/).
//
// 1. The home-screen setup: manifest, icons, iOS meta tags in the page.
// 2. The layout at 390x844 (iPhone 12-16) with the notch and home indicator's
//    safe-area insets emulated (Chromium's DevTools protocol), screenshots in
//    e2e/shots/pwa-*.png.
// 3. The camera scanner with Chromium's fake camera playing a video of a
//    barcode drawn by ZXing (tests/barcodeImage.mjs): scanning at once, one
//    lookup at a time, the dim and spinner while looking up, the result sheet
//    and Scan again, Nutrition on a find, the camera stopped on a find, when
//    the page is hidden and when the screen closes; a UPC-E looked up as its
//    UPC-A; the typed field when the camera is denied or missing.
// 4. The service worker: the app opens offline; the API is never cached.
//
// Not covered here (no real camera or iPhone): the iOS permission prompt in
// standalone mode, focus and scan speed on a real label.
// ────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { barcodeFrame, y4m } from '../tests/barcodeImage.mjs';

const DIST = path.resolve('dist-api');
if (!fs.existsSync(DIST)) {
  console.error('No dist-api/ found: run `npm run verify:api`, which builds it with EXPO_PUBLIC_API_URL set.');
  process.exit(2);
}
const SHOTS = path.resolve('e2e/shots');
fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.png': 'image/png', '.wasm': 'application/wasm',
};
const served = []; // every path the static server answered
let root = DIST; // what the server serves: the service worker checks swap in a copy they change
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  served.push(url);
  const resolved = path.resolve(root, '.' + url);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  // SPA fallback, as the host does: root, extensionless routes, escapes, or misses -> index.html
  // (200 text/html, also for a missing bundle, as Vercel's rewrite answers).
  const file = url === '/' || !path.extname(url) || !inside || !fs.existsSync(resolved) ? path.join(root, 'index.html') : resolved;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // loopback only
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (!ok) failed++;
};
const show = (x) => JSON.stringify(x);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

// The fake camera's videos: a product's EAN-13, and a UPC-E.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kalo-pwa-'));
const video = async (name, text, format) => {
  const file = path.join(tmp, `${name}.y4m`);
  fs.writeFileSync(file, y4m([await barcodeFrame(text, format, { width: 640, height: 480, module: 3 })]));
  return file;
};
const EAN13 = '0737628064502';
const eanVideo = await video('ean13', EAN13, 'EAN13');
const upceVideo = await video('upce', '01234565', 'UPCE');

/** Chromium with a fake camera playing `file`, or with no camera at all. */
const launch = (file) =>
  chromium.launch({
    args: file ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`] : [],
  });

// An iPhone-sized page: 390x844 CSS px at 3x, touch, mobile viewport.
const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// Records every camera stream the page opens, so the checks can see when its tracks stop.
const RECORD_STREAMS = () => {
  window.__streams = [];
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await original(c);
    window.__streams.push(s);
    return s;
  };
};
const tracks = (page) => page.evaluate(() => window.__streams.map((s) => s.getTracks().map((t) => t.readyState).join(',')));
const liveTracks = async (page) => (await tracks(page)).filter((t) => t.includes('live')).length;

/** A page with the API mocked: registration, sync, and the barcode lookup (whose answers the test decides). */
async function apiPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  const preflight = (route) => route.request().method() === 'OPTIONS' && route.fulfill({ status: 204, headers: CORS });
  await page.route('**/api/v1/devices', (route) => preflight(route) || json(route, 201, { user_id: randomUUID(), token: 'kalo_pwa', timezone: 'UTC' }));
  await page.route('**/api/v1/sync', (route) => preflight(route) || json(route, 200, { cursor: 0, has_more: false, changes: {}, rejected: [] }));
  await page.route('**/api/v1/me', (route) => preflight(route) || json(route, 200, { user_id: randomUUID(), timezone: 'UTC' }));
  const lookups = []; // every barcode lookup: { code, answer(status, body) }
  await page.route('**/api/v1/foods/barcode/*', (route) => {
    if (preflight(route)) return;
    const code = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    lookups.push({ code, answer: (status, body) => json(route, status, body) });
  });
  return { page, errors, lookups };
}
const PRODUCT = {
  code: EAN13, name: 'Thai Peanut Noodle Kit', brand: 'Simply Asia',
  nutrients_per_100g: { calories: 385.0, protein_g: 9.6, carbs_g: 71.2, fat_g: 7.7, fiber_g: 1.9, sugar_g: null, sodium_mg: 1250.0 },
  serving: { label: '0.333 PACKAGE (52 g)', grams: 52.0 }, source: 'openfoodfacts',
};

/** The notch and home-indicator insets of an iPhone 12-16 in portrait, as the home-screen app sees them. */
async function safeArea(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    return true;
  } catch {
    return false; // an older Chromium: screenshots without the insets
  }
}

const btn = (page, name) => page.getByRole('button', { name, exact: true });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `pwa-${name}.png`) });

try {
  // ── 1. Home-screen setup ─────────────────────────────────────────────────────
  console.log('\nHome-screen app');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  check(manifest.name === 'Kalo' && manifest.short_name === 'Kalo' && manifest.display === 'standalone' && manifest.start_url === '/', 'manifest: Kalo, standalone, starting at /', show(manifest));
  check(manifest.background_color === '#FFFFFF' && manifest.theme_color === '#FFFFFF', 'manifest colours are the background token (#FFFFFF)');
  const pngSize = (file) => {
    const b = fs.readFileSync(path.join(DIST, file));
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  };
  for (const icon of manifest.icons) check(pngSize(icon.src) === icon.sizes, `icon ${icon.src} is ${icon.sizes}`, pngSize(icon.src));
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  for (const tag of [
    '<link rel="manifest" href="/manifest.json" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    '<meta name="apple-mobile-web-app-title" content="Kalo" />',
    'viewport-fit=cover',
    '<title>Kalo</title>',
  ])
    check(html.includes(tag), `index.html has ${tag}`);
  check(pngSize('apple-touch-icon.png') === '180x180', 'apple-touch-icon.png is 180x180');

  // ── 2 + 3. The camera scanner, with the layout at iPhone size ─────────────────
  console.log('\nCamera scanner (fake camera: an EAN-13)');
  {
    const browser = await launch(eanVideo);
    const context = await browser.newContext({ ...IPHONE, permissions: ['camera'], serviceWorkers: 'block' });
    await context.addInitScript(RECORD_STREAMS);
    const { page, errors, lookups } = await apiPage(context);
    const insets = await safeArea(page);
    check(true, insets ? 'safe-area insets emulated: 47 px top, 34 px bottom' : 'safe-area insets not emulated by this Chromium (screenshots without them)');

    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await btn(page, 'Add').waitFor({ timeout: 8000 });
    await wait(500);
    await shot(page, 'home');
    if (insets) {
      // The page's own top padding: Home's header sits below the 47 px status bar / notch.
      const top = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
        document.body.append(probe);
        const r = { top: probe.offsetHeight, bottom: parseFloat(getComputedStyle(probe).paddingBottom) };
        probe.remove();
        return r;
      });
      check(top.top === 47 && top.bottom === 34, 'env(safe-area-inset-*) reaches the page (viewport-fit=cover)', show(top));
      const add = await btn(page, 'Add').boundingBox();
      // As on native (src/components/Fab.tsx fabBottom): 4 px less than the inset; 12 px without one.
      check(add && Math.round(844 - add.y - add.height) === 34 - 4, 'the + button sits on the home indicator\'s inset, as on native', show(add));
    }

    await btn(page, 'Add').click();
    await btn(page, 'Scan barcode').click();
    await until('the camera to start', async () => (await liveTracks(page)) === 1);
    check(true, 'Scan barcode opens the back camera (getUserMedia)');
    const asked = await page.evaluate(() => window.__streams.length);
    check(asked === 1, 'one camera stream', `streams: ${asked}`);
    check((await page.getByLabel('Barcode number').count()) === 0, 'no typed field while the camera works');
    await until('the first lookup', async () => lookups.length >= 1);
    check(lookups[0].code === EAN13, 'scanning starts at once: the barcode in view is looked up', show(lookups.map((l) => l.code)));
    check(served.some((u) => u.endsWith('.wasm')) && served.some((u) => /zxingReader-[0-9a-f]+\.js$/.test(u)), 'the decoder (its chunk and .wasm) comes from the app, not a CDN');
    await page.getByLabel('Looking up', { exact: true }).waitFor({ timeout: 3000 });
    await shot(page, 'scan-looking');
    await wait(1500);
    check(lookups.length === 1, 'one lookup at a time: none while the first is out', `lookups: ${lookups.length}`);
    check((await liveTracks(page)) === 1, 'the camera stays on during the lookup');

    // Page hidden (the app sent to the background): the camera stops; shown again: it restarts.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until('the camera to stop when the page is hidden', async () => (await liveTracks(page)) === 0);
    check(true, 'the camera stops when the page is hidden');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until('the camera to restart when the page is shown', async () => (await liveTracks(page)) === 1);
    check(true, 'and starts again when the page is shown');

    // Not found: the sheet over the camera, Scan again reads the code again.
    lookups[0].answer(404, { detail: { reason: 'not_found' } });
    await page.getByText('No product found', { exact: true }).waitFor({ timeout: 5000 });
    await wait(300);
    await shot(page, 'scan-not-found');
    check((await btn(page, 'Scan again').count()) === 1 && (await btn(page, 'Search food database').count()) === 1, 'a miss shows the sheet with Scan again and Search food database');
    await wait(800);
    check(lookups.length === 1, 'no new lookup while the result is shown');
    await btn(page, 'Scan again').click();
    await until('a second lookup after Scan again', async () => lookups.length === 2);
    check(lookups[1].code === EAN13, 'Scan again scans again');
    lookups[1].answer(200, PRODUCT);
    await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
    check((await page.getByLabel('Food name').inputValue()) === 'Simply Asia Thai Peanut Noodle Kit', 'a find opens Nutrition with the product');
    await until('every camera track to stop after the find', async () => (await liveTracks(page)) === 0);
    check(true, 'the camera is stopped once the code is found');
    await wait(400);
    await shot(page, 'scan-found-nutrition');

    // Close: the screen goes, and its camera with it.
    await page.goto(base + '/scan-food', { waitUntil: 'networkidle' });
    await until('the camera to start', async () => (await liveTracks(page)) === 1);
    await wait(500);
    await shot(page, 'scan-camera');
    await btn(page, 'Close').click();
    await btn(page, 'Add').waitFor({ timeout: 5000 });
    await until('the camera to stop on Close', async () => (await liveTracks(page)) === 0);
    check(true, 'Close goes back and stops the camera');
    check(errors.length === 0, 'no page errors', show(errors.slice(0, 3)));
    await browser.close();
  }

  console.log('\nCamera scanner (fake camera: a UPC-E)');
  {
    const browser = await launch(upceVideo);
    const context = await browser.newContext({ ...IPHONE, permissions: ['camera'], serviceWorkers: 'block' });
    await context.addInitScript(RECORD_STREAMS);
    const { page, lookups } = await apiPage(context);
    await page.goto(base + '/scan-food', { waitUntil: 'networkidle' });
    await until('the UPC-E lookup', async () => lookups.length >= 1, 15000);
    check(lookups[0].code === '0012345000065', 'a UPC-E (01234565) is looked up as its UPC-A, never as an 8-digit EAN-8', show(lookups[0].code));
    // The camera taken away while scanning (another app, iOS revoking it): the typed field.
    await page.evaluate(() => window.__streams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await page.getByLabel('Barcode number').waitFor({ timeout: 5000 });
    check((await page.getByText("The camera couldn't start.", { exact: false }).count()) === 1, 'a camera track that ends on its own: the typed field, "The camera couldn\'t start"');
    await until('the camera to stop with the fallback', async () => (await liveTracks(page)) === 0);
    check(true, 'and the camera is stopped');
    // The video refuses to play (an autoplay refusal): "couldn't start", not "access is off".
    const noPlay = await context.newPage();
    await noPlay.addInitScript(() => {
      HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
    });
    await noPlay.goto(base + '/scan-food', { waitUntil: 'networkidle' });
    await noPlay.getByLabel('Barcode number').waitFor({ timeout: 8000 });
    check((await noPlay.getByText("The camera couldn't start.", { exact: false }).count()) === 1, 'a refused play(): the typed field, "The camera couldn\'t start"');
    check((await liveTracks(noPlay)) === 0, 'and the camera is stopped');
    await browser.close();
  }

  console.log('\nNo camera to use: the typed number');
  {
    const browser = await launch(null);
    // No camera permission granted: the browser refuses getUserMedia.
    const context = await browser.newContext({ ...IPHONE, serviceWorkers: 'block' });
    const { page, errors } = await apiPage(context);
    await safeArea(page);
    await page.goto(base + '/scan-food', { waitUntil: 'networkidle' });
    await page.getByLabel('Barcode number').waitFor({ timeout: 8000 });
    const note = (await page.getByText(/Camera access is off|No camera was found|camera couldn't start/).allTextContents()).join(' ');
    check(note.length > 0, 'without the camera, the typed field says why', note);
    check((await btn(page, 'Use the camera').count()) === 1, 'and offers to try the camera again');
    await wait(300);
    await shot(page, 'scan-typed-fallback');
    // Denied (the user said no, or turned it off in Settings), and no camera on the device.
    for (const [name, text] of [['NotAllowedError', 'Camera access is off for Kalo.'], ['NotFoundError', 'No camera was found.']]) {
      const refused = await context.newPage();
      await refused.addInitScript((n) => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('refused', n));
      }, name);
      await refused.goto(base + '/scan-food', { waitUntil: 'networkidle' });
      await refused.getByLabel('Barcode number').waitFor({ timeout: 8000 });
      check((await refused.getByText(text, { exact: false }).count()) === 1, `${name}: the typed field says "${text}"`);
      await refused.close();
    }
    // A browser without the camera API at all (plain http on a LAN address, an old browser).
    const bare = await context.newPage();
    await bare.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }));
    await bare.goto(base + '/scan-food', { waitUntil: 'networkidle' });
    await bare.getByLabel('Barcode number').waitFor({ timeout: 8000 });
    check((await bare.getByText("This browser can't use the camera here.", { exact: false }).count()) === 1, 'no camera API: the typed field, with the reason');
    check((await btn(bare, 'Use the camera').count()) === 0, 'and no camera retry');
    check(errors.length === 0, 'no page errors', show(errors.slice(0, 3)));
    await browser.close();
  }

  // ── 4. The service worker ────────────────────────────────────────────────────
  console.log('\nService worker');
  {
    // A copy of the export, so the update check can change it.
    const site = path.join(tmp, 'site');
    fs.cpSync(DIST, site, { recursive: true });
    root = site;
    const browser = await launch(null);
    const context = await browser.newContext({ ...IPHONE });
    const { page } = await apiPage(context);
    const fromWorker = [];
    page.on('response', (r) => {
      if (r.fromServiceWorker()) fromWorker.push(new URL(r.url()).pathname);
    });
    const cacheNames = () => page.evaluate(() => caches.keys());
    const cached = () => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat());
    const files = JSON.parse(fs.readFileSync(path.join(site, 'sw-files.json'), 'utf8'));
    const version = (dir) => /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'))[1];

    // One launch online: the worker installs and precaches the whole build.
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    check(version(site) !== 'kalo-dev' && show(await cacheNames()) === show([version(site)]), 'the worker\'s cache is named after the build (scripts/sw-manifest.mjs)', show(await cacheNames()));
    const have = new Set(await cached());
    const missing = files.filter((f) => !have.has(decodeURI(f)));
    check(files.length > 20 && missing.length === 0, `the install precaches the whole build (${files.length} files, every route's chunk, the decoder's .wasm)`, show(missing.slice(0, 5)));

    // The next launch offline, the first after that one online launch.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await btn(page, 'Add').waitFor({ timeout: 8000 });
    check(true, 'offline, the first relaunch opens (Home renders)');
    await page.goto(base + '/food-database', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Search foods').fill('banana');
    await page.getByRole('button', { name: /banana/i }).first().waitFor({ timeout: 8000 });
    check(true, 'offline, a route never opened online opens: Food Database searches its bundled list');
    await context.setOffline(false);

    // The API and missing files are never cached.
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    const answered = await page.evaluate(async () => (await fetch('/api/v1/health')).status);
    check(answered === 200 && !fromWorker.some((p) => p.startsWith('/api/')), 'same-origin /api/ requests pass the worker by', show(fromWorker.filter((p) => p.startsWith('/api'))));
    const ghost = '/_expo/static/js/web/missing-0000.js';
    const ghostType = await page.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), ghost);
    const now = await cached();
    check(ghostType === 'text/html' && !now.includes(ghost), 'a missing bundle (the host\'s HTML fallback) is passed on, never cached', show({ ghostType, cached: now.includes(ghost) }));
    check(!now.some((p) => /^\/(api|mcp|oauth|\.well-known)/.test(p)), 'nothing of the API is cached');

    // A new deploy: a changed page and so a new build id. The next launch online runs it, and the
    // new worker replaces the old cache.
    const old = version(site);
    const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    fs.writeFileSync(path.join(site, 'index.html'), html.replace('</head>', '<script>window.__kaloBuild = "v2";</script></head>'));
    execFileSync(process.execPath, ['scripts/sw-manifest.mjs', site], { stdio: 'ignore' });
    check(version(site) !== old, 'a changed build gets a new build id');
    await page.reload({ waitUntil: 'networkidle' });
    check((await page.evaluate(() => window.__kaloBuild)) === 'v2', 'the next launch online runs the new build');
    await until('the new worker to replace the old cache', async () => show(await cacheNames()) === show([version(site)]), 15000);
    check(true, 'the new worker takes over and the old build\'s cache is deleted');
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await btn(page, 'Add').waitFor({ timeout: 8000 });
    check((await page.evaluate(() => window.__kaloBuild)) === 'v2', 'offline after the update, the app is the new build');
    await context.setOffline(false);
    await browser.close();
    root = DIST;
  }
} catch (e) {
  check(false, `stopped: ${String(e).split('\n')[0]}`);
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRESULT: ${failed ? '❌ FAIL' : '✅ ALL PASS'}`);
process.exit(failed ? 1 : 0);

// ────────────────────────────────────────────────────────────────────────────
// Sync against the REAL backend: the app in a browser logs, edits and deletes a
// food, and each step is checked on the server through its REST API.
// Not in CI and not part of `npm run verify`: it needs a running API and it
// writes to that API's database (one new anonymous user, one food log).
//
// 1. Build the web app pointed at the API (the URL is fixed at build time):
//      EXPO_PUBLIC_API_URL=http://localhost:8000 npx expo export --platform web --output-dir dist-sync
// 2. Run this against the same API:
//      SYNC_API_URL=http://localhost:8000 npm run verify:sync
//
// SYNC_API_URL  the running API (backend/README.md, "API"); required, and the same
//               URL the build was made with.
// SYNC_DIST     the web build to serve; default dist-sync.
//
// It prints the id of the user the app registered, so that test user can be
// removed from the database afterwards. e2e/api-mode.mjs (`npm run verify:api`)
// covers the same behaviour, and more, against a mocked API.
// ────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const API = (process.env.SYNC_API_URL ?? '').trim().replace(/\/+$/, '');
const DIST = path.resolve(process.env.SYNC_DIST || 'dist-sync');
if (!API) {
  console.error('Set SYNC_API_URL to the running API, e.g. SYNC_API_URL=http://localhost:8000 npm run verify:sync');
  process.exit(2);
}
if (!fs.existsSync(DIST)) {
  console.error(`No ${path.basename(DIST)}/ found. Build it first:\n  EXPO_PUBLIC_API_URL=${API} npx expo export --platform web --output-dir ${path.basename(DIST)}`);
  process.exit(2);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const resolved = path.resolve(DIST, '.' + url);
  const inside = resolved === DIST || resolved.startsWith(DIST + path.sep);
  // SPA fallback: root, extensionless routes, escapes, or misses -> index.html.
  const file = url === '/' || !path.extname(url) || !inside || !fs.existsSync(resolved) ? path.join(DIST, 'index.html') : resolved;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // loopback only
const base = `http://127.0.0.1:${server.address().port}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed++;
};
/** Polls `probe` until it returns something truthy; the app pushes about 2 s after a change. */
const until = async (what, probe, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await wait(500);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // a new profile: the app registers a new device
const btn = (name) => page.getByRole('button', { name, exact: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const nutrition = () => page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
const home = async (name) => {
  await btn(`Edit ${name}`).waitFor({ timeout: 5000 });
  await wait(400); // the Nutrition screen slides away
};

// The server, asked as any other client would: with the token the app stored.
let token = null;
const get = async (pathname) => {
  const res = await fetch(API + pathname, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${pathname} answered ${res.status}`);
  return res.json();
};

const FDC_ID = 2709224; // Banana, raw
let today = null;
const logsToday = async () => (await get(`/api/v1/food-logs?date=${today}`)).logs;
const describe = (log) => (log ? `${log.name}, ${log.quantity} ${log.unit}, id ${log.id}` : 'nothing');

console.log(`\nSync against ${API} (web build: ${path.basename(DIST)}/)\n`);
try {
  await fetch(API + '/api/v1/foods/search?q=banana&limit=1').then(
    (res) => check(res.ok, `the API answers at ${API}`),
    () => check(false, `the API answers at ${API} (is it running?)`),
  );
  if (failed) throw new Error('no API to test against');

  // The app registers and syncs by itself shortly after it starts.
  await page.goto(base + '/food-database', { waitUntil: 'networkidle' });
  today = await page.evaluate(() => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  });
  token = await until('the app to register (localStorage kalo.token)', () => page.evaluate(() => localStorage.getItem('kalo.token')), 15000).catch(() => null);
  check(!!token, `the app registered a device and stored its token (if not: was the build made with EXPO_PUBLIC_API_URL=${API}?)`);
  if (!token) throw new Error('no token');
  token = token.replace(/^"|"$/g, '');
  const me = await get('/api/v1/me');
  console.log(`\n  TEST USER ID: ${me.user_id}   (remove this user from the database afterwards)\n`);
  check((await logsToday()).length === 0, `the new user has no food logs for ${today}: demo entries are not uploaded`);

  // Log 150 g of banana from the search.
  await page.getByLabel('Search foods').fill('banana');
  await btn('Banana, raw').waitFor({ timeout: 10000 });
  check((await page.getByText('Offline: searching the built-in list').count()) === 0, 'the search is answered by the API, not the built-in list');
  await btn('Banana, raw').click();
  await nutrition();
  await page.getByLabel('Grams').fill('150');
  await btn('Done').click();
  await home('Banana, raw');
  const logged = await until('the log to reach the server', async () => (await logsToday()).find((l) => l.fdc_id === FDC_ID)).catch(() => null);
  check(!!logged && Number(logged.quantity) === 150 && logged.unit === 'g' && logged.name === 'Banana, raw', `logging 150 g of banana in the app puts the log on the server (server has: ${describe(logged)})`);
  if (!logged) throw new Error('the log did not reach the server');

  // Edit it to 200 g.
  await btn('Edit Banana, raw').click();
  await nutrition();
  await page.getByLabel('Grams').fill('200');
  await btn('Done').click();
  await home('Banana, raw');
  const edited = await until('the edit to reach the server', async () => (await logsToday()).find((l) => l.id === logged.id && Number(l.quantity) === 200)).catch(() => null);
  check(!!edited, `editing it to 200 g changes the same log on the server (server has: ${describe(edited ?? (await logsToday()).find((l) => l.id === logged.id))})`);

  // Delete it.
  await btn('Edit Banana, raw').click();
  await nutrition();
  await btn('More options').click();
  await btn('Delete entry').click();
  await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
  const gone = await until('the delete to reach the server', async () => !(await logsToday()).some((l) => l.id === logged.id)).catch(() => false);
  check(gone, 'deleting it in the app removes the log from the server');

  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} catch (e) {
  check(false, `stopped: ${String(e).split('\n')[0]}`);
}

await browser.close();
server.close();
console.log(`\nRESULT: ${failed ? 'FAIL' : 'ALL PASS'}\n`);
process.exit(failed ? 1 : 0);

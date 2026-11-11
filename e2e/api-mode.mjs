// ────────────────────────────────────────────────────────────────────────────
// The app with the API switched on (EXPO_PUBLIC_API_URL set at build time):
// Food Database searching the API, and the background sync of what the user
// logs (src/lib/sync/). `npm run verify` builds without the variable and covers
// the bundled list; this covers the API paths and what happens when the API
// cannot be reached. Run: `npm run verify:api`.
//
// The API is mocked in the browser (Playwright routes), so no backend is
// needed: a canned search answer, a small sync server that records what the
// app sends (below), then every request aborted to stand for an unreachable
// API, and a revoked token (401). `npm run verify:sync` (e2e/sync-real.mjs)
// is the same idea against the real backend.
// ────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DIST = path.resolve('dist-api');
if (!fs.existsSync(DIST)) {
  console.error('No dist-api/ found: run `npm run verify:api`, which builds it with EXPO_PUBLIC_API_URL set.');
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

// What GET /api/v1/foods/search returns (backend/README.md): portions ordered by gram weight.
const food = (fdc_id, description, calories, portions) => ({
  fdc_id, description, data_type: 'Survey (FNDDS)', brand_name: null,
  calories_per_100g: calories, protein_per_100g: 0.74, carbs_per_100g: 22.7, fat_per_100g: 0.28,
  fiber_per_100g: 1.7, sugar_per_100g: null, sodium_mg_per_100g: 0,
  portions: portions.map(([description, gram_weight], i) => ({ id: fdc_id * 10 + i, description, gram_weight })),
});
const ANSWERS = {
  banana: [
    food(2709224, 'Banana, raw', 97, [['1 slice', 6], ['1 linear inch', 15], ['1 banana', 126], ['1 cup', 150], ['1 cup, mashed', 225]]),
    food(2705660, 'Banana split', 199, [['1 banana split', 490]]),
  ],
  'chiken brest': [food(2705964, 'Chicken breast, roll, oven-roasted', 134, [])],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const btn = (name) => page.getByRole('button', { name, exact: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// The app's own console errors. The browser logs every failed or 401 request itself
// ("Failed to load resource"), which the unreachable and 401 cases cause on purpose.
page.on('console', (m) => {
  if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 200)}`);
});
const searches = []; // the q of every API request
let bundle = 0; // requests for the bundled list's chunk
page.on('request', (r) => {
  if (r.url().includes('usda-foods')) bundle++;
});

// ── The mocked API ───────────────────────────────────────────────────────────
// POST /api/v1/devices and POST /api/v1/sync as backend/README.md describes them
// ("Identity", "Sync (the app)"), keeping what the app sent so the checks can read it.
const api = {
  down: false, // true: every request is aborted (the API cannot be reached)
  devices: [], // the body of every registration
  tokens: [], // the token issued for each registration, in order
  revoked: new Set(), // tokens /sync answers 401 to
  refused: 0, // how many syncs were answered 401
  requests: [], // every sync answered 200: { token, body }
  rev: 0, // the server's change counter: the cursor of a response
  rows: [], // rows "changed on the server" for the app to pull: { rev, table, row }
};
/** A row changes on the server: the app gets it on its next sync, as from another client. */
const serve = (table, row) => api.rows.push({ rev: ++api.rev, table, row });
/** Revokes the app's current token: its next sync is answered 401. */
const revoke = () => api.revoked.add(api.tokens.at(-1));
const TABLES = ['food_logs', 'saved_foods', 'goals', 'daily_steps'];
const count = (changes) => TABLES.reduce((n, t) => n + (changes?.[t]?.length ?? 0), 0);

// The app's page and the API are different origins and a sync is a POST with Authorization
// and a JSON body, so the browser asks first (OPTIONS) and needs the CORS headers on every answer.
const CORS = { 'access-control-allow-origin': '*' };
const PREFLIGHT = { ...CORS, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' };
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...CORS, ...headers }, body: JSON.stringify(body) });
const mock = (pattern, method, answer) =>
  page.route(pattern, async (route) => {
    const request = route.request();
    if (api.down) return route.abort();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: PREFLIGHT });
    if (request.method() !== method) return json(route, 405, { detail: 'Method Not Allowed' });
    await answer(route, request);
  });

await page.route('**/api/v1/foods/search*', async (route) => {
  const q = new URL(route.request().url()).searchParams.get('q');
  searches.push(q);
  if (api.down) return route.abort();
  await json(route, 200, { foods: ANSWERS[q] ?? [], limit: 50, offset: 0 });
});
await mock('**/api/v1/devices', 'POST', (route, request) => {
  const token = `kalo_e2e_${api.tokens.length + 1}`;
  api.devices.push(request.postDataJSON());
  api.tokens.push(token);
  api.rows = []; // a new user has nothing on the server
  return json(route, 201, { user_id: randomUUID(), token });
});
await mock('**/api/v1/sync', 'POST', async (route, request) => {
  const auth = (await request.headerValue('authorization')) ?? '';
  const token = auth.replace(/^Bearer /, '');
  if (!auth.startsWith('Bearer ') || !api.tokens.includes(token) || api.revoked.has(token)) {
    api.refused++;
    return json(route, 401, { detail: 'Not authenticated' }, { 'www-authenticate': 'Bearer' });
  }
  const body = request.postDataJSON();
  // Pull: what changed on the server since the app's cursor. Push: each row is one more change.
  const changes = Object.fromEntries(TABLES.map((t) => [t, api.rows.filter((r) => r.table === t && r.rev > (body.cursor ?? 0)).map((r) => r.row)]));
  api.rev += count(body.changes);
  api.requests.push({ token, body });
  return json(route, 200, { cursor: api.rev, has_more: false, changes, rejected: [] });
});

let failed = 0;
// `detail` (what the app sent) is printed only when the check fails.
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (!ok) failed++;
};
const open = async (route = '/food-database') => {
  await page.goto(base + route, { waitUntil: 'networkidle' });
  await wait(500);
};

// A push follows a local change by about 2 s (the engine's delay), so the checks wait for
// what they expect, with a timeout, instead of sleeping.
const until = async (what, probe, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await wait(100);
  }
};
/** The rows of one table the app pushed, in the requests from index `from` on. */
const rows = (table, from = 0) => api.requests.slice(from).flatMap((r) => r.body.changes?.[table] ?? []);
/** Waits for a pushed row. */
const pushed = (what, table, match, from) => until(what, () => rows(table, from).find(match));
/** Waits for the sync request number `index` (0 = the first the server answered). */
const request = (what, index) => until(what, () => api.requests[index]);
const stored = (key) => page.evaluate((k) => localStorage.getItem(k), key);
/** Waits until the app has stored the last answer (nothing left to send, the cursor moved), so a reload cannot lose it. */
const settled = () =>
  until('the app to store the sync result (sync:outbox empty, sync:cursor at the server\'s)', async () => (await stored('sync:outbox')) === '{}' && Number(await stored('sync:cursor')) === api.rev);

const keys = (o) => Object.keys(o ?? {}).sort().join(',');
const iso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUTRIENTS = 'calories,carbs_g,fat_g,fiber_g,protein_g,sodium_mg,sugar_g';
const LOG_KEYS = 'deleted_at,fdc_id,food_name,food_values,id,log_date,logged_at,name,quantity,unit,updated_at,values';
const SEED_SAVED = '169640,170894,2708118'; // src/lib/seedIds.ts: honey, Greek yogurt, Clif Bar
const savedIds = (list) => list.map((r) => r.fdc_id).sort((a, b) => a - b).join(',');
const show = (x) => JSON.stringify(x);
const nutrition = () => page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
const home = async (name) => {
  await btn(`Edit ${name}`).waitFor({ timeout: 5000 });
  await wait(400); // the Nutrition screen slides away
};

try {
  await open();
  check((await page.getByPlaceholder('Search foods', { exact: true }).count()) === 1, 'the placeholder has no food count');
  check((await page.getByText('Search USDA FoodData Central.', { exact: true }).count()) === 1, 'the empty prompt names the source');
  check(bundle === 0, 'the bundled list is not loaded when the screen opens');

  // ── Sync: the first run registers the device and uploads what the app starts with ──
  const today = await page.evaluate(() => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  });
  const first = await request('the first sync', 0);
  await settled();
  check(api.devices.length === 1 && api.devices[0].platform === 'web', `the device registers exactly once, as platform web`, `sent: ${show(api.devices)}`);
  check(first.token === api.tokens[0], 'the first sync carries Authorization: Bearer <the token from the registration>');
  check(((await stored('kalo.token')) ?? '').replace(/^"|"$/g, '') === api.tokens[0], 'the token is kept in localStorage under kalo.token');
  check(first.body.cursor === null, `the first sync pulls from the start (cursor: ${show(first.body.cursor)})`);
  const goal = first.body.changes.goals?.[0];
  check(
    first.body.changes.goals?.length === 1 && goal.effective_date === '2020-01-01' && goal.calories === 3027 && goal.protein_g === 182 && goal.steps === 10000 && goal.goal === 'gain' &&
      keys(goal) === 'calories,carbs_g,deleted_at,effective_date,fat_g,fiber_g,goal,protein_g,sodium_mg,steps,sugar_g,updated_at' && iso(goal.updated_at) && goal.deleted_at === null,
    `it uploads the goals as one row in force since 2020-01-01`, `sent: ${show(first.body.changes.goals)}`,
  );
  const steps = first.body.changes.daily_steps ?? [];
  check(
    steps.length === 6 && steps.find((r) => r.log_date === today)?.steps === 5782 && steps.every((r) => keys(r) === 'deleted_at,log_date,steps,updated_at' && iso(r.updated_at) && r.deleted_at === null),
    `it uploads the six day logs as steps, without the rollover`, `sent: ${show(steps)}`,
  );
  const saved = first.body.changes.saved_foods ?? [];
  check(
    savedIds(saved) === SEED_SAVED && saved.every((r) => keys(r) === 'deleted_at,fdc_id,saved_at,updated_at' && iso(r.saved_at) && iso(r.updated_at) && r.deleted_at === null),
    `it uploads the three demo saved foods`, `sent: ${show(saved)}`,
  );
  check((first.body.changes.food_logs ?? []).length === 0, `it uploads no demo entries`, `sent: ${(first.body.changes.food_logs ?? []).length} food logs`);
  check((await stored('sync:primed')) === '1', 'the first upload is recorded (sync:primed), so it happens once');

  await page.getByLabel('Search foods').pressSequentially('banana', { delay: 30 });
  await btn('Banana, raw').waitFor({ timeout: 5000 });
  check(searches.length === 1 && searches[0] === 'banana', `one debounced request for six keystrokes`, `sent: ${JSON.stringify(searches)}`);
  check((await page.getByText('1 banana (126 g) · 122 cal').count()) === 1, 'the row shows the default serving picked from the API portions');
  check((await page.getByText('Data: USDA FoodData Central', { exact: true }).count()) === 1, 'the footer names the source');

  await page.getByLabel('Search foods').fill('chiken brest');
  await btn('Chicken breast, roll, oven-roasted').waitFor({ timeout: 5000 });
  check((await page.getByText('100 g · 134 cal').count()) === 1, 'a food with no portions shows 100 g');

  const before = searches.length;
  await page.getByLabel('Search foods').fill('banana');
  await btn('Banana, raw').waitFor({ timeout: 3000 });
  check(searches.length === before, 'a query searched before is answered from the cache, with no request');

  await page.getByLabel('Search foods').fill('zzqx');
  await page.getByText('No foods match "zzqx"').waitFor({ timeout: 5000 });
  check(true, 'no results from the API shows the no-match message');

  await page.getByLabel('Search foods').fill('banana');
  await btn('Banana, raw').click();
  await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
  check((await page.getByLabel('Grams').inputValue()) === '126', 'Nutrition opens at the default serving with no second request');
  check((await page.getByLabel('Sugar', { exact: true }).inputValue()) === '0', 'a nutrient the API reports as null is 0');
  check(bundle === 0, 'the bundled list is still not loaded');

  // ── Sync: each local change is pushed about 2 s after it happens ──
  let from = api.requests.length;
  await page.getByLabel('Grams').fill('150');
  await btn('Done').click();
  let at = Date.now();
  await home('Banana, raw');
  const logged = await pushed('the logged banana to be pushed', 'food_logs', (r) => r.fdc_id === 2709224, from);
  const carrier = api.requests.slice(from).find((r) => r.body.changes?.food_logs?.length);
  check(count(carrier.body.changes) === 1 && carrier.token === api.tokens[0], `logging a food from the search sends one food_logs row, ${((Date.now() - at) / 1000).toFixed(1)} s later, with the same token`);
  check(
    keys(logged) === LOG_KEYS && UUID.test(logged.id) && logged.fdc_id === 2709224 && logged.unit === 'g' && logged.quantity === 150 && logged.name === 'Banana, raw' && logged.food_name === 'Banana, raw',
    `the row is the log in grams: fdc_id 2709224, unit g, quantity 150, name and food_name`, `sent: ${show(logged)}`,
  );
  check(
    keys(logged.values) === NUTRIENTS && keys(logged.food_values) === NUTRIENTS && logged.values.calories === 97 && logged.food_values.calories === 97 && logged.food_values.protein_g === 0.74 && logged.values.sugar_g === 0,
    'values and food_values carry the seven nutrients per 100 g (a nutrient the API reports as null is sent as 0)',
  );
  check(logged.log_date === today && iso(logged.logged_at) && iso(logged.updated_at) && logged.deleted_at === null, 'log_date is the local day; logged_at and updated_at are ISO times; deleted_at is null');

  from = api.requests.length;
  await btn('Edit Banana, raw').click();
  await nutrition();
  check((await page.getByLabel('Grams').inputValue()) === '150', 'the entry reopens at the 150 g it was logged at');
  await page.getByLabel('Grams').fill('200');
  await btn('Done').click();
  await home('Banana, raw');
  const edited = await pushed('the edited banana to be pushed', 'food_logs', (r) => r.id === logged.id, from);
  check(
    keys(edited) === LOG_KEYS && edited.quantity === 200 && edited.fdc_id === 2709224 && edited.deleted_at === null && Date.parse(edited.updated_at) > Date.parse(logged.updated_at),
    `editing the entry sends the same log again with quantity 200 and a later updated_at`, `sent: ${show(edited)}`,
  );

  from = api.requests.length;
  await btn('Edit Banana, raw').click();
  await nutrition();
  await btn('More options').click();
  await btn('Delete entry').click();
  await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
  const deleted = await pushed('the deleted banana to be pushed', 'food_logs', (r) => r.id === logged.id, from);
  check(keys(deleted) === 'deleted_at,id,updated_at' && iso(deleted.deleted_at) && iso(deleted.updated_at), `deleting the entry sends a tombstone: its id, updated_at and deleted_at`, `sent: ${show(deleted)}`);

  // ── Sync: a reload neither registers again nor uploads everything again ──
  await settled();
  from = api.requests.length;
  const cursor = api.rev;
  await open();
  const reloaded = await request('a sync after the reload', from);
  check(api.devices.length === 1 && reloaded.token === api.tokens[0], 'a reload does not register again: the stored token is used');
  check(reloaded.body.cursor === cursor && count(reloaded.body.changes) === 0, `a reload uploads nothing again and pulls from the stored cursor`, `sent: ${show(reloaded.body)}, server cursor ${cursor}`);

  from = api.requests.length;
  await page.getByLabel('Search foods').fill('banana');
  await btn('Save Banana, raw').click();
  await btn('Unsave Banana, raw').waitFor({ timeout: 3000 });
  const bookmarked = await pushed('the bookmark to be pushed', 'saved_foods', (r) => r.fdc_id === 2709224, from);
  check(
    keys(bookmarked) === 'deleted_at,fdc_id,saved_at,updated_at' && iso(bookmarked.saved_at) && iso(bookmarked.updated_at) && bookmarked.deleted_at === null,
    `bookmarking a food sends a saved_foods row: fdc_id (a number), saved_at`, `sent: ${show(bookmarked)}`,
  );
  from = api.requests.length;
  await btn('Unsave Banana, raw').click();
  await btn('Save Banana, raw').waitFor({ timeout: 3000 });
  const unsaved = await pushed('the removed bookmark to be pushed', 'saved_foods', (r) => r.fdc_id === 2709224, from);
  check(keys(unsaved) === 'deleted_at,fdc_id,updated_at' && iso(unsaved.deleted_at), `un-bookmarking sends a tombstone: fdc_id, updated_at and deleted_at`, `sent: ${show(unsaved)}`);

  // ── Sync: what changed on the server is written into the app ──
  await settled();
  const soup = {
    id: randomUUID(), fdc_id: null, log_date: today, logged_at: new Date().toISOString(), name: 'Server lentil soup', food_name: null, unit: 'serving', quantity: 1,
    values: { calories: 321, protein_g: 18, carbs_g: 40, fat_g: 9, fiber_g: 8, sugar_g: 3, sodium_mg: 500 }, food_values: null, updated_at: new Date().toISOString(), deleted_at: null,
  };
  const beforePull = api.requests.length;
  serve('food_logs', soup);
  await open('/');
  await btn('Edit Server lentil soup').waitFor({ timeout: 10000 });
  check(true, 'a food log in a sync response appears on Home');
  await settled();
  check(JSON.parse(await stored('entries')).some((e) => e.id === soup.id && e.name === soup.name && e.seed !== true), 'the pulled entry is stored on the device, not as a demo entry');

  from = api.requests.length;
  const removedAt = new Date(Date.now() + 1000).toISOString();
  serve('food_logs', { id: soup.id, updated_at: removedAt, deleted_at: removedAt });
  await open('/');
  await request('a sync after the reload', from);
  await settled();
  await until('the pulled entry to leave Home', async () => (await btn('Edit Server lentil soup').count()) === 0, 5000);
  check(!JSON.parse(await stored('entries')).some((e) => e.id === soup.id), 'its tombstone in a later response removes it from Home and from the device');
  check(rows('food_logs', beforePull).every((r) => r.id !== soup.id), 'a pulled row is not pushed back to the server');

  // The API cannot be reached (search, registration and sync alike): the same screen
  // answers from the bundled list.
  const problems = errors.length;
  api.down = true;
  await open();
  await page.getByLabel('Search foods').fill('honey');
  await btn('Honey').waitFor({ timeout: 15000 });
  check((await page.getByText('Offline: searching the built-in list').count()) === 1, 'an unreachable API falls back to the bundled list and says so');
  check(bundle >= 1, 'the bundled list was loaded for the fallback');
  const afterFallback = searches.length;
  await page.getByLabel('Search foods').fill('avocado raw');
  await btn('Avocado, raw').waitFor({ timeout: 5000 });
  check(searches.length === afterFallback, 'after the fallback no more requests are sent on this screen');

  // ── Sync while the API cannot be reached: the app works as before, and catches up later ──
  from = api.requests.length;
  await btn('Avocado, raw').click();
  await nutrition();
  await page.getByLabel('Grams').fill('80');
  await btn('Done').click();
  await home('Avocado, raw');
  check(JSON.parse(await stored('entries')).some((e) => e.foodId === 'usda:2709223' && e.servings === 80), 'with the API unreachable a food is still logged on the device and shown on Home');
  check(errors.length === problems, `the unreachable API causes no page error and no console error of the app's ${show(errors.slice(problems, problems + 3))}`);
  check(api.requests.length === from && api.devices.length === 1, 'nothing reached the server meanwhile');

  api.down = false; // the API is back; the app syncs when it starts
  await open('/');
  const late = await pushed('the entry logged while unreachable to be pushed', 'food_logs', (r) => r.fdc_id === 2709223, from);
  check(
    keys(late) === LOG_KEYS && late.unit === 'g' && late.quantity === 80 && late.name === 'Avocado, raw' && late.deleted_at === null && api.devices.length === 1,
    `once the API is back, the entry logged while it was unreachable is pushed, with no new registration`, `sent: ${show(late)}`,
  );

  // ── Sync: a 401 (the server no longer knows the token) registers again and uploads everything ──
  await settled();
  from = api.requests.length;
  revoke();
  await open('/');
  const full = await until('the upload after registering again', () => api.requests.slice(from).find((r) => r.body.changes?.goals?.length));
  check(api.refused === 1 && api.devices.length === 2 && full.token === api.tokens[1], `a 401 from /sync makes the app register again and sync with the new token (401s: ${api.refused}, registrations: ${api.devices.length})`);
  const demo = new Set(JSON.parse(await stored('entries')).filter((e) => e.seed === true).map((e) => e.id));
  const logs = full.body.changes.food_logs ?? [];
  check(
    full.body.cursor === null && full.body.changes.goals.length === 1 && (full.body.changes.daily_steps ?? []).length === 6 && savedIds(full.body.changes.saved_foods ?? []) === SEED_SAVED,
    `it then uploads everything from the start: the goals, the day logs and the saved foods`, `sent: cursor ${show(full.body.cursor)}, ${show(Object.fromEntries(TABLES.map((t) => [t, full.body.changes[t]?.length ?? 0])))}`,
  );
  check(logs.length === 1 && logs[0].id === late.id && demo.size > 0 && logs.every((r) => !demo.has(r.id)), `with the user's one entry and none of the ${demo.size} demo entries`, `sent: ${logs.length} food logs`);
  await settled();
  const afterFull = api.requests.length;
  await open('/');
  const quiet = await request('a sync after the reload', afterFull);
  check(
    api.devices.length === 2 && quiet.token === api.tokens[1] && count(quiet.body.changes) === 0 && api.requests.slice(from).filter((r) => r.body.changes?.goals?.length).length === 1,
    'everything is uploaded once: the next start sends nothing and keeps the new token',
  );

  check(errors.length === 0, `no page errors and no console errors of the app's ${show(errors.slice(0, 3))}`);
} catch (e) {
  check(false, `stopped: ${String(e).split('\n')[0]}`);
}

await browser.close();
server.close();
console.log(`\nRESULT: ${failed ? '❌ FAIL' : '✅ ALL PASS'}`);
process.exit(failed ? 1 : 0);

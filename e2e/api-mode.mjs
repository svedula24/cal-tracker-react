// ────────────────────────────────────────────────────────────────────────────
// Food Database with the foods API switched on (EXPO_PUBLIC_API_URL set at
// build time). `npm run verify` builds without it and covers the bundled list;
// this covers the API path and its fallback. Run: `npm run verify:api`.
//
// The API is mocked in the browser (Playwright routes), so no backend is
// needed: a canned search answer, then every request aborted to stand for an
// unreachable API.
// ────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
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
const searches = []; // the q of every API request
let bundle = 0; // requests for the bundled list's chunk
let down = false;
page.on('request', (r) => {
  if (r.url().includes('usda-foods')) bundle++;
});
await page.route('**/api/v1/foods/search*', async (route) => {
  const q = new URL(route.request().url()).searchParams.get('q');
  searches.push(q);
  if (down) return route.abort();
  await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ foods: ANSWERS[q] ?? [], limit: 50, offset: 0 }) });
});

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? '✅' : '❌'} ${what}`);
  if (!ok) failed++;
};
const open = async () => {
  await page.goto(base + '/food-database', { waitUntil: 'networkidle' });
  await wait(500);
};

try {
  await open();
  check((await page.getByPlaceholder('Search foods', { exact: true }).count()) === 1, 'the placeholder has no food count');
  check((await page.getByText('Search USDA FoodData Central.', { exact: true }).count()) === 1, 'the empty prompt names the source');
  check(bundle === 0, 'the bundled list is not loaded when the screen opens');

  await page.getByLabel('Search foods').pressSequentially('banana', { delay: 30 });
  await btn('Banana, raw').waitFor({ timeout: 5000 });
  check(searches.length === 1 && searches[0] === 'banana', `one debounced request for six keystrokes (sent: ${JSON.stringify(searches)})`);
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

  // The API cannot be reached: the same screen answers from the bundled list.
  down = true;
  await open();
  await page.getByLabel('Search foods').fill('honey');
  await btn('Honey').waitFor({ timeout: 15000 });
  check((await page.getByText('Offline: searching the built-in list').count()) === 1, 'an unreachable API falls back to the bundled list and says so');
  check(bundle >= 1, 'the bundled list was loaded for the fallback');
  const afterFallback = searches.length;
  await page.getByLabel('Search foods').fill('avocado raw');
  await btn('Avocado, raw').waitFor({ timeout: 5000 });
  check(searches.length === afterFallback, 'after the fallback no more requests are sent on this screen');
  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} catch (e) {
  check(false, `stopped: ${String(e).split('\n')[0]}`);
}

await browser.close();
server.close();
console.log(`\nRESULT: ${failed ? '❌ FAIL' : '✅ ALL PASS'}`);
process.exit(failed ? 1 : 0);

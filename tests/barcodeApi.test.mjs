// The barcode lookup client (src/lib/barcodeApi.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foodFromBarcode, isUpcE, lookupBarcode, upcEToUpcA } from '../src/lib/barcodeApi.ts';
import { ApiUnavailable } from '../src/lib/foodsApi.ts';
import { isFood } from '../src/lib/savedFoods.ts';

// A found product as GET /api/v1/foods/barcode/{code} returns it.
const product = (over = {}) => ({
  code: '0737628064502',
  name: 'Thai Peanut Noodle Kit',
  brand: 'Simply Asia',
  nutrients_per_100g: { calories: 385.0, protein_g: 9.6, carbs_g: 71.2, fat_g: 7.7, fiber_g: 1.9, sugar_g: 13.5, sodium_mg: 1250.0 },
  serving: { label: '0.333 PACKAGE (52 g)', grams: 52.0 },
  source: 'openfoodfacts',
  ...over,
});

/** A fetch that answers every request with `body` and records the calls. */
const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};
const lookup = (fetch, code = '0737628064502') => lookupBarcode('http://api.test/', code, { token: 'kalo_t', fetch });
const unavailable = (promise) => assert.rejects(promise, (e) => e instanceof ApiUnavailable && e.name === 'ApiUnavailable');

test('found: a Food with the off: id, brand before the name, per-100 g nutrients and the serving', async () => {
  const fetch = fakeFetch(product());
  const result = await lookup(fetch);
  assert.deepEqual(result, {
    kind: 'found',
    food: {
      id: 'off:0737628064502',
      name: 'Simply Asia Thai Peanut Noodle Kit',
      per100g: { calories: 385, protein: 9.6, carbs: 71.2, fat: 7.7, fiber: 1.9, sugar: 13.5, sodium: 1250 },
      portions: [{ label: '0.333 PACKAGE (52 g)', grams: 52 }],
    },
  });
  assert.ok(isFood(result.food), 'the Nutrition screen accepts it');
});

test('found: the request goes to the barcode path with the bearer token', async () => {
  const fetch = fakeFetch(product());
  await lookup(fetch);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/foods/barcode/0737628064502');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer kalo_t');
  assert.equal(fetch.calls[0].init.headers.Accept, 'application/json');
});

test('the code is URL-encoded', async () => {
  const fetch = fakeFetch(product());
  await lookup(fetch, '12/34 ?#');
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/foods/barcode/12%2F34%20%3F%23');
});

test('name: just the product name without a brand, or when the name already has the brand', () => {
  assert.equal(foodFromBarcode(product({ brand: null })).name, 'Thai Peanut Noodle Kit');
  assert.equal(foodFromBarcode(product({ brand: '  ' })).name, 'Thai Peanut Noodle Kit');
  assert.equal(foodFromBarcode(product({ name: 'simply asia noodle kit' })).name, 'simply asia noodle kit');
  assert.equal(foodFromBarcode(product({ name: '  Kit ', brand: ' Acme ' })).name, 'Acme Kit');
});

test('portions: none without a serving (Nutrition then defaults to 100 g); an empty label gets one', () => {
  assert.deepEqual(foodFromBarcode(product({ serving: null })).portions, []);
  assert.deepEqual(foodFromBarcode(product({ serving: { label: ' ', grams: 30 } })).portions, [{ label: '1 serving', grams: 30 }]);
});

test('a nutrient reported as null counts as 0', async () => {
  const nutrients = { calories: 50, protein_g: 1, carbs_g: 10, fat_g: 0, fiber_g: null, sugar_g: null, sodium_mg: null };
  const { food } = await lookup(fakeFetch(product({ nutrients_per_100g: nutrients })));
  assert.deepEqual(food.per100g, { calories: 50, protein: 1, carbs: 10, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  assert.ok(isFood(food));
});

test('404: not found, or incomplete with or without a name', async () => {
  assert.deepEqual(await lookup(fakeFetch({ detail: { reason: 'not_found' } }, 404)), { kind: 'not_found' });
  assert.deepEqual(await lookup(fakeFetch({ detail: { reason: 'incomplete', name: 'Mystery Bar' } }, 404)), { kind: 'incomplete', name: 'Mystery Bar' });
  assert.deepEqual(await lookup(fakeFetch({ detail: { reason: 'incomplete', name: null } }, 404)), { kind: 'incomplete', name: null });
});

test('422: not a valid barcode', async () => {
  assert.deepEqual(await lookup(fakeFetch({ detail: [{ msg: 'bad code' }] }, 422)), { kind: 'invalid' });
});

test('unavailable: 503, 401, 429, 500, a 404 from a server without the endpoint', async () => {
  await unavailable(lookup(fakeFetch({ detail: 'product lookup unavailable' }, 503)));
  await unavailable(lookup(fakeFetch({ detail: 'Not authenticated' }, 401)));
  await unavailable(lookup(fakeFetch({ detail: 'Too many requests' }, 429)));
  await unavailable(lookup(fakeFetch('oops', 500)));
  await unavailable(lookup(fakeFetch({ detail: 'Not Found' }, 404)));
});

test('unavailable: a network error, bad JSON, a body of the wrong shape', async () => {
  await unavailable(lookup(async () => { throw new TypeError('Failed to fetch'); }));
  await unavailable(lookup(fakeFetch('not json')));
  await unavailable(lookup(fakeFetch(null)));
  await unavailable(lookup(fakeFetch(product({ name: '' }))));
  await unavailable(lookup(fakeFetch(product({ code: 'abc' }))));
  await unavailable(lookup(fakeFetch(product({ nutrients_per_100g: { calories: 1, protein_g: 1, carbs_g: 1 } }))));
  await unavailable(lookup(fakeFetch(product({ serving: { label: '1 bar', grams: 0 } }))));
  await unavailable(lookup(fakeFetch(product({ brand: 7 }))));
});

test('an abort rejects with the abort error, not ApiUnavailable', async () => {
  const controller = new AbortController();
  const fetch = async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(lookupBarcode('http://api.test', '12345670', { token: 't', signal: controller.signal, fetch }), (e) => !(e instanceof ApiUnavailable));
  // An abort the fetch ignores still counts.
  const late = new AbortController();
  const ignoring = async (url, init) => {
    late.abort();
    return new Response(JSON.stringify(product()), { status: 200 });
  };
  await assert.rejects(lookupBarcode('http://api.test', '12345670', { token: 't', signal: late.signal, fetch: ignoring }), (e) => !(e instanceof ApiUnavailable));
});

test('upcEToUpcA: the GS1 expansion for each last digit, the check digit kept', () => {
  assert.equal(upcEToUpcA('04252614'), '042100005264'); // last digit 0-2: manufacturer ab+last, product cde
  assert.equal(upcEToUpcA('01234565'), '012345000065'); // 5-9: abcde, then 0000 and the last digit
  assert.equal(upcEToUpcA('01234530'), '012300000450'); // 3
  assert.equal(upcEToUpcA('01234540'), '012340000050'); // 4
  assert.equal(upcEToUpcA('11234500'), '112000003450'); // number system 1, last digit 0
  // Not a UPC-E: unchanged.
  for (const code of ['21234565', '1234565', '012345650', '0123456a']) assert.equal(upcEToUpcA(code), code);
});

test('isUpcE: the type names platforms report', () => {
  for (const t of ['upc_e', 'upce', 'UPC_E', 'org.gs1.UPC-E']) assert.ok(isUpcE(t), t);
  for (const t of ['upc_a', 'ean8', 'ean13', 'org.gs1.EAN-8']) assert.ok(!isUpcE(t), t);
});

// The foods API client (src/lib/foodsApi.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiUnavailable, foodFromApi, searchFoodsApi } from '../src/lib/foodsApi.ts';
import { servingSummary } from '../src/lib/measure.ts';
import { isFood } from '../src/lib/savedFoods.ts';

// A search item as the API returns it (portions ordered by gram weight).
const banana = {
  fdc_id: 2709224,
  description: 'Banana, raw',
  data_type: 'Survey (FNDDS)',
  brand_name: null,
  calories_per_100g: 97.0,
  protein_per_100g: 0.74,
  carbs_per_100g: 22.7,
  fat_per_100g: 0.28,
  fiber_per_100g: 1.7,
  sugar_per_100g: 15.8,
  sodium_mg_per_100g: 0.0,
  portions: [
    { id: 26368, description: '1 slice', gram_weight: 6.0 },
    { id: 26367, description: '1 banana', gram_weight: 126.0 },
  ],
};
const envelope = (foods) => ({ foods, limit: 50, offset: 0 });

/** A fetch that answers every request with `body` and records the calls. */
const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};
const unavailable = (promise) => assert.rejects(promise, (e) => e instanceof ApiUnavailable && e.name === 'ApiUnavailable');

test('foodFromApi: the bundled list’s id, per-100 g nutrients, the default serving first', () => {
  const food = foodFromApi(banana);
  assert.deepEqual(food, {
    id: 'usda:2709224',
    name: 'Banana, raw',
    per100g: { calories: 97, protein: 0.74, carbs: 22.7, fat: 0.28, fiber: 1.7, sugar: 15.8, sodium: 0 },
    portions: [
      { label: '1 banana', grams: 126 },
      { label: '1 slice', grams: 6 },
    ],
  });
  assert.ok(isFood(food));
  assert.equal(servingSummary(food).serving, '1 banana (126 g)');
  assert.equal(Math.round(servingSummary(food).nutrients.calories), 122);
});

test('foodFromApi: a nutrient USDA does not report is 0; a food without portions is served by 100 g', () => {
  const food = foodFromApi({ ...banana, fiber_per_100g: null, sugar_per_100g: null, sodium_mg_per_100g: null, portions: [] });
  assert.deepEqual(food.per100g, { calories: 97, protein: 0.74, carbs: 22.7, fat: 0.28, fiber: 0, sugar: 0, sodium: 0 });
  assert.deepEqual(food.portions, []);
  assert.ok(isFood(food));
  assert.equal(servingSummary(food).serving, '100 g');
});

test('searchFoodsApi: one GET with the query encoded, results as Foods in the API’s order', async () => {
  const fetch = fakeFetch(envelope([banana, { ...banana, fdc_id: 1, description: 'Banana chips', portions: [] }]));
  const controller = new AbortController();
  const foods = await searchFoodsApi('http://api.test', 'bananas & cream/50%', { fetch, signal: controller.signal });
  assert.deepEqual(foods.map((f) => f.id), ['usda:2709224', 'usda:1']);
  assert.ok(foods.every(isFood));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/foods/search?q=bananas%20%26%20cream%2F50%25&limit=50');
  assert.equal(new URL(fetch.calls[0].url).searchParams.get('q'), 'bananas & cream/50%');
  assert.equal(fetch.calls[0].init.signal, controller.signal);
  assert.equal(fetch.calls[0].init.method ?? 'GET', 'GET');
});

test('searchFoodsApi: the limit is passed and kept within the API’s maximum; a trailing slash is fine', async () => {
  const fetch = fakeFetch(envelope([]));
  assert.deepEqual(await searchFoodsApi('http://api.test/', 'rice', { fetch, limit: 10 }), []);
  await searchFoodsApi('http://api.test', 'rice', { fetch, limit: 500 });
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    'http://api.test/api/v1/foods/search?q=rice&limit=10',
    'http://api.test/api/v1/foods/search?q=rice&limit=50',
  ]);
});

test('searchFoodsApi: a query over the API’s 100 characters is cut to 100, not sent to be rejected', async () => {
  const fetch = fakeFetch(envelope([banana]));
  await searchFoodsApi('http://api.test', 'a'.repeat(150), { fetch });
  assert.equal(new URL(fetch.calls[0].url).searchParams.get('q'), 'a'.repeat(100));
});

test('searchFoodsApi: an error status is ApiUnavailable', async () => {
  await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: fakeFetch({ detail: 'database unavailable' }, 503) }));
  await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: fakeFetch({ detail: 'oops' }, 500) }));
  await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: fakeFetch({ detail: [{ msg: 'blank' }] }, 422) }));
  await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: fakeFetch('Not found', 404) }));
});

test('searchFoodsApi: a network error is ApiUnavailable, with the cause kept', async () => {
  const failure = new TypeError('Network request failed');
  const promise = searchFoodsApi('http://api.test', 'banana', { fetch: async () => { throw failure; } });
  await assert.rejects(promise, (e) => e instanceof ApiUnavailable && e.cause === failure);
  // A fetch that throws synchronously (or is missing) must not escape as something else.
  await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: () => { throw new Error('no fetch'); } }));
});

test('searchFoodsApi: a body that is not the expected shape is ApiUnavailable', async () => {
  const bodies = [
    '<html>captive portal</html>', // not JSON
    'null',
    [],
    {},
    { foods: 'banana' },
    envelope([null]),
    envelope([{ ...banana, fdc_id: '2709224' }]),
    envelope([{ ...banana, description: '' }]),
    envelope([{ ...banana, calories_per_100g: null }]),
    envelope([{ ...banana, fiber_per_100g: 'n/a' }]),
    envelope([{ ...banana, portions: undefined }]), // an API from before search returned portions
    envelope([{ ...banana, portions: [{ id: 1, description: '1 banana' }] }]),
    envelope([banana, { ...banana, protein_per_100g: undefined }]), // one bad item spoils the page
  ];
  for (const body of bodies) {
    await unavailable(searchFoodsApi('http://api.test', 'banana', { fetch: fakeFetch(body) }));
  }
});

test('searchFoodsApi: an aborted request rejects with the abort error, not ApiUnavailable', async () => {
  // Like the real fetch: rejects with the signal's reason when it aborts.
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason));
    });
  const controller = new AbortController();
  const pending = searchFoodsApi('http://api.test', 'banana', { fetch: hangingFetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ApiUnavailable));

  // Aborted before the call.
  await assert.rejects(
    searchFoodsApi('http://api.test', 'banana', { fetch: hangingFetch, signal: AbortSignal.abort() }),
    (e) => e.name === 'AbortError',
  );

  // Aborted while the body is read, and a fetch that ignores the signal: still an abort, never results.
  const late = new AbortController();
  const ignoringFetch = async () => {
    late.abort();
    return new Response(JSON.stringify(envelope([banana])));
  };
  await assert.rejects(searchFoodsApi('http://api.test', 'banana', { fetch: ignoringFetch, signal: late.signal }), (e) => e.name === 'AbortError');

  // A custom abort reason (a timeout) is passed through as given.
  const reason = new Error('too slow');
  await assert.rejects(
    searchFoodsApi('http://api.test', 'banana', { fetch: hangingFetch, signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
});

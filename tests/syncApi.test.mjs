// The sync API client (src/lib/sync/api.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiUnavailable } from '../src/lib/foodsApi.ts';
import { postSync, registerDevice } from '../src/lib/sync/api.ts';
import { SyncUnauthorized } from '../src/lib/sync/types.ts';

const TOKEN = 'kalo_secret-token-0123456789';
const AT = '2026-11-10T19:12:00.000Z';

const values = { calories: 97, protein_g: 0.74, carbs_g: 22.7, fat_g: 0.28, fiber_g: 1.7, sugar_g: null, sodium_mg: 0 };
const log = {
  id: '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a01',
  fdc_id: 2709224,
  log_date: '2026-11-10',
  logged_at: AT,
  name: 'Banana',
  food_name: 'Banana, raw',
  unit: 'g',
  quantity: 126,
  values,
  food_values: values,
  updated_at: AT,
  deleted_at: null,
};
const custom = { ...log, id: '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a02', fdc_id: null, food_name: null, unit: 'serving', quantity: 1, food_values: null };
const savedFood = { fdc_id: 169640, saved_at: AT, updated_at: AT, deleted_at: null };
const goal = { effective_date: '2026-11-01', calories: 3027, protein_g: 182, carbs_g: 433, fat_g: 94, fiber_g: 38, sugar_g: 113, sodium_mg: 2300, steps: 10000, goal: 'gain', source: 'manual', workout_kcal: 0, active_rest_kcal: 0, updated_at: AT, deleted_at: null };
const steps = { activity_date: '2026-11-10', steps: 5782, day_type: 'workout', workout_kcal: null, updated_at: AT, deleted_at: null };

const response = (changes = {}, rest = {}) => ({
  cursor: 42,
  has_more: false,
  changes: { food_logs: [], saved_foods: [], goals: [], daily_activity: [], ...changes },
  rejected: [],
  ...rest,
});
const request = { cursor: 7, changes: { food_logs: [log] } };

/** A fetch that answers every request with `body` and records the calls. */
const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};
const isUnavailable = (e) => e instanceof ApiUnavailable && e.name === 'ApiUnavailable' && !(e instanceof SyncUnauthorized);
const unavailable = (promise) => assert.rejects(promise, isUnavailable);
/** Everything an error could print: its text, its cause's, and its own fields. */
const printed = (e) => [String(e), e.stack ?? '', String(e.cause ?? ''), e.cause?.stack ?? '', JSON.stringify(e)].join('\n');

test('registerDevice: one POST of {platform, app_version}; the 201 gives the user id and the token', async () => {
  const fetch = fakeFetch({ user_id: '7f0c7b62-4b8e-4b0f-9a52-1c2d3e4f5a6b', token: TOKEN }, 201);
  const got = await registerDevice('http://api.test/', { platform: 'ios', appVersion: '1.4.0' }, { fetch });
  assert.deepEqual(got, { userId: '7f0c7b62-4b8e-4b0f-9a52-1c2d3e4f5a6b', token: TOKEN });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/devices');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(init.body), { platform: 'ios', app_version: '1.4.0' });
});

test('registerDevice: the app version is optional', async () => {
  const fetch = fakeFetch({ user_id: 'u', token: TOKEN }, 201);
  await registerDevice('http://api.test', { platform: 'web' }, { fetch });
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { platform: 'web', app_version: null });
});

test('registerDevice: an error status (the registration limit included), a network error or a wrong body is ApiUnavailable', async () => {
  const info = { platform: 'android' };
  for (const status of [400, 401, 422, 429, 500, 503]) {
    await unavailable(registerDevice('http://api.test', info, { fetch: fakeFetch({ detail: 'no' }, status) }));
  }
  const failure = new TypeError('Network request failed');
  await assert.rejects(registerDevice('http://api.test', info, { fetch: async () => { throw failure; } }), (e) => isUnavailable(e) && e.cause === failure);
  await unavailable(registerDevice('http://api.test', info, { fetch: () => { throw new Error('no fetch'); } }));
  for (const body of ['<html>', 'null', [], {}, { user_id: 'u' }, { token: TOKEN }, { user_id: 'u', token: '' }, { user_id: 1, token: TOKEN }, { user_id: 'u', token: 5 }]) {
    await unavailable(registerDevice('http://api.test', info, { fetch: fakeFetch(body, 201) }));
  }
});

test('registerDevice: an aborted request rejects with the abort error', async () => {
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const controller = new AbortController();
  const pending = registerDevice('http://api.test', { platform: 'ios' }, { fetch: hangingFetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ApiUnavailable));
});

test('postSync: one POST with the bearer token and the request as JSON; the response comes back as sent', async () => {
  const body = response(
    { food_logs: [log, custom], saved_foods: [savedFood], goals: [goal], daily_activity: [steps] },
    { has_more: true, rejected: [{ table: 'saved_foods', key: '1', reason: 'unknown_food' }] },
  );
  const fetch = fakeFetch(body);
  const controller = new AbortController();
  const got = await postSync('http://api.test//', TOKEN, request, { fetch, signal: controller.signal });
  assert.deepEqual(got, body);
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/sync');
  assert.ok(!url.includes(TOKEN));
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.signal, controller.signal);
  assert.deepEqual(JSON.parse(init.body), request);
  assert.ok(!init.body.includes(TOKEN));
});

test('postSync: a first sync (no cursor, nothing to push) and an empty response', async () => {
  const fetch = fakeFetch(response({}, { cursor: 0 }));
  const got = await postSync('http://api.test', TOKEN, { cursor: null, changes: {} }, { fetch });
  assert.deepEqual(got, response({}, { cursor: 0 }));
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { cursor: null, changes: {} });
});

test('postSync: a 401 is SyncUnauthorized, not ApiUnavailable', async () => {
  const promise = postSync('http://api.test', TOKEN, request, { fetch: fakeFetch({ detail: 'Invalid token' }, 401) });
  await assert.rejects(promise, (e) => e instanceof SyncUnauthorized && e.name === 'SyncUnauthorized' && !(e instanceof ApiUnavailable));
});

test('postSync: any other error status is ApiUnavailable', async () => {
  for (const status of [400, 403, 404, 413, 422, 429, 500, 502, 503]) {
    await unavailable(postSync('http://api.test', TOKEN, request, { fetch: fakeFetch({ detail: 'no' }, status) }));
  }
});

test('postSync: a network error is ApiUnavailable, with the cause kept', async () => {
  const failure = new TypeError('Network request failed');
  await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch: async () => { throw failure; } }), (e) => isUnavailable(e) && e.cause === failure);
  // A fetch that throws synchronously (or is missing) must not escape as something else.
  await unavailable(postSync('http://api.test', TOKEN, request, { fetch: () => { throw new Error('no fetch'); } }));
});

test('postSync: no error carries the token', async () => {
  const fetches = [
    fakeFetch({ detail: 'Invalid token' }, 401),
    fakeFetch({ detail: `echo ${TOKEN}` }, 500), // even when the server's answer repeats it
    fakeFetch(`not json ${TOKEN}`),
    fakeFetch({ nope: TOKEN }),
    async () => { throw new TypeError('Network request failed'); },
  ];
  for (const fetch of fetches) {
    await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch }), (e) => !printed(e).includes(TOKEN));
  }
});

test('postSync: a body that is not a SyncResponse is ApiUnavailable', async () => {
  const bodies = [
    '<html>captive portal</html>', // not JSON
    'null',
    [],
    {},
    response({}, { cursor: null }),
    response({}, { cursor: '42' }),
    response({}, { cursor: 1.5 }),
    response({}, { cursor: -1 }),
    response({}, { has_more: undefined }),
    response({}, { has_more: 'no' }),
    response({}, { changes: undefined }),
    response({}, { changes: [] }),
    response({}, { rejected: undefined }),
    response({}, { rejected: [null] }),
    response({}, { rejected: [{ table: 'users', key: '1', reason: 'x' }] }),
    response({}, { rejected: [{ table: 'food_logs', key: 1, reason: 'x' }] }),
    response({}, { rejected: [{ table: 'food_logs', key: '1' }] }),
    // Every table must be there, as an array.
    response({ food_logs: undefined }),
    response({ saved_foods: undefined }),
    response({ goals: null }),
    response({ daily_activity: {} }),
  ];
  for (const body of bodies) {
    await unavailable(postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(body) }));
  }
});

test('postSync: one malformed row is ApiUnavailable, so nothing downstream sees it', async () => {
  const bad = {
    food_logs: [
      null,
      'row',
      { ...log, id: undefined },
      { ...log, id: '' },
      { ...log, id: 7 },
      { ...log, updated_at: undefined },
      { ...log, updated_at: 'yesterday' },
      { ...log, updated_at: 1762801920000 },
      { ...log, deleted_at: undefined },
      { ...log, deleted_at: 'never' },
      { ...log, fdc_id: '2709224' },
      { ...log, fdc_id: 1.5 },
      { ...log, log_date: '10/11/2026' },
      { ...log, logged_at: null },
      { ...log, name: '' },
      { ...log, food_name: 5 },
      { ...log, unit: 'oz' },
      { ...log, quantity: '126' },
      { ...log, quantity: null },
      { ...log, values: null },
      { ...log, values: { ...values, calories: null } },
      { ...log, values: { ...values, protein_g: '0.74' } },
      { ...log, values: { ...values, fiber_g: undefined } },
      { ...log, food_values: { ...values, sodium_mg: 'n/a' } },
      { ...log, food_values: undefined },
    ],
    saved_foods: [null, { ...savedFood, fdc_id: '169640' }, { ...savedFood, fdc_id: null }, { ...savedFood, saved_at: undefined }, { ...savedFood, updated_at: '' }],
    goals: [
      { ...goal, effective_date: undefined },
      { ...goal, effective_date: AT },
      { ...goal, calories: null },
      { ...goal, steps: '10000' },
      { ...goal, goal: 'bulk' },
      { ...goal, source: 'guessed' },
      { ...goal, workout_kcal: '300' },
      { ...goal, updated_at: null },
    ],
    daily_activity: [{ ...steps, activity_date: 20261110 }, { ...steps, steps: null }, { ...steps, updated_at: undefined }, { ...steps, deleted_at: 0 }, { ...steps, day_type: 'active_recovery' }, { ...steps, workout_kcal: 'lots' }],
  };
  for (const [table, rows] of Object.entries(bad)) {
    for (const row of rows) {
      await assert.rejects(
        postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response({ [table]: [row] })) }),
        isUnavailable,
        `${table}: ${JSON.stringify(row)}`,
      );
    }
  }
  // One bad row among good ones spoils the response.
  await unavailable(postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response({ food_logs: [log, { ...log, id: null }] })) }));
});

test('postSync: a deleted row needs only its key and the two times', async () => {
  const deleted = {
    food_logs: [{ id: log.id, updated_at: AT, deleted_at: AT }, { ...log, deleted_at: AT }],
    saved_foods: [{ fdc_id: 169640, updated_at: AT, deleted_at: AT }],
    goals: [{ effective_date: '2026-11-01', updated_at: AT, deleted_at: AT }],
    daily_activity: [{ activity_date: '2026-11-10', updated_at: AT, deleted_at: AT }],
  };
  assert.deepEqual((await postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response(deleted)) })).changes, deleted);
  // The key and the times are still required.
  await unavailable(postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response({ food_logs: [{ updated_at: AT, deleted_at: AT }] })) }));
  await unavailable(postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response({ goals: [{ effective_date: '2026-11-01', deleted_at: AT }] })) }));
});

test('postSync: times with an offset and without milliseconds are accepted', async () => {
  const row = { ...log, logged_at: '2026-11-10T14:12:00-05:00', updated_at: '2026-11-10T19:12:00Z' };
  const got = await postSync('http://api.test', TOKEN, request, { fetch: fakeFetch(response({ food_logs: [row] })) });
  assert.deepEqual(got.changes.food_logs, [row]);
});

test('postSync: an aborted request rejects with the abort error, not ApiUnavailable', async () => {
  // Like the real fetch: rejects with the signal's reason when it aborts.
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason));
    });
  const controller = new AbortController();
  const pending = postSync('http://api.test', TOKEN, request, { fetch: hangingFetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ApiUnavailable));

  // Aborted before the call.
  await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch: hangingFetch, signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');

  // Aborted while the body is read, and a fetch that ignores the signal: still an abort, never a response.
  const late = new AbortController();
  const ignoringFetch = async () => {
    late.abort();
    return new Response(JSON.stringify(response()));
  };
  await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch: ignoringFetch, signal: late.signal }), (e) => e.name === 'AbortError');

  // An abort wins over a 401 that arrived with it.
  const both = new AbortController();
  const unauthorizedFetch = async () => {
    both.abort();
    return new Response('{}', { status: 401 });
  };
  await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch: unauthorizedFetch, signal: both.signal }), (e) => e.name === 'AbortError');

  // A custom abort reason (a timeout) is passed through as given.
  const reason = new Error('too slow');
  await assert.rejects(postSync('http://api.test', TOKEN, request, { fetch: hangingFetch, signal: AbortSignal.abort(reason) }), (e) => e === reason);
});

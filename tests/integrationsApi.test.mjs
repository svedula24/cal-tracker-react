// The integration-token client (src/lib/integrationsApi.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Conflict } from '../src/lib/connectionsApi.ts';
import { ApiUnavailable } from '../src/lib/foodsApi.ts';
import {
  createIntegrationToken, DATE_PLACEHOLDER, HEALTH_LABEL, listIntegrationTokens, problemMessage, revokeIntegrationToken, stepsUrl,
} from '../src/lib/integrationsApi.ts';
import { SyncUnauthorized } from '../src/lib/sync/types.ts';

const DEVICE = 'kalo_device-token-0123456789';
const AT = '2026-11-14T19:12:00.000Z';
const ID = '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a01';
const MADE = { id: ID, token: 'kalo_health-token-abcdef', label: 'Apple Health', created_at: AT };
const LISTED = { id: ID, label: 'Apple Health', created_at: AT, last_used_at: null };

/** A fetch that answers every request with `body` (null: no body) and records the calls. */
const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};

test('createIntegrationToken: POST /api/v1/integration-tokens {label} with the device token; the 201 gives the token once', async () => {
  const fetch = fakeFetch(MADE, 201);
  assert.deepEqual(await createIntegrationToken('http://api.test/', DEVICE, undefined, { fetch }), {
    id: ID, token: MADE.token, label: 'Apple Health', createdAt: AT,
  });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/integration-tokens');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${DEVICE}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { label: HEALTH_LABEL });
});

test('createIntegrationToken: a 409 is Conflict (an ApiUnavailable); a 401 is SyncUnauthorized', async () => {
  await assert.rejects(createIntegrationToken('http://api.test', DEVICE, undefined, { fetch: fakeFetch({ detail: 'x' }, 409) }), (e) => e instanceof Conflict && e instanceof ApiUnavailable);
  await assert.rejects(createIntegrationToken('http://api.test', DEVICE, undefined, { fetch: fakeFetch({ detail: 'x' }, 401) }), SyncUnauthorized);
});

test('createIntegrationToken: an answer without a token is unexpected, and no error carries a token', async () => {
  for (const bad of [{ ...MADE, token: '' }, { ...MADE, id: 1 }, { ...MADE, created_at: 'nope' }, [], 'x']) {
    await assert.rejects(createIntegrationToken('http://api.test', DEVICE, undefined, { fetch: fakeFetch(bad, 201) }), (e) => {
      assert.ok(e instanceof ApiUnavailable && !(e instanceof SyncUnauthorized));
      assert.ok(!String(e.message).includes('kalo_'), 'the message has no token');
      return true;
    });
  }
});

test('listIntegrationTokens: GET /api/v1/integration-tokens, in the server\'s order', async () => {
  const used = { ...LISTED, id: 't2', label: 'Watch', last_used_at: AT };
  const fetch = fakeFetch({ tokens: [LISTED, used] });
  assert.deepEqual(await listIntegrationTokens('http://api.test', DEVICE, { fetch }), [
    { id: ID, label: 'Apple Health', createdAt: AT, lastUsedAt: null },
    { id: 't2', label: 'Watch', createdAt: AT, lastUsedAt: AT },
  ]);
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/integration-tokens');
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.body, undefined);
  for (const bad of [{}, { tokens: [{ ...LISTED, id: '' }] }, { tokens: [{ ...LISTED, last_used_at: 'x' }] }]) {
    await assert.rejects(listIntegrationTokens('http://api.test', DEVICE, { fetch: fakeFetch(bad) }), ApiUnavailable);
  }
});

test('revokeIntegrationToken: DELETE /api/v1/integration-tokens/{id}; 204 or 404 is done, 500 is not', async () => {
  const fetch = fakeFetch(null, 204);
  await revokeIntegrationToken('http://api.test', DEVICE, 'a/b', { fetch });
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/integration-tokens/a%2Fb');
  assert.equal(fetch.calls[0].init.method, 'DELETE');
  await revokeIntegrationToken('http://api.test', DEVICE, ID, { fetch: fakeFetch({ detail: 'gone' }, 404) });
  await assert.rejects(revokeIntegrationToken('http://api.test', DEVICE, ID, { fetch: fakeFetch(null, 500) }), ApiUnavailable);
});

test('stepsUrl: the API origin + /api/v1/daily-activity/{date}/steps', () => {
  assert.equal(stepsUrl('https://kalo.vercel.app/'), `https://kalo.vercel.app/api/v1/daily-activity/${DATE_PLACEHOLDER}/steps`);
  assert.equal(stepsUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/api/v1/daily-activity/{date}/steps');
});

test('problemMessage: plain words for each failure, never the error text', () => {
  assert.match(problemMessage(new Conflict(), 'create'), /10 Health tokens/);
  assert.match(problemMessage(new SyncUnauthorized(), 'list'), /reconnecting/);
  assert.match(problemMessage(new ApiUnavailable('secret detail'), 'revoke'), /Couldn't revoke/);
  assert.doesNotMatch(problemMessage(new ApiUnavailable('secret detail'), 'create'), /secret/);
});

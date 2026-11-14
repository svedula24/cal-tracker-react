// The account endpoints' client (src/lib/connectionsApi.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODE_LIFETIME_MS, codeDeadline, createPairingCode, disconnect, formatCountdown, listConnections, patchMe, TooManyRequests, Unprocessable,
} from '../src/lib/connectionsApi.ts';
import { ApiUnavailable } from '../src/lib/foodsApi.ts';
import { SyncUnauthorized } from '../src/lib/sync/types.ts';

const TOKEN = 'kalo_secret-token-0123456789';
const AT = '2026-11-14T19:12:00.000Z';
const CONN = { id: '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a01', client_name: 'ChatGPT', scopes: ['nutrition:read', 'nutrition:write'], created_at: AT, last_used_at: null };

/** A fetch that answers every request with `body` (null: no body) and records the calls. */
const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};
const isUnavailable = (e) => e instanceof ApiUnavailable && !(e instanceof SyncUnauthorized);

// Each call, with what it is sent and a good answer for it.
const CALLS = {
  createPairingCode: { run: (opts) => createPairingCode('http://api.test', TOKEN, opts), ok: [{ code: 'K7QM-4XPA', expires_at: AT }, 201] },
  listConnections: { run: (opts) => listConnections('http://api.test', TOKEN, opts), ok: [{ connections: [CONN] }, 200] },
  disconnect: { run: (opts) => disconnect('http://api.test', TOKEN, CONN.id, opts), ok: [null, 204] },
  patchMe: { run: (opts) => patchMe('http://api.test', TOKEN, { timezone: 'Europe/Paris' }, opts), ok: [{ user_id: 'u', timezone: 'Europe/Paris', created_at: AT }, 200] },
};

test('createPairingCode: POST /api/v1/pairing-codes with the bearer token and no body; the 201 gives the code', async () => {
  const fetch = fakeFetch({ code: 'K7QM-4XPA', expires_at: AT }, 201);
  assert.deepEqual(await createPairingCode('http://api.test/', TOKEN, { fetch }), { code: 'K7QM-4XPA', expiresAt: AT });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/pairing-codes');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.body, undefined);
  assert.equal(init.headers['Content-Type'], undefined);
});

test('listConnections: GET /api/v1/connections, as the app\'s Connection', async () => {
  const used = { ...CONN, id: 'c2', client_name: 'Other', scopes: ['nutrition:read'], last_used_at: AT };
  const fetch = fakeFetch({ connections: [CONN, used] });
  const got = await listConnections('http://api.test', TOKEN, { fetch });
  assert.deepEqual(got, [
    { id: CONN.id, clientName: 'ChatGPT', scopes: ['nutrition:read', 'nutrition:write'], createdAt: AT, lastUsedAt: null },
    { id: 'c2', clientName: 'Other', scopes: ['nutrition:read'], createdAt: AT, lastUsedAt: AT },
  ]);
  assert.equal(fetch.calls[0].url, 'http://api.test/api/v1/connections');
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.deepEqual(await listConnections('http://api.test', TOKEN, { fetch: fakeFetch({ connections: [] }) }), []);
});

test('disconnect: DELETE /api/v1/connections/{id}; a 204 or a 404 (already gone) is done', async () => {
  const fetch = fakeFetch(null, 204);
  await disconnect('http://api.test', TOKEN, CONN.id, { fetch });
  assert.equal(fetch.calls[0].url, `http://api.test/api/v1/connections/${CONN.id}`);
  assert.equal(fetch.calls[0].init.method, 'DELETE');
  await disconnect('http://api.test', TOKEN, 'x', { fetch: fakeFetch({ detail: 'connection not found' }, 404) });
  const odd = fakeFetch(null, 204);
  await disconnect('http://api.test', TOKEN, '../me?x=1', { fetch: odd });
  assert.equal(odd.calls[0].url, 'http://api.test/api/v1/connections/..%2Fme%3Fx%3D1', 'the id cannot leave its path segment');
});

test('patchMe: a zone the server does not know (422) is Unprocessable, an ApiUnavailable', async () => {
  await assert.rejects(
    patchMe('http://api.test', TOKEN, { timezone: 'Mars/Base' }, { fetch: fakeFetch({ detail: 'unknown timezone' }, 422) }),
    (e) => e instanceof Unprocessable && e instanceof ApiUnavailable,
  );
});

test('patchMe: PATCH /api/v1/me {timezone}', async () => {
  const fetch = fakeFetch({ user_id: 'u', timezone: 'Europe/Paris', created_at: AT });
  assert.deepEqual(await patchMe('http://api.test', TOKEN, { timezone: 'Europe/Paris' }, { fetch }), { timezone: 'Europe/Paris' });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/me');
  assert.equal(init.method, 'PATCH');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { timezone: 'Europe/Paris' });
});

for (const [name, { run }] of Object.entries(CALLS)) {
  test(`${name}: a 401 is SyncUnauthorized (sync registers again), not ApiUnavailable`, async () => {
    await assert.rejects(run({ fetch: fakeFetch({ detail: 'invalid token' }, 401) }), (e) => e instanceof SyncUnauthorized && !(e instanceof ApiUnavailable));
  });

  test(`${name}: an error status, a network error, a timeout or a wrong body is ApiUnavailable, and never shows the token`, async () => {
    const failures = [];
    for (const status of [400, 403, 422, 500, 503]) {
      await assert.rejects(run({ fetch: fakeFetch({ detail: TOKEN }, status) }), (e) => (failures.push(e), isUnavailable(e)));
    }
    const failure = new TypeError(`Network request failed for Bearer ${TOKEN}`);
    await assert.rejects(run({ fetch: async () => { throw failure; } }), (e) => (failures.push(e), isUnavailable(e) && e.cause === failure));
    if (name !== 'disconnect') {
      for (const body of ['not json', { connections: [{ id: 1 }] }, {}, []]) {
        await assert.rejects(run({ fetch: fakeFetch(body) }), (e) => (failures.push(e), isUnavailable(e)));
      }
    }
    // A server that never answers: the timeout gives up.
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    await assert.rejects(run({ fetch: hang, timeoutMs: 20 }), (e) => (failures.push(e), isUnavailable(e) && /in time/.test(e.message)));
    for (const e of failures) {
      const text = [e.message, String(e), e.stack ?? '', JSON.stringify(e)].join('\n');
      assert.ok(!text.includes(TOKEN), `the token is in the error: ${e.message}`);
    }
  });

  test(`${name}: the caller's abort is the abort error, not ApiUnavailable`, async () => {
    const controller = new AbortController();
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = run({ fetch: hang, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e.name === 'AbortError' && !(e instanceof ApiUnavailable));
  });
}

test('the token is only ever in the Authorization header', async () => {
  for (const { run, ok } of Object.values(CALLS)) {
    const fetch = fakeFetch(...ok);
    await run({ fetch });
    const { url, init } = fetch.calls[0];
    assert.ok(!url.includes(TOKEN) && !(init.body ?? '').includes(TOKEN));
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('createPairingCode: 429 (ten codes an hour) is TooManyRequests, an ApiUnavailable', async () => {
  await assert.rejects(createPairingCode('http://api.test', TOKEN, { fetch: fakeFetch({ detail: 'too many' }, 429) }), (e) => e instanceof TooManyRequests && e instanceof ApiUnavailable);
});

test('codeDeadline: the server\'s expiry, unless this clock makes it impossible', () => {
  const at = Date.parse(AT);
  assert.equal(codeDeadline(new Date(at + 9 * 60_000).toISOString(), at), at + 9 * 60_000);
  // Already past or longer than a code lives: the device's clock is off, so the full lifetime.
  assert.equal(codeDeadline(new Date(at - 60_000).toISOString(), at), at + CODE_LIFETIME_MS);
  assert.equal(codeDeadline(new Date(at + 60 * 60_000).toISOString(), at), at + CODE_LIFETIME_MS);
  assert.equal(codeDeadline('not a date', at), at + CODE_LIFETIME_MS);
});

test('formatCountdown: m:ss, rounded up, never negative', () => {
  assert.equal(formatCountdown(10 * 60_000), '10:00');
  assert.equal(formatCountdown(9 * 60_000 + 41_000), '9:41');
  assert.equal(formatCountdown(9 * 60_000 + 40_001), '9:41');
  assert.equal(formatCountdown(5_000), '0:05');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-3000), '0:00');
});

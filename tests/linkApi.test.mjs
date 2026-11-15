// Linking another device (src/lib/linkApi.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequest, TooManyRequests } from '../src/lib/connectionsApi.ts';
import { ApiUnavailable } from '../src/lib/foodsApi.ts';
import { createLinkCode, linkDevice, linkProblem, normaliseCode, shouldOfferLink } from '../src/lib/linkApi.ts';
import { SyncUnauthorized } from '../src/lib/sync/types.ts';

const TOKEN = 'kalo_secret-token-0123456789';
const AT = '2026-11-15T19:12:00.000Z';

const fakeFetch = (body, status = 200) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === null ? null : JSON.stringify(body), { status });
  };
  return Object.assign(fn, { calls });
};

test('createLinkCode: POST /api/v1/link-codes with the bearer token and no body', async () => {
  const fetch = fakeFetch({ code: 'K7QM-4XPA', expires_at: AT }, 201);
  assert.deepEqual(await createLinkCode('http://api.test/', TOKEN, { fetch }), { code: 'K7QM-4XPA', expiresAt: AT });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/link-codes');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.body, undefined);
});

test('createLinkCode: 401, 429 and a malformed answer', async () => {
  await assert.rejects(createLinkCode('http://api.test', TOKEN, { fetch: fakeFetch({}, 401) }), SyncUnauthorized);
  await assert.rejects(createLinkCode('http://api.test', TOKEN, { fetch: fakeFetch({}, 429) }), TooManyRequests);
  await assert.rejects(createLinkCode('http://api.test', TOKEN, { fetch: fakeFetch({ code: 'X', expires_at: 'soon' }, 201) }), ApiUnavailable);
});

test('linkDevice: POST /api/v1/devices/link with the code and the device, without a token', async () => {
  const fetch = fakeFetch({ user_id: 'u-1', token: 'kalo_new', timezone: 'America/New_York' }, 201);
  const got = await linkDevice('http://api.test', { code: 'K7QM-4XPA', platform: 'web', appVersion: '1.0.0', timezone: 'Europe/Paris' }, { fetch });
  assert.deepEqual(got, { userId: 'u-1', token: 'kalo_new', timezone: 'America/New_York' });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://api.test/api/v1/devices/link');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { code: 'K7QM-4XPA', platform: 'web', app_version: '1.0.0', timezone: 'Europe/Paris' });
});

test('linkDevice: 400 is BadRequest (the code), 429 TooManyRequests, 401 and bad answers ApiUnavailable; the code is in no message', async () => {
  const run = (body, status) => linkDevice('http://api.test', { code: 'K7QM-4XPA', platform: 'ios' }, { fetch: fakeFetch(body, status) });
  await assert.rejects(run({ detail: 'invalid or expired code' }, 400), BadRequest);
  await assert.rejects(run({}, 429), TooManyRequests);
  await assert.rejects(run({}, 401), (e) => e instanceof ApiUnavailable && !(e instanceof SyncUnauthorized));
  await assert.rejects(run({ user_id: 'u' }, 201), (e) => e instanceof ApiUnavailable && !/K7QM/.test(e.message));
  const noZone = await run({ user_id: 'u', token: 't' }, 201);
  assert.equal(noZone.timezone, null);
});

test('normaliseCode: forgiving like the server; XXXX-XXXX or null', () => {
  assert.equal(normaliseCode('k7qm-4xpa'), 'K7QM-4XPA');
  assert.equal(normaliseCode(' K7QM 4XPA '), 'K7QM-4XPA');
  assert.equal(normaliseCode('O1IL-ABCD'), '0111-ABCD'); // O is 0, I and L are 1
  assert.equal(normaliseCode('K7QM-4XP'), null);
  assert.equal(normaliseCode('K7QM-4XPAA'), null);
  assert.equal(normaliseCode('K7QM-4XPU'), null); // U is not in the alphabet
  assert.equal(normaliseCode(''), null);
});

test('shouldOfferLink: only a new install (no token, never synced, no data of its own, not answered)', () => {
  const fresh = { hasToken: false, primed: false, ownData: false, answered: false };
  assert.equal(shouldOfferLink(fresh), true);
  for (const key of Object.keys(fresh)) assert.equal(shouldOfferLink({ ...fresh, [key]: true }), false, key);
});

test('linkProblem: what each failure tells the user', () => {
  assert.match(linkProblem(new BadRequest(), 'link'), /mistyped, expired or already used/);
  assert.match(linkProblem(new TooManyRequests(), 'link'), /Too many tries/);
  assert.match(linkProblem(new TooManyRequests(), 'code'), /Too many codes/);
  assert.match(linkProblem(new SyncUnauthorized(), 'code'), /reconnecting/);
  assert.match(linkProblem(new ApiUnavailable('x'), 'link'), /Can't reach/);
  assert.match(linkProblem(new BadRequest(), 'code'), /Can't reach/);
});

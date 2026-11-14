// The device timezone (src/lib/timezone.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createZoneSender, currentTimezone, zoneToRecord } from '../src/lib/timezone.ts';

test('zoneToRecord: the zone only when the server stored the one sent', () => {
  assert.equal(zoneToRecord('America/Los_Angeles', 'America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(zoneToRecord('Europe/Kyiv', 'UTC'), null); // the server did not know it
  assert.equal(zoneToRecord('Europe/Paris', null), null); // a server that does not report it
  assert.equal(zoneToRecord(null, 'UTC'), null); // nothing was sent
});

test('currentTimezone: the IANA name Intl reports', () => {
  assert.equal(currentTimezone(() => 'America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(currentTimezone(() => 'UTC'), 'UTC');
  assert.equal(currentTimezone(() => 'America/Argentina/ComodRivadavia'), 'America/Argentina/ComodRivadavia');
  assert.equal(currentTimezone(() => 'Etc/GMT+5'), 'Etc/GMT+5');
});

test('currentTimezone: by default, this runtime\'s Intl zone', () => {
  assert.equal(currentTimezone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('currentTimezone: null when the runtime has no usable answer', () => {
  for (const answer of [undefined, '', 'Not a zone', 'x'.repeat(65), 42]) {
    assert.equal(currentTimezone(() => answer), null, String(answer));
  }
  assert.equal(currentTimezone(() => { throw new Error('no Intl'); }), null);
});

/** A zone sender over fakes: `state` is the storage, the token and what was PATCHed. */
function sender(over = {}) {
  const state = { zone: 'Europe/Paris', recorded: null, token: 'kalo_a', patched: [], registering: false, fail: null };
  const deps = {
    zone: () => state.zone,
    recorded: async () => state.recorded,
    record: async (z) => { state.recorded = z; },
    token: async () => state.token,
    patch: async (token, zone) => {
      state.patched.push({ token, zone });
      if (state.fail) throw state.fail;
    },
    refused: (e) => e?.refused === true,
    registering: () => state.registering,
    ...over(state),
  };
  return { state, ...createZoneSender(deps) };
}

test('zone sender: sends a changed zone once and records it', async () => {
  const s = sender(() => ({}));
  await s.send();
  await s.send();
  assert.deepEqual(s.state.patched, [{ token: 'kalo_a', zone: 'Europe/Paris' }]);
  assert.equal(s.state.recorded, 'Europe/Paris');
});

test('zone sender: nothing without a token, during a registration, or when already recorded', async () => {
  const s = sender(() => ({}));
  s.state.token = null;
  await s.send();
  s.state.token = 'kalo_a';
  s.state.registering = true;
  await s.send();
  s.state.registering = false;
  s.state.recorded = 'Europe/Paris';
  await s.send();
  assert.deepEqual(s.state.patched, []);
});

test('zone sender: a token replaced during the PATCH (a new account) records nothing', async () => {
  const s = sender((state) => ({
    patch: async (token, zone) => {
      state.patched.push({ token, zone });
      state.token = 'kalo_b'; // a 401 made sync register again meanwhile
    },
  }));
  await s.send();
  assert.equal(s.state.recorded, null);
  await s.send(); // the new account gets it
  assert.deepEqual(s.state.patched.map((p) => p.token), ['kalo_a', 'kalo_b']);
  assert.equal(s.state.recorded, 'Europe/Paris');
});

test('zone sender: a failed PATCH records nothing and is retried; a refused zone waits for forget()', async () => {
  const s = sender(() => ({}));
  s.state.fail = new Error('offline');
  await s.send(); // never rejects
  assert.equal(s.state.recorded, null);
  s.state.fail = Object.assign(new Error('422'), { refused: true });
  await s.send();
  await s.send(); // refused: not sent again
  assert.equal(s.state.patched.length, 2);
  s.forget();
  s.state.fail = null;
  await s.send();
  assert.equal(s.state.patched.length, 3);
  assert.equal(s.state.recorded, 'Europe/Paris');
});

test('zone sender: one send at a time', async () => {
  let release;
  const s = sender((state) => ({
    patch: (token, zone) => {
      state.patched.push({ token, zone });
      return new Promise((r) => { release = r; });
    },
  }));
  const first = s.send();
  while (!release) await new Promise((r) => setTimeout(r, 1)); // the first is now inside the PATCH
  await s.send(); // returns at once: the first is still sending
  release();
  await first;
  assert.equal(s.state.patched.length, 1);
});

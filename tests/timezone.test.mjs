// The device timezone (src/lib/timezone.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentTimezone, zoneToRecord } from '../src/lib/timezone.ts';

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

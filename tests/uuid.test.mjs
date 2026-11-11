// UUID ids (src/lib/uuid.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUuid, uuid } from '../src/lib/uuid.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuid: a v4 id, different each time', () => {
  assert.match(uuid(), V4);
  assert.notEqual(uuid(), uuid());
  assert.ok(isUuid(uuid()));
  for (const bad of ['', 'usda:1', 'mwbc42r1-c86fwt', null, 42]) assert.equal(isUuid(bad), false);
});

test('uuid: without crypto.randomUUID (a web page on plain http) it is built from getRandomValues', () => {
  const real = globalThis.crypto;
  const insecure = { getRandomValues: (bytes) => real.getRandomValues(bytes) };
  Object.defineProperty(globalThis, 'crypto', { value: insecure, configurable: true });
  try {
    const ids = Array.from({ length: 200 }, uuid);
    for (const id of ids) assert.match(id, V4);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

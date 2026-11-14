// UUID ids and the one-time upgrade of stored entries (src/lib/uuid.ts,
// src/lib/migrateEntries.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dropDemoEntries, migrateEntries } from '../src/lib/migrateEntries.ts';
import { isUuid, uuid } from '../src/lib/uuid.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const G = { label: 'g', grams: 1 };
const base = { date: '2026-11-10', time: '2026-11-10T08:00:00.000Z', name: 'Honey', servings: 1, nutrients: {} };
const id = () => uuid();

test('uuid() returns distinct v4 UUIDs; isUuid tells them from the old ids', () => {
  const a = uuid();
  assert.match(a, V4);
  assert.notEqual(a, uuid());
  assert.equal(isUuid(a), true);
  assert.equal(isUuid(a.toUpperCase()), true);
  for (const bad of ['mhk2j3a1-9x8c7', '', 'usda:169640', `${a}x`, undefined, 7]) assert.equal(isUuid(bad), false);
});

test('up-to-date entries are returned as the same array (nothing rewritten)', () => {
  const items = [{ ...base, id: id(), seed: true }, { ...base, id: id(), seed: false, foodId: 'usda:1', measure: G }];
  assert.equal(migrateEntries(items), items);
  assert.equal(migrateEntries([]).length, 0);
});

test('an entry whose id is not a UUID gets a new UUID; everything else is kept', () => {
  const old = { ...base, id: 'mhk2j3a1-9x8c7', seed: false, foodId: 'usda:1', measure: G };
  const keep = { ...base, id: id(), seed: true };
  const [a, b] = migrateEntries([old, keep]);
  assert.match(a.id, V4);
  assert.deepEqual({ ...a, id: old.id }, old);
  assert.equal(b, keep); // untouched entries keep their identity
});

test('an entry from before the flag is demo data when it has no food or is not measured in grams', () => {
  const tagged = migrateEntries([
    { ...base, id: id() }, // hand-written
    { ...base, id: id(), foodId: 'usda:1', measure: { label: '1 cup', grams: 240 } }, // past-day seed
    { ...base, id: id(), foodId: 'usda:1' }, // no measure at all
    { ...base, id: id(), foodId: 'usda:1', measure: G }, // logged by the app
  ]);
  assert.deepEqual(tagged.map((e) => e.seed), [true, true, true, false]);
});

test('an explicit flag is never overwritten, even when the id is replaced', () => {
  const [a, b] = migrateEntries([
    { ...base, id: 'old-1', seed: false }, // an edited demo entry
    { ...base, id: 'old-2', seed: true, foodId: 'usda:1', measure: G },
  ]);
  assert.deepEqual([a.seed, b.seed], [false, true]);
});

test('a second run changes nothing', () => {
  const once = migrateEntries([{ ...base, id: 'old-1' }, { ...base, id: 'old-2', foodId: 'usda:1', measure: G }]);
  assert.equal(migrateEntries(once), once);
});

test('the input array and its entries are not mutated', () => {
  const items = [Object.freeze({ ...base, id: 'old-1' })];
  Object.freeze(items);
  assert.notEqual(migrateEntries(items), items);
});

test('demo entries are dropped once the user has an entry of their own; the rest is kept as is', () => {
  const demo = [{ ...base, id: id(), seed: true }, { ...base, id: id(), seed: true }];
  const mine = { ...base, id: id(), seed: false, foodId: 'usda:1', measure: G };
  assert.deepEqual(dropDemoEntries([demo[0], mine, demo[1]]), [mine]);
  assert.equal(dropDemoEntries([demo[0], mine, demo[1]])[0], mine);
});

test('only demo, only the user\'s, or nothing: the same array comes back (nothing rewritten)', () => {
  const demo = [{ ...base, id: id(), seed: true }];
  const mine = [{ ...base, id: id(), seed: false }];
  for (const items of [demo, mine, []]) assert.equal(dropDemoEntries(items), items);
});

test('at load, an entry tagged demo by migrateEntries is dropped next to one of the user\'s', () => {
  const loaded = dropDemoEntries(migrateEntries([{ ...base, id: 'old-1' }, { ...base, id: id(), foodId: 'usda:1', measure: G }]));
  assert.deepEqual(loaded.map((e) => e.foodId), ['usda:1']);
});

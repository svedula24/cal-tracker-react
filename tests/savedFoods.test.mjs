// One-time cleanup of stored saved foods (src/lib/savedFoods.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSavedFood, migrateSavedFoods } from '../src/lib/savedFoods.ts';

const honey = { id: 'usda:169640', name: 'Honey', serving: '1 tbsp (21 g)', nutrients: { calories: 64, protein: 0, carbs: 17.3, fat: 0, fiber: 0, sugar: 17.2, sodium: 1 } };

test('clean data is returned as the same array (nothing rewritten)', () => {
  const items = [{ id: honey.id, food: honey }];
  assert.equal(migrateSavedFoods(items), items);
});

test('pre-snapshot { id } entries (old hand-written ids) are dropped', () => {
  assert.deepEqual(migrateSavedFoods([{ id: 'protein-bar' }, { id: honey.id, food: honey }, { id: 'honey' }]), [{ id: honey.id, food: honey }]);
});

test('malformed entries and broken snapshots are dropped, never thrown on', () => {
  const bad = [
    null, 'x', 42, {}, { id: 7 },
    { id: 'a', food: {} },
    { id: 'b', food: 'x' },
    { id: 'c', food: { name: 'C' } },
    { id: 'usda:1', food: { ...honey, id: undefined } }, // snapshot without an id: row could never be removed
    { id: 'usda:1', food: { ...honey, id: 'usda:2' } }, // snapshot id differs from the entry
    { id: honey.id, food: { ...honey, nutrients: {} } }, // missing nutrients: totals would be NaN
    { id: honey.id, food: { ...honey, nutrients: { ...honey.nutrients, fat: 'x' } } },
    { id: honey.id, food: { ...honey, serving: undefined } },
  ];
  assert.deepEqual(migrateSavedFoods([...bad, { id: honey.id, food: honey }]), [{ id: honey.id, food: honey }]);
  assert.equal(bad.some(isSavedFood), false);
});

test('duplicate ids keep the first entry', () => {
  const again = { ...honey, name: 'Honey again' };
  assert.deepEqual(migrateSavedFoods([{ id: honey.id, food: honey }, { id: honey.id, food: again }]), [{ id: honey.id, food: honey }]);
});

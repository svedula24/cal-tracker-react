// One-time cleanup of stored saved foods (src/lib/savedFoods.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFood, isSavedFood, migrateSavedFoods, parseFood } from '../src/lib/savedFoods.ts';

const honey = {
  id: 'usda:169640',
  name: 'Honey',
  per100g: { calories: 304, protein: 0.3, carbs: 82.4, fat: 0, fiber: 0.2, sugar: 82.12, sodium: 4 },
  portions: [{ label: '1 tbsp', grams: 21 }],
};

test('clean data is returned as the same array (nothing rewritten)', () => {
  const items = [{ id: honey.id, food: honey }];
  assert.equal(migrateSavedFoods(items), items);
});

test('entries without a usable snapshot are dropped', () => {
  assert.deepEqual(migrateSavedFoods([{ id: 'protein-bar' }, { id: honey.id, food: honey }, { id: 'honey' }]), [{ id: honey.id, food: honey }]);
});

test('malformed entries and snapshots in an older shape are dropped, never thrown on', () => {
  const bad = [
    null, 'x', 42, {}, { id: 7 },
    { id: 'a', food: {} },
    { id: 'b', food: 'x' },
    { id: 'usda:1', food: { ...honey, id: undefined } }, // snapshot without an id: row could never be removed
    { id: 'usda:1', food: { ...honey, id: 'usda:2' } }, // snapshot id differs from the entry
    { id: honey.id, food: { ...honey, per100g: {} } }, // missing nutrients: totals would be NaN
    { id: honey.id, food: { ...honey, per100g: { ...honey.per100g, fat: 'x' } } },
    { id: honey.id, food: { id: honey.id, name: 'Honey', serving: '1 tbsp (21 g)', nutrients: honey.per100g } }, // pre-portions shape
    { id: honey.id, food: { ...honey, portions: [{ label: '1 tbsp', grams: 0 }] } },
  ];
  assert.deepEqual(migrateSavedFoods([...bad, { id: honey.id, food: honey }]), [{ id: honey.id, food: honey }]);
  assert.equal(bad.some(isSavedFood), false);
  assert.ok(isSavedFood({ id: honey.id, food: { ...honey, portions: [] } })); // no portions is fine (100 g)
});

test('isFood guards data from outside the app', () => {
  assert.ok(isFood(honey));
  assert.equal(isFood({}), false);
  assert.equal(isFood({ ...honey, portions: undefined }), false);
  assert.equal(isFood({ ...honey, per100g: { ...honey.per100g, calories: 'x' } }), false);
  assert.equal(isFood({ ...honey, id: '' }), false); // an empty id would lose the food on re-edit
  assert.equal(isFood({ ...honey, name: '' }), false);
});

test('parseFood: a valid JSON food param, else null (cut or edited URLs)', () => {
  assert.deepEqual(parseFood(JSON.stringify(honey)), honey);
  assert.equal(parseFood(undefined), null);
  assert.equal(parseFood(JSON.stringify(honey).slice(0, 40)), null);
  assert.equal(parseFood('{}'), null);
});

test('duplicate ids keep the first entry', () => {
  const again = { ...honey, name: 'Honey again' };
  assert.deepEqual(migrateSavedFoods([{ id: honey.id, food: honey }, { id: honey.id, food: again }]), [{ id: honey.id, food: honey }]);
});

// Recent foods on the + menu (src/lib/recentFoods.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { G } from '../src/lib/measure.ts';
import { recentFoods } from '../src/lib/recentFoods.ts';

const per = (calories) => ({ calories, protein: 1, carbs: 2, fat: 3, fiber: 4, sugar: 5, sodium: 6 });
const food = (n, name, portions = [{ label: '1 piece', grams: 50 }]) => ({ id: `usda:${n}`, name, per100g: per(n), portions });
const banana = food(97, 'Banana, raw', [{ label: '1 banana', grams: 126 }]);
const avocado = food(160, 'Avocado, raw');
const honey = food(304, 'Honey');
const oats = food(379, 'Oats, raw');

let seq = 0;
/** An entry of `grams` of a database food, logged at `time`. */
const logged = (f, grams, time, extra = {}) => ({
  id: `e${++seq}`, date: time.slice(0, 10), time, name: f.name, servings: grams, measure: G,
  nutrients: per(f.per100g.calories / 100), per100g: f.per100g, portions: f.portions, foodId: f.id, foodName: f.name, ...extra,
});
const handWritten = (name, time) => ({ id: `e${++seq}`, date: time.slice(0, 10), time, name, servings: 1, nutrients: per(500) });
const t = (day, hour) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

test('newest first by time, whatever the stored order', () => {
  const entries = [logged(banana, 126, t(8, 9)), logged(honey, 21, t(10, 9)), logged(avocado, 80, t(9, 9))];
  assert.deepEqual(recentFoods(entries, 10), [
    { food: honey, grams: 21 },
    { food: avocado, grams: 80 },
    { food: banana, grams: 126 },
  ]);
});

test('one row per database food, at the most recent amount', () => {
  const entries = [logged(banana, 200, t(10, 8)), logged(avocado, 80, t(9, 9)), logged(banana, 126, t(8, 9)), logged(banana, 50, t(10, 7))];
  assert.deepEqual(recentFoods(entries, 10), [
    { food: banana, grams: 200 },
    { food: avocado, grams: 80 },
  ]);
});

test('the amount is the grams the entry stands for, whatever its measure', () => {
  const [row] = recentFoods([logged(banana, 1.5, t(10, 8), { measure: banana.portions[0] })], 3);
  assert.equal(row.grams, 189); // 1.5 bananas
  assert.equal(recentFoods([logged(banana, 2, t(10, 8), { measure: undefined })], 3)[0].grams, 252); // older entry: default servings
});

test('demo entries and hand-written entries never appear', () => {
  const entries = [
    logged(oats, 40, t(10, 12), { seed: true }),
    handWritten('Sandwich', t(10, 11)),
    { ...handWritten('Whole Milk Latte', t(10, 10)), seed: true },
    logged(honey, 21, t(9, 9)),
  ];
  assert.deepEqual(recentFoods(entries, 10), [{ food: honey, grams: 21 }]);
  assert.deepEqual(recentFoods(entries.slice(0, 3), 10), []); // a new user: nothing
  assert.deepEqual(recentFoods([], 3), []);
});

test('a demo entry of a food does not hide or replace the user\'s own entry of it', () => {
  const entries = [logged(oats, 40, t(10, 12), { seed: true }), logged(oats, 65, t(9, 9))];
  assert.deepEqual(recentFoods(entries, 10), [{ food: oats, grams: 65 }]);
});

test('an edited demo entry (seed: false) counts', () => {
  assert.deepEqual(recentFoods([logged(oats, 60, t(10, 12), { seed: false })], 10), [{ food: oats, grams: 60 }]);
});

test('limit is respected, after duplicates and skipped entries', () => {
  const entries = [
    logged(banana, 126, t(10, 12)),
    logged(banana, 100, t(10, 11)),
    handWritten('Sandwich', t(10, 10)),
    logged(avocado, 80, t(10, 9)),
    logged(honey, 21, t(10, 8)),
    logged(oats, 40, t(10, 7)),
  ];
  assert.deepEqual(recentFoods(entries, 3).map((r) => r.food.name), ['Banana, raw', 'Avocado, raw', 'Honey']);
  assert.equal(recentFoods(entries, 1).length, 1);
  assert.deepEqual(recentFoods(entries, 0), []);
  assert.equal(recentFoods(entries, 10).length, 4);
});

test('a renamed entry yields the database name', () => {
  const [row] = recentFoods([logged(banana, 126, t(10, 8), { name: 'Breakfast' })], 3);
  assert.equal(row.food.name, 'Banana, raw');
});

test('an entry with typed-over values yields the database values', () => {
  const typed = logged(banana, 200, t(10, 8), { per100g: per(150), foodPer100g: banana.per100g, nutrients: per(1.5) });
  assert.deepEqual(recentFoods([typed], 3), [{ food: banana, grams: 200 }]);
});

test('the input is not reordered', () => {
  const entries = [logged(banana, 126, t(8, 9)), logged(honey, 21, t(10, 9))];
  const ids = entries.map((e) => e.id);
  recentFoods(entries, 3);
  assert.deepEqual(entries.map((e) => e.id), ids);
});

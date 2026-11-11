// Measurement math (src/lib/measure.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultServing, editedPer100g, entryGrams, fmt, foodOfEntry, G, HUNDRED_G, parseQty, parseValue, qtyText, scale, servingSummary, times, typedValue, withValue } from '../src/lib/measure.ts';

// USDA "Banana, raw" per 100 g; its portions, default first.
const banana = {
  id: 'usda:2709224',
  name: 'Banana, raw',
  per100g: { calories: 89, protein: 1.09, carbs: 22.84, fat: 0.33, fiber: 2.6, sugar: 12.23, sodium: 1 },
  portions: [
    { label: '1 banana', grams: 126 },
    { label: '1 cup, sliced', grams: 150 },
  ],
};
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('scale: per100g × grams / 100, exactly; times for the quantity', () => {
  close(scale(banana.per100g, 100).calories, 89, '100 g');
  close(scale(banana.per100g, 126).calories, 112.14, '1 banana');
  close(times(scale(banana.per100g, 126), 2).calories, 224.28, '2 bananas');
  close(times(scale(banana.per100g, 1), 50).carbs, 11.42, '50 g carbs');
  assert.deepEqual(Object.keys(scale(banana.per100g, 10)), ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium']);
});

test('G is one gram; times multiplies a per-unit set by a quantity', () => {
  assert.equal(G.grams, 1);
  assert.deepEqual(times({ calories: 10, protein: 1, carbs: 2, fat: 0.5, fiber: 0, sugar: 1, sodium: 3 }, 2.5), { calories: 25, protein: 2.5, carbs: 5, fat: 1.25, fiber: 0, sugar: 2.5, sodium: 7.5 });
});

test('default serving: first portion, else 100 g', () => {
  assert.deepEqual(defaultServing(banana), { label: '1 banana', grams: 126 });
  assert.equal(defaultServing({ ...banana, portions: [] }), HUNDRED_G);
});

test('fmt: one decimal under 10, whole numbers above', () => {
  assert.equal(fmt(0.33), '0.3');
  assert.equal(fmt(2.6), '2.6');
  assert.equal(fmt(22.84), '23');
  assert.equal(fmt(112.14), '112');
});

test('foodOfEntry keeps the database name after a rename; null for hand-written entries', () => {
  const entry = { id: 'e1', date: '2026-11-10', time: 't', name: 'Breakfast', servings: 2, nutrients: banana.per100g, per100g: banana.per100g, portions: banana.portions, measure: banana.portions[0], foodId: banana.id, foodName: 'Banana, raw' };
  assert.deepEqual(foodOfEntry(entry), banana);
  assert.equal(foodOfEntry({ ...entry, foodName: undefined }).name, 'Breakfast'); // older entries: the label is all we have
  assert.equal(foodOfEntry({ id: 'e2', date: '2026-11-10', time: 't', name: 'Sandwich', servings: 1, nutrients: banana.per100g }), null);
});

test('entryGrams: a new food starts at its serving; an entry at the grams it stands for', () => {
  const entry = { id: 'e1', date: '2026-11-10', time: 't', name: 'Banana, raw', servings: 3, nutrients: banana.per100g, per100g: banana.per100g, portions: banana.portions, foodId: banana.id };
  assert.equal(entryGrams(undefined, banana), 126);
  assert.equal(entryGrams({ ...entry, measure: G }, banana), 3); // logged in grams
  assert.equal(entryGrams({ ...entry, servings: 1.5, measure: banana.portions[0] }, banana), 189); // 1.5 bananas
  assert.equal(entryGrams(entry, banana), 378); // no saved measure: 3 default servings, not 1
  close(entryGrams({ ...entry, servings: 1, measure: { label: '1 oz', grams: 28.3495 } }, banana), 28.3495, 'not rounded');
  assert.equal(entryGrams({ ...entry, servings: 0, measure: G }, banana), 126); // nothing to stand for: the serving
  assert.equal(entryGrams({ ...entry, servings: 100, measure: banana.portions[0] }, banana), 12600); // large, and the field accepts it
  assert.equal(parseQty(qtyText(12600)), 12600);
});

test('parseQty: decimals, a decimal comma, thousands separators, and rejects the rest', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty(' 1.5 '), 1.5);
  assert.equal(parseQty('1,5'), 1.5);
  assert.equal(parseQty('0,25'), 0.25);
  assert.equal(parseQty('1,000'), 1000);
  assert.equal(parseQty('1,250'), 1250);
  assert.equal(parseQty('0.333'), 0.33); // kept to 2 decimals, as shown
  assert.equal(parseQty('10000'), 10000);
  assert.equal(parseQty('12600'), 12600); // no upper bound
  assert.equal(parseQty('999999999999999999'), 999999999999999999);
  assert.equal(parseQty(qtyText(999999999999999999)), 999999999999999999); // round-trips through the field
  assert.equal(parseQty('2.'), 2);
  for (const bad of ['', '0', '0.004', '-1', 'abc', '1,000,5', '1.2.3', '1e21', '2000000000000000000000', '0x10', '1 0', 'Infinity']) assert.equal(parseQty(bad), null, bad);
});

test('qtyText shows what is stored', () => {
  assert.equal(qtyText(1), '1');
  assert.equal(qtyText(1.5), '1.5');
  assert.equal(qtyText(0.33), '0.33');
});

test('serving summary for list rows', () => {
  const { serving, nutrients } = servingSummary(banana);
  assert.equal(serving, '1 banana (126 g)');
  close(nutrients.calories, 112.14, 'calories');
  assert.equal(servingSummary({ ...banana, portions: [] }).serving, '100 g');
});

test('parseValue: a typed nutrient value may be 0; parseQty still needs more than 0', () => {
  assert.equal(parseValue('0'), 0);
  assert.equal(parseValue('0.004'), 0); // rounds to 0, which a nutrient may be
  assert.equal(parseValue('12,5'), 12.5);
  assert.equal(parseValue(' 30 '), 30);
  for (const bad of ['', 'abc', '-1', '1.2.3', '1e3']) assert.equal(parseValue(bad), null, bad);
  assert.equal(parseQty('0'), null);
  assert.equal(parseQty('0.004'), null);
});

test('withValue: the typed value reads back at this amount and scales with a new one', () => {
  const perGram = scale(banana.per100g, 1);
  const edited = withValue(perGram, 'protein', 5, 126); // "5" typed while the screen shows 126 g
  close(times(edited, 126).protein, 5, 'reads back');
  close(times(edited, 252).protein, 10, 'double the amount');
  close(times(edited, 126).calories, times(perGram, 126).calories, 'other nutrients untouched');
  assert.equal(times(withValue(perGram, 'sugar', 0, 126), 300).sugar, 0);
  close(times(times(edited, 100), 1.26).protein, 5, 'kept through the per-100 g copy an entry stores');
});

test('an entry with typed-over values keeps the database food beside them', () => {
  const perGram = withValue(scale(banana.per100g, 1), 'protein', 5, 100);
  const per100g = editedPer100g(banana.per100g, perGram, ['protein']);
  close(per100g.protein, 5, 'the edited nutrient');
  assert.deepEqual({ ...per100g, protein: banana.per100g.protein }, banana.per100g); // the others are exactly as stored
  const entry = { id: 'e1', date: '2026-11-10', time: 't', name: 'Banana, raw', servings: 100, nutrients: perGram, per100g, foodPer100g: banana.per100g, portions: banana.portions, measure: G, foodId: banana.id, foodName: banana.name };
  assert.deepEqual(foodOfEntry(entry), banana); // what a bookmark saves
});

test('typedValue: an edit, an invalid draft, and typing back what the field showed', () => {
  const atFocus = { text: '0.7', value: 0.74 };
  assert.equal(typedValue('5', atFocus, 0.74), 5);
  assert.equal(typedValue('0.72', atFocus, 0.74), 0.72); // rounds to the same display, still an edit
  assert.equal(typedValue('abc', atFocus, 0.74), null);
  assert.equal(typedValue('0.7', atFocus, 0.74), null); // retyped: the exact 0.74 stays
  assert.equal(typedValue(' 0.7 ', atFocus, 5), 0.74); // typed back after an edit: the exact value is restored
  assert.equal(typedValue('0', { text: '12', value: 12 }, 12), 0);
});


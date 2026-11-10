// Measurement math (src/lib/measure.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultServing, fmt, foodOfEntry, G, HUNDRED_G, parseQty, qtyText, scale, servingSummary, times } from '../src/lib/measure.ts';

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

test('parseQty: decimals, a decimal comma, thousands separators, and rejects the rest', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty(' 1.5 '), 1.5);
  assert.equal(parseQty('1,5'), 1.5);
  assert.equal(parseQty('0,25'), 0.25);
  assert.equal(parseQty('1,000'), 1000);
  assert.equal(parseQty('1,250'), 1250);
  assert.equal(parseQty('0.333'), 0.33); // kept to 2 decimals, as shown
  assert.equal(parseQty('10000'), 10000);
  assert.equal(parseQty('2.'), 2);
  for (const bad of ['', '0', '0.004', '-1', 'abc', '1,000,5', '1.2.3', '1e21', '0x10', '10001', '1 0', 'Infinity']) assert.equal(parseQty(bad), null, bad);
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

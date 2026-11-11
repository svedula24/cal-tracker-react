// Default serving for portions from the foods API (src/lib/portions.ts). Run: npm test
// The rule mirrors portionsOf in scripts/usda/map.mjs (tests/usdaMap.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { orderPortions } from '../src/lib/portions.ts';

const p = (label, grams) => ({ label, grams });
const labels = (ps) => ps.map((x) => x.label);

test('the default is the portion closest to 100 g; the rest keep the given order', () => {
  // Honey, as the API orders it (by gram weight): 1 tbsp (21 g) beats 1 cup (339 g).
  assert.deepEqual(orderPortions([p('1 packet (0.5 oz)', 14), p('1 tbsp', 21), p('1 cup', 339)]), [
    p('1 tbsp', 21),
    p('1 packet (0.5 oz)', 14),
    p('1 cup', 339),
  ]);
  // Banana: 1 banana (126 g), not 1 slice (6 g).
  assert.deepEqual(orderPortions([p('1 slice', 6), p('1 banana', 126)]), [p('1 banana', 126), p('1 slice', 6)]);
  assert.deepEqual(orderPortions([]), []);
});

test('poor defaults are skipped when a better portion exists, and used when none does', () => {
  // Milk: 1 cup (244 g) beats "Guideline amount…" (61 g), which is closer to 100 g.
  assert.deepEqual(labels(orderPortions([p('1 Guideline amount per cup of hot cereal', 61), p('1 cup', 244)])), [
    '1 cup',
    '1 Guideline amount per cup of hot cereal',
  ]);
  assert.deepEqual(orderPortions([p('1 fl oz', 30)]), [p('1 fl oz', 30)]); // nothing better: still used
  // All poor: the closest to 100 g first, the rest still in the given order.
  assert.deepEqual(labels(orderPortions([p('1 spray', 0.25), p('1 fl oz', 30), p('1 package', 500)])), ['1 fl oz', '1 spray', '1 package']);
  for (const poor of ['1 FL OZ', 'Guideline amount per fl oz of beverage', '1 cup, as ingredient', '1 miniature', '1 NLEA serving', '1 container (2 lb)']) {
    assert.equal(orderPortions([p(poor, 100), p('1 cup', 240)])[0].label, '1 cup', poor);
  }
});

test('ties keep the given order', () => {
  // Equally far from 100 g on either side: the earlier one (the lighter, in the API's order).
  assert.equal(orderPortions([p('1 tablespoon', 15), p('1 pouch', 90), p('1 jar', 110)])[0].label, '1 pouch');
  assert.equal(orderPortions([p('1 jar', 110), p('1 pouch', 90)])[0].label, '1 jar');
  // The same weight under two names.
  assert.deepEqual(labels(orderPortions([p('1 cup', 240), p('1 bowl', 240), p('1 pitcher', 1900)])), ['1 cup', '1 bowl', '1 pitcher']);
});

test('at most 8 portions, the default always among them', () => {
  const many = Array.from({ length: 12 }, (_, i) => p(`portion ${i}`, 10 * (i + 1))); // 10 g … 120 g
  const out = orderPortions(many);
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], p('portion 9', 100)); // 10th in the input, still first
  assert.deepEqual(labels(out.slice(1)), ['portion 0', 'portion 1', 'portion 2', 'portion 3', 'portion 4', 'portion 5', 'portion 6']);
});

test('grams are rounded as the mapper does: 1 decimal, 2 under a gram; weightless portions are dropped', () => {
  // The API stores gram weights as float4, so 28.35 arrives as 28.350000381469727.
  assert.deepEqual(orderPortions([p('1 oz', 28.350000381469727), p('1 tablet', 0.03999999910593033), p('1 cup', 244.06)]), [
    p('1 oz', 28.4),
    p('1 tablet', 0.04),
    p('1 cup', 244.1),
  ]);
  assert.deepEqual(orderPortions([p('1 speck', 0.004), p('1 nothing', 0), p('1 broken', NaN), p('1 negative', -5)]), []);
});

test('the input is not changed', () => {
  const input = [p('1 slice', 6.04), p('1 banana', 126)];
  const copy = structuredClone(input);
  orderPortions(input);
  assert.deepEqual(input, copy);
});

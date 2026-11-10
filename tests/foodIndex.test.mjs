// Offline food search, run against the real bundled USDA data. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createFoodIndex } from '../src/lib/foodIndex.ts';
import { rowToFood } from '../src/lib/foodRow.ts';

const data = JSON.parse(readFileSync(new URL('../src/data/usda-foods.json', import.meta.url), 'utf8'));
const foods = data.rows.map(rowToFood);
const search = createFoodIndex(foods);
const top = (q, n = 1) => search(q).slice(0, n).map((f) => f.name);

test('the bundled data is the full generic USDA set', () => {
  assert.ok(foods.length > 13000, `only ${foods.length} foods`);
  assert.ok(foods.every((f) => f.name && f.serving && Number.isFinite(f.nutrients.calories)));
});

test('plain foods rank first', () => {
  assert.deepEqual(top('banana'), ['Banana, raw']);
  assert.deepEqual(top('honey'), ['Honey']);
  assert.deepEqual(top('apple'), ['Apple, raw']);
});

test('every query word must match the start of a word, in any order', () => {
  const names = search('greek yog', 200).map((f) => f.name);
  assert.ok(names.includes('Yogurt, Greek, plain, nonfat'));
  assert.ok(names.every((n) => /\bgreek/i.test(n) && /\byog/i.test(n)));
});

test('case and punctuation do not matter; empty and unknown queries return nothing', () => {
  assert.deepEqual(top('  BANANA, '), ['Banana, raw']);
  assert.deepEqual(search(''), []);
  assert.deepEqual(search('zzqx'), []);
});

test('results are capped', () => {
  assert.equal(search('raw').length, 50);
  assert.equal(search('raw', 5).length, 5);
});

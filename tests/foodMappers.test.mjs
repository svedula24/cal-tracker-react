// Unit tests for the API → Food mapping. Run: npm test (Node's built-in runner;
// Node strips the TypeScript types from the imported module).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromOff, fromUsda, round } from '../src/lib/foodMappers.ts';

const usda = (nutrients, extra = {}) => ({
  fdcId: 1,
  description: 'Bananas, raw',
  foodNutrients: Object.entries(nutrients).map(([nutrientId, value]) => ({ nutrientId: Number(nutrientId), value })),
  ...extra,
});

test('USDA: maps every nutrient id to its field', () => {
  const f = fromUsda(usda({ 1008: 89, 1003: 1.09, 1005: 22.84, 1004: 0.33, 1079: 2.6, 2000: 12.23, 1093: 1 }));
  assert.deepEqual(f, {
    id: 'usda:1',
    name: 'Bananas, raw',
    serving: '100 g',
    source: 'usda',
    nutrients: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, fiber: 2.6, sugar: 12.2, sodium: 1 },
  });
});

test('USDA: falls back to Atwater energy (2047) and sugars id 1063', () => {
  const f = fromUsda(usda({ 2047: 120, 1063: 4.5 }));
  assert.equal(f.nutrients.calories, 120);
  assert.equal(f.nutrients.sugar, 4.5);
});

test('USDA: skips a food without any energy value', () => {
  assert.equal(fromUsda(usda({ 1003: 5, 1004: 2 })), null);
});

test('USDA: title-cases ALL-CAPS names only', () => {
  assert.equal(fromUsda(usda({ 1008: 1 }, { description: 'GREEK YOGURT' })).name, 'Greek Yogurt');
  assert.equal(fromUsda(usda({ 1008: 1 }, { description: 'Yogurt, Greek, CHOBANI' })).name, 'Yogurt, Greek, CHOBANI');
});

test('Open Food Facts: sodium is converted from g to mg', () => {
  const f = fromOff({ code: '1', product_name: 'Nutella', nutriments: { 'energy-kcal_100g': 539, sodium_100g: 0.043 } });
  assert.equal(f.nutrients.sodium, 43);
});

test('Open Food Facts: maps fields, brand and missing values', () => {
  const f = fromOff({
    code: '3017620422003',
    product_name: ' Nutella ',
    brands: 'Ferrero, Nutella',
    nutriments: { 'energy-kcal_100g': 539.4, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3 },
  });
  assert.deepEqual(f, {
    id: 'off:3017620422003',
    name: 'Nutella',
    brand: 'Ferrero',
    serving: '100 g',
    source: 'off',
    nutrients: { calories: 539, protein: 6.3, carbs: 57.5, fat: 30.9, fiber: 0, sugar: 56.3, sodium: 0 },
  });
});

test('Open Food Facts: skips products without calories, a name or a code', () => {
  assert.equal(fromOff({ code: '1', product_name: 'X', nutriments: {} }), null);
  assert.equal(fromOff({ code: '1', nutriments: { 'energy-kcal_100g': 10 } }), null);
  assert.equal(fromOff({ product_name: 'X', nutriments: { 'energy-kcal_100g': 10 } }), null);
});

test('round: no float artifacts', () => {
  assert.equal(round(0.1 + 0.2, 1), 0.3);
  assert.equal(round(22.84, 1), 22.8);
  assert.equal(round(538.6), 539);
});

// USDA FoodData Central download → Kalo row mapping (scripts/usda/map.mjs). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyze, buildRows, cleanName, per100g, portionsOf, round } from '../scripts/usda/map.mjs';

const nutrients = (map) => Object.entries(map).map(([id, amount]) => ({ nutrient: { id: Number(id) }, amount }));
const sr = (amount, modifier, gramWeight) => ({ amount, modifier, gramWeight, measureUnit: { name: 'undetermined' } });

test('per100g maps nutrient ids, with energy and sugar fallbacks', () => {
  assert.deepEqual(per100g({ foodNutrients: nutrients({ 1008: 89, 1003: 1.1, 1005: 22.8, 1004: 0.3, 1079: 2.6, 2000: 12.2, 1093: 1 }) }), {
    calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, fiber: 2.6, sugar: 12.2, sodium: 1,
  });
  const foundation = per100g({ foodNutrients: nutrients({ 2047: 97, 1063: 15.8 }) });
  assert.equal(foundation.calories, 97);
  assert.equal(foundation.sugar, 15.8);
  assert.equal(foundation.sodium, 0); // missing → 0
});

test('a food without an energy value is skipped', () => {
  assert.equal(per100g({ foodNutrients: nutrients({ 1003: 5 }) }), null);
  assert.equal(analyze({ fdcId: 1, description: 'X', foodNutrients: nutrients({ 1003: 5 }) }), null);
});

test('portions: cleaned labels, de-duplicated, the best default first, the rest in USDA order', () => {
  // SR Legacy style (amount + modifier), honey: 1 tbsp (21 g) beats 1 cup (339 g) as the default.
  assert.deepEqual(portionsOf({ foodPortions: [sr(1, 'cup', 339), sr(1, 'tbsp', 21), sr(1, 'packet (0.5 oz)', 14), sr(1, 'TBSP', 21)] }), [
    { label: '1 tbsp', grams: 21 },
    { label: '1 cup', grams: 339 },
    { label: '1 packet (0.5 oz)', grams: 14 },
  ]);
  // Foundation style (value + unit + modifier); RACC entries are skipped.
  assert.deepEqual(
    portionsOf({ foodPortions: [
      { value: 1, measureUnit: { name: 'RACC' }, gramWeight: 100 },
      { value: 1, measureUnit: { name: 'Banana' }, modifier: 'Peeled', gramWeight: 110 },
    ] }),
    [{ label: '1 banana (Peeled)', grams: 110 }],
  );
  // FNDDS style; "Quantity not specified" is skipped; internal "From 12345" refs are dropped.
  assert.deepEqual(
    portionsOf({ foodPortions: [
      { portionDescription: 'Quantity not specified', gramWeight: 100 },
      { portionDescription: '1 banana split', gramWeight: 490 },
    ] }),
    [{ label: '1 banana split', grams: 490 }],
  );
  assert.equal(portionsOf({ foodPortions: [sr(0.5, 'cup From 19191', 147)] })[0].label, '0.5 cup');
  assert.deepEqual(portionsOf({}), []);
});

test('portions that differ only by a leading "1 " are one chip; USDA order is kept after the default', () => {
  assert.deepEqual(portionsOf({ foodPortions: [sr(1, 'package (10 oz)', 284), { portionDescription: 'package (10 oz)', gramWeight: 284 }] }), [{ label: '1 package (10 oz)', grams: 284 }]);
  // All poor defaults: the closest to 100 g first, the rest still in USDA order (no in-place sort).
  assert.deepEqual(
    portionsOf({ foodPortions: [sr(1, 'package', 500), sr(1, 'fl oz', 30), sr(1, 'spray', 0.25)] }).map((p) => p.label),
    ['1 fl oz', '1 package', '1 spray'],
  );
});

test('poor default portions are skipped when a better one exists, and capped at 8', () => {
  const milk = { foodPortions: [sr(1, 'Guideline amount per cup of hot cereal', 61), sr(1, 'cup', 244)] };
  assert.equal(portionsOf(milk)[0].label, '1 cup');
  assert.equal(portionsOf({ foodPortions: [{ portionDescription: '1 fl oz', gramWeight: 30 }] })[0].label, '1 fl oz'); // nothing better: still used
  const many = { foodPortions: Array.from({ length: 12 }, (_, i) => sr(1, `portion ${i}`, 50 + i)) };
  assert.equal(portionsOf(many).length, 8);
});

test('analyze: per-100 g nutrients (2 decimals, sodium whole) and portions, plus a completeness score', () => {
  const honey = analyze({
    fdcId: 169640,
    description: "Honey (Includes foods for USDA's Food Distribution Program)",
    foodNutrients: nutrients({ 1008: 304, 1003: 0.3, 1005: 82.4, 2000: 82.123, 1093: 4.4 }),
    foodPortions: [sr(1, 'tbsp', 21)],
  });
  assert.deepEqual(honey.row, [169640, 'Honey', [304, 0.3, 82.4, 0, 0, 82.12, 4], [['1 tbsp', 21]]]);
  assert.equal(honey.score, 5 * 2 + 1); // 5 nutrients reported + a real portion
  assert.equal(analyze({ fdcId: 1, description: 'A', foodNutrients: nutrients({ 1008: 1 }) }).score, 2);
});

test('negative USDA values are clamped to 0; sub-gram portions keep two decimals, 0 g ones are dropped', () => {
  assert.equal(per100g({ foodNutrients: nutrients({ 1008: 300, 1005: -0.7 }) }).carbs, 0);
  const spray = analyze({ fdcId: 9, description: 'Oil, spray', foodNutrients: nutrients({ 1008: 800 }), foodPortions: [sr(1, 'spray , about 1/3 second', 0.25)] });
  assert.deepEqual(spray.row[3], [['1 spray, about 1/3 second', 0.25]]);
  assert.deepEqual(portionsOf({ foodPortions: [sr(1, 'speck', 0.001)] }), []);
});

test('names lose USDA program notes; duplicates keep the most complete, then the earlier dataset', () => {
  assert.equal(cleanName("Apples, raw, gala (Includes foods for USDA's Food Distribution Program)"), 'Apples, raw, gala');
  const food = (fdcId, dataType, extra = {}) => ({ fdcId, dataType, description: 'Egg, raw', foodNutrients: nutrients({ 1008: 1, ...extra }) });
  // Equally complete: the earlier dataset wins.
  assert.equal(buildRows([food(3, 'Survey (FNDDS)'), food(1, 'Foundation'), food(2, 'SR Legacy')])[0][0], 1);
  // A more complete record beats a sparse Foundation one.
  const rows = buildRows([food(1, 'Foundation'), food(2, 'SR Legacy', { 1003: 6, 1004: 5, 1079: 0 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 2);
});

test('round: no float artifacts', () => {
  assert.equal(round(0.1 + 0.2, 1), 0.3);
  assert.equal(round(63.84), 64);
  assert.equal(round(82.123, 2), 82.12);
});

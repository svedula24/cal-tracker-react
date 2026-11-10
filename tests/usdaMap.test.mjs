// USDA FoodData Central download → Kalo row mapping (scripts/usda/map.mjs). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRows, cleanName, defaultServing, per100g, round, toRow } from '../scripts/usda/map.mjs';

const nutrients = (map) => Object.entries(map).map(([id, amount]) => ({ nutrient: { id: Number(id) }, amount }));

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
  assert.equal(toRow({ fdcId: 1, description: 'X', foodNutrients: nutrients({ 1003: 5 }) }), null);
});

test('default serving: the named portion closest to 100 g', () => {
  // SR Legacy style (amount + modifier), honey: 1 tbsp (21 g) beats 1 cup (339 g).
  assert.deepEqual(
    defaultServing({ foodPortions: [
      { amount: 1, modifier: 'cup', gramWeight: 339, sequenceNumber: 1, measureUnit: { name: 'undetermined' } },
      { amount: 1, modifier: 'tbsp', gramWeight: 21, sequenceNumber: 2, measureUnit: { name: 'undetermined' } },
    ] }),
    { label: '1 tbsp', grams: 21 },
  );
  // Foundation style (value + unit + modifier); RACC entries are skipped.
  assert.deepEqual(
    defaultServing({ foodPortions: [
      { value: 1, measureUnit: { name: 'RACC' }, gramWeight: 100 },
      { value: 1, measureUnit: { name: 'Banana' }, modifier: 'Peeled', gramWeight: 110 },
    ] }),
    { label: '1 banana (Peeled)', grams: 110 },
  );
  // FNDDS style; "Quantity not specified" is skipped; internal "From 12345" refs are dropped.
  assert.deepEqual(
    defaultServing({ foodPortions: [
      { portionDescription: 'Quantity not specified', gramWeight: 100 },
      { portionDescription: '1 banana split', gramWeight: 490 },
    ] }),
    { label: '1 banana split', grams: 490 },
  );
  assert.equal(defaultServing({ foodPortions: [{ amount: 0.5, modifier: 'cup From 19191', gramWeight: 147, measureUnit: { name: 'undetermined' } }] }).label, '0.5 cup');
  assert.deepEqual(defaultServing({}), { label: '100 g', grams: 100 });
});

test('toRow scales nutrients to the default serving', () => {
  const row = toRow({
    fdcId: 169640,
    description: 'Honey',
    foodNutrients: nutrients({ 1008: 304, 1005: 82.4, 2000: 82.1, 1093: 4 }),
    foodPortions: [{ amount: 1, modifier: 'tbsp', gramWeight: 21, measureUnit: { name: 'undetermined' } }],
  });
  assert.deepEqual(row, [169640, 'Honey', '1 tbsp (21 g)', 64, 0, 17.3, 0, 0, 17.2, 1]);
});

test('names lose USDA program notes; duplicates keep the earlier dataset', () => {
  assert.equal(cleanName("Apples, raw, gala (Includes foods for USDA's Food Distribution Program)"), 'Apples, raw, gala');
  const food = (fdcId, dataType, extra = {}) => ({ fdcId, dataType, description: 'Egg, raw', foodNutrients: nutrients({ 1008: 1, ...extra }) });
  // Equally complete: the earlier dataset wins.
  assert.equal(buildRows([food(3, 'Survey (FNDDS)'), food(1, 'Foundation'), food(2, 'SR Legacy')])[0][0], 1);
  // A more complete record beats a sparse Foundation one.
  const rows = buildRows([food(1, 'Foundation'), food(2, 'SR Legacy', { 1003: 6, 1004: 5, 1079: 0 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 2);
});

test('negative USDA values are clamped to 0; sub-gram servings keep a decimal', () => {
  assert.equal(per100g({ foodNutrients: nutrients({ 1008: 300, 1005: -0.7 }) }).carbs, 0);
  const spray = toRow({
    fdcId: 9,
    description: 'Oil, spray',
    foodNutrients: nutrients({ 1008: 800 }),
    foodPortions: [{ amount: 1, modifier: 'spray , about 1/3 second', gramWeight: 0.25, measureUnit: { name: 'undetermined' } }],
  });
  assert.equal(spray[2], '1 spray, about 1/3 second (0.3 g)');
});

test('poor default portions are skipped when a better one exists', () => {
  const milk = { foodPortions: [
    { amount: 1, modifier: 'Guideline amount per cup of hot cereal', gramWeight: 61, measureUnit: { name: 'undetermined' } },
    { amount: 1, modifier: 'cup', gramWeight: 244, measureUnit: { name: 'undetermined' } },
  ] };
  assert.equal(defaultServing(milk).label, '1 cup');
  const onlyFlOz = { foodPortions: [{ portionDescription: '1 fl oz', gramWeight: 30 }] };
  assert.equal(defaultServing(onlyFlOz).label, '1 fl oz'); // nothing better: still used
});

test('round: no float artifacts', () => {
  assert.equal(round(0.1 + 0.2, 1), 0.3);
  assert.equal(round(63.84), 64);
});

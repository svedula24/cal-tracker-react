// Between the app's data and the sync wire format (src/lib/sync/mapping.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultServing, editedPer100g, entryGrams, foodOfEntry, G, OZ, scale, times, withValue } from '../src/lib/measure.ts';
import { sum } from '../src/lib/nutrition.ts';
import { isFood } from '../src/lib/savedFoods.ts';
import {
  dayLogToRow,
  entryToLog,
  fdcIdOf,
  fromValues,
  goalsToRow,
  keyOf,
  logToEntry,
  rowToDayLog,
  rowToGoals,
  rowToSavedId,
  savedToRow,
  tombstone,
  toValues,
} from '../src/lib/sync/mapping.ts';

const ID = '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a01';
const AT = '2026-11-10T19:12:00.000Z';
const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];

// USDA "Banana, raw" per 100 g; its portions, default first.
const banana = {
  id: 'usda:2709224',
  name: 'Banana, raw',
  per100g: { calories: 97, protein: 0.74, carbs: 22.7, fat: 0.28, fiber: 1.7, sugar: 15.8, sodium: 0 },
  portions: [
    { label: '1 banana', grams: 126 },
    { label: '1 slice', grams: 6 },
  ],
};
const bananaValues = { calories: 97, protein_g: 0.74, carbs_g: 22.7, fat_g: 0.28, fiber_g: 1.7, sugar_g: 15.8, sodium_mg: 0 };

// The entries the app makes, built the way it makes them (newEntry in src/lib/data.ts and `done`
// in src/app/nutrition.tsx; data.ts itself cannot be imported by Node).
/** A food logged in grams from Food Database or the bundled list. */
const logged = (food, grams, patch = {}) => ({
  id: ID,
  date: '2026-11-10',
  time: AT,
  name: food.name,
  servings: grams,
  nutrients: scale(food.per100g, 1),
  per100g: food.per100g,
  portions: food.portions,
  measure: G,
  foodId: food.id,
  foodName: food.name,
  ...patch,
});
/** The same, after `shown` was typed over one nutrient while the screen showed `grams`. */
const typedOver = (food, grams, key, shown) => {
  const perUnit = withValue(scale(food.per100g, 1), key, shown, grams);
  return logged(food, grams, { nutrients: perUnit, per100g: editedPer100g(food.per100g, perUnit, [key]), foodPer100g: food.per100g });
};
/** A hand-written entry: a serving and its nutrients, no food. */
const handWritten = (patch = {}) => ({
  id: ID,
  date: '2026-11-10',
  time: AT,
  name: 'Sandwich',
  servings: 1.5,
  nutrients: { calories: 725, protein: 40, carbs: 75, fat: 29, fiber: 4, sugar: 6, sodium: 1650 },
  seed: false,
  ...patch,
});

/** A row as the server returns it. */
const fromServer = (row, patch = {}) => ({ ...row, updated_at: AT, deleted_at: null, ...patch });
const totals = (e) => times(e.nutrients, e.servings);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const sameTotals = (a, b) => {
  for (const k of NUTRIENTS) close(totals(a)[k], totals(b)[k], k);
};
/** What Home shows: the totals rounded to whole numbers. */
const sameOnHome = (a, b) => assert.deepEqual(sum([a]), sum([b]));
/** What "the same entry" means after a round trip: totals, grams, name, the database food, how it reopens. */
const sameEntry = (back, entry) => {
  sameTotals(back, entry);
  assert.equal(back.id, entry.id);
  assert.equal(back.date, entry.date);
  assert.equal(back.time, entry.time);
  assert.equal(back.name, entry.name);
  assert.equal(back.seed, false);
  const food = foodOfEntry(entry);
  assert.deepEqual(foodOfEntry(back), food);
  if (food) {
    close(entryGrams(back, foodOfEntry(back)), entryGrams(entry, food), 'grams');
    // Nutrition reads the entry's own per-100 g values when it reopens.
    for (const k of NUTRIENTS) close(back.per100g[k], entry.per100g[k], `per100g.${k}`);
    assert.equal(back.foodPer100g === undefined, entry.foodPer100g === undefined);
  } else {
    assert.equal(back.servings, entry.servings);
    assert.deepEqual(back.nutrients, entry.nutrients);
  }
};
const roundTrip = (entry) => logToEntry(fromServer(entryToLog(entry)), entry);

test('nutrients: the wire names; NULL is 0 in the app', () => {
  assert.deepEqual(toValues(banana.per100g), bananaValues);
  assert.deepEqual(fromValues(bananaValues), banana.per100g);
  assert.deepEqual(fromValues({ ...bananaValues, fiber_g: null, sugar_g: null, sodium_mg: null }), { ...banana.per100g, fiber: 0, sugar: 0, sodium: 0 });
  assert.deepEqual(Object.keys(fromValues(bananaValues)), NUTRIENTS);
});

test('fdcIdOf: only `usda:<n>`', () => {
  assert.equal(fdcIdOf('usda:2709224'), 2709224);
  for (const id of ['', 'usda:', 'usda:abc', 'usda:12.5', 'usda:-3', 'USDA:1', 'custom:1', '2709224', 'usda:1 ', `custom:${ID}`, 'usda:99999999999999999999']) {
    assert.equal(fdcIdOf(id), null, id);
  }
});

test('entryToLog: a food logged in grams', () => {
  assert.deepEqual(entryToLog(logged(banana, 150)), {
    id: ID,
    fdc_id: 2709224,
    log_date: '2026-11-10',
    logged_at: AT,
    name: 'Banana, raw',
    food_name: 'Banana, raw',
    unit: 'g',
    quantity: 150,
    values: bananaValues,
    food_values: bananaValues,
  });
});

test('entryToLog: typed-over values are the entry’s; the food’s own stay beside them', () => {
  // 150 g shows 145.5 kcal; the user types 200.
  const row = entryToLog(typedOver(banana, 150, 'calories', 200));
  close(row.values.calories, 200 / 1.5, 'per 100 g');
  assert.deepEqual({ ...row.values, calories: 97 }, bananaValues); // the others are untouched
  assert.deepEqual(row.food_values, bananaValues);
  assert.equal(row.quantity, 150);
  // 0 is a value.
  assert.equal(entryToLog(typedOver(banana, 150, 'sugar', 0)).values.sugar_g, 0);
});

test('entryToLog: a renamed entry keeps the database name', () => {
  const row = entryToLog(logged(banana, 80, { name: 'Morning banana' }));
  assert.equal(row.name, 'Morning banana');
  assert.equal(row.food_name, 'Banana, raw');
  // An older entry without `foodName` has only its name to give.
  assert.equal(entryToLog(logged(banana, 80, { foodName: undefined })).food_name, 'Banana, raw');
});

test('entryToLog: an older entry measured by a portion is sent in grams', () => {
  const entry = logged(banana, 1.5, { measure: banana.portions[0], nutrients: scale(banana.per100g, 126) });
  const row = entryToLog(entry);
  assert.equal(row.unit, 'g');
  assert.equal(row.quantity, 189);
  assert.deepEqual(row.values, bananaValues);
  // …and one without a measure by the food's default serving, as Nutrition reads it.
  assert.equal(entryToLog({ ...entry, measure: undefined }).quantity, defaultServing(banana).grams * 1.5);
});

test('entryToLog: a hand-written entry is a custom log in servings', () => {
  assert.deepEqual(entryToLog(handWritten()), {
    id: ID,
    fdc_id: null,
    log_date: '2026-11-10',
    logged_at: AT,
    name: 'Sandwich',
    food_name: null,
    unit: 'serving',
    quantity: 1.5,
    values: { calories: 725, protein_g: 40, carbs_g: 75, fat_g: 29, fiber_g: 4, sugar_g: 6, sodium_mg: 1650 },
    food_values: null,
  });
  // No food behind it (no portions, or no food id): the same, whatever else it carries.
  const row = entryToLog(logged(banana, 2, { foodId: undefined }));
  assert.equal(row.unit, 'serving');
  assert.equal(row.fdc_id, null);
  assert.equal(row.quantity, 2);
  assert.deepEqual(row.values, toValues(scale(banana.per100g, 1)));
});

test('entryToLog: a food whose id is not `usda:<n>` is a custom log in grams', () => {
  const row = entryToLog(logged({ ...banana, id: 'my-banana' }, 150));
  assert.deepEqual(row, { id: ID, fdc_id: null, log_date: '2026-11-10', logged_at: AT, name: 'Banana, raw', food_name: null, unit: 'g', quantity: 150, values: bananaValues, food_values: null });
});

test('entryToLog: a demo entry and an id that is not a UUID are never sent', () => {
  assert.equal(entryToLog(logged(banana, 150, { seed: true })), null);
  assert.equal(entryToLog(handWritten({ seed: true })), null);
  for (const id of ['', 'e1', '1762801920000-3', 'not-a-uuid', `${ID}x`]) {
    assert.equal(entryToLog(logged(banana, 150, { id })), null, id);
    assert.equal(entryToLog(handWritten({ id })), null, id);
  }
  // `seed` false or absent (an entry the user logged) is sent.
  assert.notEqual(entryToLog(logged(banana, 150, { seed: false })), null);
  assert.notEqual(entryToLog(logged(banana, 150)), null);
});

test('entryToLog: a number JSON cannot carry is not sent', () => {
  assert.equal(entryToLog(handWritten({ servings: NaN })), null);
  assert.equal(entryToLog(handWritten({ nutrients: { ...handWritten().nutrients, fat: Infinity } })), null);
  assert.equal(entryToLog(logged(banana, 150, { per100g: { ...banana.per100g, sugar: NaN } })), null);
  assert.equal(entryToLog(logged(banana, 150, { foodPer100g: { ...banana.per100g, sugar: NaN } })), null);
});

test('logToEntry: a log in grams is an entry measured in grams with its database food', () => {
  const log = fromServer({ id: ID, fdc_id: 2709224, log_date: '2026-11-10', logged_at: AT, name: 'Banana, raw', food_name: 'Banana, raw', unit: 'g', quantity: 150, values: bananaValues, food_values: bananaValues });
  const entry = logToEntry(log);
  assert.deepEqual(entry, {
    id: ID,
    date: '2026-11-10',
    time: AT,
    name: 'Banana, raw',
    servings: 150,
    nutrients: scale(banana.per100g, 1),
    per100g: banana.per100g,
    portions: [],
    measure: G,
    foodId: 'usda:2709224',
    foodName: 'Banana, raw',
    seed: false,
  });
  // Without portions it is still a food Nutrition can open (served by 100 g) and a bookmark can save.
  const food = foodOfEntry(entry);
  assert.deepEqual(food, { ...banana, portions: [] });
  assert.ok(isFood(food));
  assert.equal(entryGrams(entry, food), 150);
  close(totals(entry).calories, 145.5, 'calories');
});

test('logToEntry: an entry this device measures in ounces or a portion keeps that unit; the amount is the server’s', () => {
  const at = (grams) => fromServer({ id: ID, fdc_id: 2709224, log_date: '2026-11-10', logged_at: AT, name: 'Banana, raw', food_name: 'Banana, raw', unit: 'g', quantity: grams, values: bananaValues, food_values: bananaValues });
  // Its own row coming back (252 g = 2 bananas): unchanged, still 2 × "1 banana".
  const twoBananas = logged(banana, 2, { measure: banana.portions[0], nutrients: scale(banana.per100g, 126) });
  const back = logToEntry(at(252), twoBananas);
  assert.deepEqual(back.measure, banana.portions[0]);
  close(back.servings, 2, 'servings');
  close(totals(back).calories, totals(twoBananas).calories, 'calories');
  close(entryGrams(back, foodOfEntry(back)), 252, 'grams');
  // Changed on the server (another client set 189 g): still in bananas, now 1.5 of them.
  const changed = logToEntry(at(189), twoBananas);
  close(changed.servings, 1.5, 'servings after a server edit');
  close(totals(changed).calories, banana.per100g.calories * 1.89, 'calories after a server edit');
  // Ounces, matched by value, so the OZ constant comes back.
  const inOunces = logged(banana, 4, { measure: { ...OZ }, nutrients: scale(banana.per100g, OZ.grams) });
  const ounces = logToEntry(at(4 * OZ.grams), inOunces);
  assert.equal(ounces.measure, OZ);
  close(ounces.servings, 4, 'ounces');
  // A copy here of another food, or none: grams, as before.
  assert.equal(logToEntry(at(252)).measure, G);
  assert.equal(logToEntry(at(252), logged({ ...banana, id: 'usda:1' }, 2, { measure: banana.portions[0] })).measure, G);
});

test('logToEntry: NULL nutrients are 0, in the entry’s values and the food’s', () => {
  const nulls = { ...bananaValues, fiber_g: null, sugar_g: null, sodium_mg: null };
  const log = fromServer({ id: ID, fdc_id: 2709224, log_date: '2026-11-10', logged_at: AT, name: 'Banana', food_name: 'Banana, raw', unit: 'g', quantity: 100, values: nulls, food_values: nulls });
  const entry = logToEntry(log);
  assert.deepEqual(entry.per100g, { ...banana.per100g, fiber: 0, sugar: 0, sodium: 0 });
  assert.deepEqual([entry.nutrients.fiber, entry.nutrients.sugar, entry.nutrients.sodium], [0, 0, 0]);
  assert.equal(entry.foodPer100g, undefined);
  // The server stores NULL where the app sent 0 and the database reports nothing: still not "typed over".
  assert.equal(logToEntry({ ...log, values: { ...nulls, sodium_mg: 0 } }).foodPer100g, undefined);
  // A serving log too.
  const custom = logToEntry({ ...log, fdc_id: null, food_name: null, unit: 'serving', quantity: 1, food_values: null });
  assert.deepEqual(custom.nutrients, { ...banana.per100g, fiber: 0, sugar: 0, sodium: 0 });
  assert.ok(Object.values(sum([entry, custom])).every(Number.isFinite));
});

test('logToEntry: `foodPer100g` only when the food’s values differ from the entry’s', () => {
  const log = fromServer({ id: ID, fdc_id: 2709224, log_date: '2026-11-10', logged_at: AT, name: 'Banana', food_name: 'Banana, raw', unit: 'g', quantity: 100, values: { ...bananaValues, calories: 120 }, food_values: bananaValues });
  const entry = logToEntry(log);
  assert.equal(entry.per100g.calories, 120);
  assert.deepEqual(entry.foodPer100g, banana.per100g);
  assert.deepEqual(foodOfEntry(entry).per100g, banana.per100g);
  assert.equal(foodOfEntry(entry).name, 'Banana, raw');
  // A log with a food but no food_values or food_name (not expected): the entry's own stand in.
  const bare = logToEntry({ ...log, food_values: null, food_name: null });
  assert.equal(bare.foodPer100g, undefined);
  assert.equal(bare.foodName, 'Banana');
  assert.ok(isFood(foodOfEntry(bare)));
});

test('logToEntry: portions and the photo come from this device’s copy', () => {
  const log = fromServer(entryToLog(logged(banana, 150)), { quantity: 80, name: 'Half a banana' });
  const existing = logged(banana, 150, { photo: 'file:///banana.jpg', seed: false });
  const entry = logToEntry(log, existing);
  assert.deepEqual(entry.portions, banana.portions);
  assert.equal(entry.photo, 'file:///banana.jpg');
  assert.equal(entry.servings, 80);
  assert.equal(entry.name, 'Half a banana');
  assert.equal('photo' in logToEntry(log), false);
  // Portions belong to a food: a copy that holds a different food does not lend its own.
  assert.deepEqual(logToEntry(log, logged({ ...banana, id: 'usda:1' }, 150)).portions, []);
  assert.deepEqual(logToEntry(log, handWritten()).portions, []);
  assert.equal(logToEntry(fromServer(entryToLog(handWritten())), handWritten({ photo: 'file:///s.jpg' })).photo, 'file:///s.jpg');
});

test('logToEntry: the result is never a demo entry', () => {
  const log = fromServer(entryToLog(logged(banana, 150)));
  assert.equal(logToEntry(log, logged(banana, 150, { seed: true })).seed, false);
  assert.equal(logToEntry(fromServer(entryToLog(handWritten())), handWritten({ seed: true })).seed, false);
});

test('logToEntry: the time is in the app’s own format, whatever the server sends', () => {
  const log = fromServer(entryToLog(logged(banana, 150)));
  for (const sent of ['2026-11-10T19:12:00Z', '2026-11-10T19:12:00+00:00', '2026-11-10T14:12:00-05:00', '2026-11-10T19:12:00.000000Z', AT]) {
    assert.equal(logToEntry({ ...log, logged_at: sent }).time, AT, sent);
  }
  // The day is the log's own date, never derived from the time.
  assert.equal(logToEntry({ ...log, log_date: '2026-11-09', logged_at: '2026-11-10T04:30:00Z' }).date, '2026-11-09');
});

test('logToEntry: a log in servings is a hand-written entry', () => {
  const log = fromServer(entryToLog(handWritten()));
  const entry = logToEntry(log);
  assert.deepEqual(entry, { id: ID, date: '2026-11-10', time: AT, name: 'Sandwich', servings: 1.5, nutrients: handWritten().nutrients, seed: false });
  assert.equal(foodOfEntry(entry), null);
  // A measure label on this device's copy is kept; one that belonged to a food in grams is not.
  assert.deepEqual(logToEntry(log, handWritten({ measure: { label: '1 sandwich', grams: 250 } })).measure, { label: '1 sandwich', grams: 250 });
  assert.equal('measure' in logToEntry(log, logged(banana, 150)), false);
});

test('a custom log in grams (a food the server did not know) opens in grams with the same totals', () => {
  // What the server stores for a log whose fdc_id it does not have: no food, the rest kept.
  const sent = entryToLog(typedOver(banana, 150, 'calories', 200));
  const log = fromServer({ ...sent, name: 'Mystery fruit', fdc_id: null, food_name: null, food_values: null });

  // On a device that never had the entry: a food of the log's own.
  const entry = logToEntry(log);
  const food = foodOfEntry(entry);
  assert.ok(isFood(food));
  assert.deepEqual(food, { id: `custom:${ID}`, name: 'Mystery fruit', per100g: entry.per100g, portions: [] });
  assert.deepEqual(entry.measure, G);
  assert.equal(entryGrams(entry, food), 150);
  assert.equal(entry.foodPer100g, undefined);
  close(totals(entry).calories, 200, 'calories');
  sameTotals(entry, typedOver(banana, 150, 'calories', 200));
  // It goes back as the same log, and is stable from then on.
  assert.deepEqual(fromServer(entryToLog(entry)), log);
  assert.deepEqual(logToEntry(fromServer(entryToLog(entry)), entry), entry);
  // Renamed on the device: the name goes up; the food keeps its own.
  const renamed = { ...entry, name: 'Dragon fruit' };
  assert.equal(entryToLog(renamed).name, 'Dragon fruit');
  assert.equal(foodOfEntry(logToEntry(fromServer(entryToLog(renamed)), renamed)).name, 'Mystery fruit');

  // On the device that logged it: the food it already has is kept, so it is sent with its fdc_id again.
  const mine = typedOver(banana, 150, 'calories', 200);
  const back = logToEntry(fromServer({ ...sent, fdc_id: null, food_name: null, food_values: null }), mine);
  sameEntry(back, mine);
  assert.deepEqual(back.foodPer100g, banana.per100g);
  assert.deepEqual(entryToLog(back), sent);
});

test('round trip: a plain food entry', () => {
  const entry = logged(banana, 150);
  sameEntry(roundTrip(entry), entry);
  sameOnHome(roundTrip(entry), entry);
  assert.deepEqual(roundTrip(entry), { ...entry, seed: false });
  // On another device (no copy): the same, except that the food has no portions.
  const other = logToEntry(fromServer(entryToLog(entry)));
  sameTotals(other, entry);
  assert.deepEqual(foodOfEntry(other), { ...banana, portions: [] });
  assert.equal(entryGrams(other, foodOfEntry(other)), 150);
});

test('round trip: an entry with typed-over values', () => {
  for (const [key, shown] of [['calories', 200], ['protein', 3], ['sugar', 0], ['sodium', 12.5]]) {
    const entry = typedOver(banana, 150, key, shown);
    const back = roundTrip(entry);
    sameEntry(back, entry);
    close(totals(back)[key], shown, key); // what was typed is what the day counts
    // Home rounds the totals. Coming back, a typed value is per 100 g ÷ 100 again (as when the
    // entry is reopened and Done pressed), which can differ in the last bit: only a total typed
    // exactly on a half (12.5) can then round the other way.
    if (shown % 1 !== 0.5) sameOnHome(back, entry);
    assert.deepEqual(back.foodPer100g, banana.per100g);
    assert.deepEqual(foodOfEntry(back), banana); // a bookmark still saves the database food
  }
  // An amount where per-gram × 100 is not exact.
  const odd = typedOver(banana, 37, 'calories', 41);
  sameEntry(roundTrip(odd), odd);
});

test('round trip: a renamed entry', () => {
  const entry = logged(banana, 80, { name: 'Morning banana' });
  const back = roundTrip(entry);
  sameEntry(back, entry);
  sameOnHome(back, entry);
  assert.equal(back.name, 'Morning banana');
  assert.equal(back.foodName, 'Banana, raw');
  assert.equal(foodOfEntry(back).name, 'Banana, raw');
});

test('round trip: an entry logged from the bundled list (no `foodPer100g`)', () => {
  // A food without portions and with nutrients USDA does not report (0 in the app).
  const oil = { id: 'usda:171413', name: 'Oil, olive', per100g: { calories: 884, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodium: 2 }, portions: [] };
  const entry = logged(oil, 14);
  const back = roundTrip(entry);
  sameEntry(back, entry);
  sameOnHome(back, entry);
  assert.equal('foodPer100g' in back, false);
  // The server keeps NULL where the food reports nothing and the app sent 0.
  const stored = fromServer(entryToLog(entry));
  const withNulls = { ...stored, values: { ...stored.values, fiber_g: null, sugar_g: null }, food_values: { ...stored.food_values, fiber_g: null, sugar_g: null } };
  sameEntry(logToEntry(withNulls, entry), entry);
  assert.equal('foodPer100g' in logToEntry(withNulls, entry), false);
});

test('round trip: an entry measured by a portion comes back in that portion, the same amount', () => {
  const entry = logged(banana, 1.5, { measure: banana.portions[0], nutrients: scale(banana.per100g, 126) });
  const back = roundTrip(entry);
  sameEntry(back, entry);
  sameOnHome(back, entry);
  assert.deepEqual(back.measure, banana.portions[0]);
  close(back.servings, 1.5, 'servings');
  // On a device that does not have the entry, the server's grams are all there is.
  assert.deepEqual(logToEntry(entryToLog(entry)).measure, G);
  assert.equal(logToEntry(entryToLog(entry)).servings, 189);
});

test('round trip: a hand-written entry', () => {
  const entry = handWritten();
  const back = roundTrip(entry);
  sameEntry(back, entry);
  assert.deepEqual(back, entry);
});

test('round trip from the server: log → entry → log', () => {
  const nulls = { ...bananaValues, fiber_g: null };
  const logs = [
    { id: ID, fdc_id: 2709224, log_date: '2026-11-09', logged_at: AT, name: 'Banana', food_name: 'Banana, raw', unit: 'g', quantity: 126, values: bananaValues, food_values: bananaValues },
    { id: ID, fdc_id: 2709224, log_date: '2026-11-10', logged_at: AT, name: 'Banana, raw', food_name: 'Banana, raw', unit: 'g', quantity: 33.3, values: { ...bananaValues, calories: 120.5 }, food_values: bananaValues },
    { id: ID, fdc_id: null, log_date: '2026-11-10', logged_at: AT, name: 'Sandwich', food_name: null, unit: 'serving', quantity: 2, values: bananaValues, food_values: null },
    { id: ID, fdc_id: null, log_date: '2026-11-10', logged_at: AT, name: 'Mystery fruit', food_name: null, unit: 'g', quantity: 150, values: bananaValues, food_values: null },
  ];
  for (const row of logs) {
    assert.deepEqual(entryToLog(logToEntry(fromServer(row))), row, row.name);
    // After a deletion elsewhere and a restore, or a later pull onto the entry it made.
    assert.deepEqual(entryToLog(logToEntry(fromServer(row), logToEntry(fromServer(row)))), row, row.name);
  }
  // NULL comes back as 0 (the app cannot tell them apart; the server restores NULL for a known food).
  const row = { ...logs[0], values: nulls, food_values: nulls };
  assert.deepEqual(entryToLog(logToEntry(fromServer(row))), { ...row, values: { ...nulls, fiber_g: 0 }, food_values: { ...nulls, fiber_g: 0 } });
  // A time in another format goes back as the same instant.
  const back = entryToLog(logToEntry(fromServer({ ...logs[0], logged_at: '2026-11-10T14:12:00-05:00' })));
  assert.equal(Date.parse(back.logged_at), Date.parse(AT));
});

test('saved foods: `usda:<n>` ↔ fdc_id; anything else is not synced', () => {
  assert.deepEqual(savedToRow({ id: banana.id, food: banana }, AT), { fdc_id: 2709224, saved_at: AT });
  assert.equal(savedToRow({ id: 'my-banana', food: { ...banana, id: 'my-banana' } }, AT), null);
  assert.equal(savedToRow({ id: `custom:${ID}`, food: { ...banana, id: `custom:${ID}` } }, AT), null);
  assert.equal(rowToSavedId(fromServer({ fdc_id: 2709224, saved_at: AT })), 'usda:2709224');
  assert.equal(rowToSavedId(fromServer(savedToRow({ id: banana.id, food: banana }, AT))), banana.id);
});

test('goals: the seven targets, steps and the goal, from the date the caller gives', () => {
  const goals = { id: 'goals', calories: 3027, protein: 182, carbs: 433, fat: 94, fiber: 38, sugar: 113, sodium: 2300, steps: 10000, goal: 'gain' };
  const row = goalsToRow(goals, '2026-11-10');
  assert.deepEqual(row, { effective_date: '2026-11-10', calories: 3027, protein_g: 182, carbs_g: 433, fat_g: 94, fiber_g: 38, sugar_g: 113, sodium_mg: 2300, steps: 10000, goal: 'gain' });
  assert.deepEqual(rowToGoals(fromServer(row)), goals);
  assert.deepEqual(goalsToRow(rowToGoals(fromServer(row)), row.effective_date), row);
});

test('day logs: steps only; the rollover stays on the device', () => {
  const row = dayLogToRow({ id: '2026-11-10', steps: 5782, rollover: 200 });
  assert.deepEqual(row, { log_date: '2026-11-10', steps: 5782 });
  assert.deepEqual(rowToDayLog(fromServer(row), { id: '2026-11-10', steps: 100, rollover: 200 }), { id: '2026-11-10', steps: 5782, rollover: 200 });
  assert.deepEqual(rowToDayLog(fromServer(row)), { id: '2026-11-10', steps: 5782, rollover: 0 });
});

test('keyOf and tombstone: the key of every table, each the inverse of the other', () => {
  const rows = {
    food_logs: [entryToLog(logged(banana, 150)), ID],
    saved_foods: [savedToRow({ id: banana.id, food: banana }, AT), '2709224'],
    goals: [goalsToRow({ id: 'goals', calories: 1, protein: 1, carbs: 1, fat: 1, fiber: 1, sugar: 1, sodium: 1, steps: 1, goal: 'lose' }, '2026-11-01'), '2026-11-01'],
    daily_steps: [dayLogToRow({ id: '2026-11-10', steps: 1, rollover: 0 }), '2026-11-10'],
  };
  for (const [table, [row, key]] of Object.entries(rows)) {
    assert.equal(keyOf(table, row), key, table);
    assert.equal(keyOf(table, fromServer(row)), key, table);
    assert.equal(keyOf(table, tombstone(table, key)), key, table);
    assert.deepEqual(tombstone(table, keyOf(table, row)), tombstone(table, key), table);
  }
  assert.deepEqual(tombstone('food_logs', ID), { id: ID });
  assert.deepEqual(tombstone('saved_foods', '2709224'), { fdc_id: 2709224 }); // a number on the wire
  assert.deepEqual(tombstone('goals', '2026-11-01'), { effective_date: '2026-11-01' });
  assert.deepEqual(tombstone('daily_steps', '2026-11-10'), { log_date: '2026-11-10' });
});

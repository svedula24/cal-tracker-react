// Day targets, suggested goals, the goal in force on a date, and the upgrade of the old one-object
// goals (src/lib/nutrition.ts). The day-target and suggestion cases are shared with the server:
// shared/targets-fixtures.json (wire names, mapped to the app's here). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { dayTarget, FIRST_GOAL_DATE, goalOn, inSuggestLimit, migrateGoals, remaining, roundHalfAway, suggestInputValid, suggestTargets } from '../src/lib/nutrition.ts';

const fixtures = JSON.parse(fs.readFileSync(new URL('../shared/targets-fixtures.json', import.meta.url), 'utf8'));

// Wire name → app name.
const NUTRIENTS = { calories: 'calories', protein_g: 'protein', carbs_g: 'carbs', fat_g: 'fat', fiber_g: 'fiber', sugar_g: 'sugar', sodium_mg: 'sodium' };
const toApp = (wire) => Object.fromEntries(Object.entries(NUTRIENTS).map(([w, a]) => [a, wire[w]]));
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`);

test('the fixtures have cases', () => {
  assert.ok(fixtures.day_target.length > 0);
  assert.ok(fixtures.suggest.length > 0);
});

for (const c of fixtures.day_target) {
  test(`day target: ${c.name}`, () => {
    const goal = { ...toApp(c.goal), workoutKcal: c.goal.workout_kcal, activeRestKcal: c.goal.active_rest_kcal };
    const activity = c.activity && { steps: c.activity.steps, dayType: c.activity.day_type, workoutKcal: c.activity.workout_kcal };
    const target = dayTarget(goal, activity);
    const want = c.expected.target;
    for (const [w, a] of Object.entries(NUTRIENTS)) close(target[a], want[w], a);
    close(target.adjustment, want.adjustment_kcal, 'adjustment');
    if (c.totals) {
      const left = remaining(target, toApp(c.totals));
      for (const [w, a] of Object.entries(NUTRIENTS)) close(left[a], c.expected.remaining[w], `remaining ${a}`);
    }
  });
}

for (const c of fixtures.suggest) {
  test(`suggest: ${c.name}`, () => {
    const { sex, age, height_cm, weight_kg, goal } = c.input;
    assert.ok(suggestInputValid({ age, heightCm: height_cm, weightKg: weight_kg }), 'the fixture inputs are accepted');
    const got = suggestTargets({ sex, age, heightCm: height_cm, weightKg: weight_kg, goal });
    assert.deepEqual(got, { calories: c.expected.calories, protein: c.expected.protein_g, carbs: c.expected.carbs_g, fat: c.expected.fat_g });
  });
}

test('roundHalfAway: halves go away from zero on both sides', () => {
  assert.equal(roundHalfAway(2.5), 3);
  assert.equal(roundHalfAway(-2.5), -3);
  assert.equal(roundHalfAway(77.5), 78);
  assert.equal(roundHalfAway(-0.4), -0);
  assert.equal(roundHalfAway(1.49), 1);
});

test('suggest: carbs never go below 0', () => {
  const s = suggestTargets({ sex: 'female', age: 100, heightCm: 100, weightKg: 100, goal: 'lose' });
  assert.equal(s.carbs, 0);
});

test('suggest: inputs are accepted only for age 10-120, height 50-300 cm, weight 20-500 kg (inclusive)', () => {
  const ok = { age: 30, heightCm: 180, weightKg: 80 };
  assert.ok(suggestInputValid(ok));
  assert.ok(suggestInputValid({ age: 10, heightCm: 50, weightKg: 20 }));
  assert.ok(suggestInputValid({ age: 120, heightCm: 300, weightKg: 500 }));
  for (const [k, lo, hi] of [['age', 10, 120], ['heightCm', 50, 300], ['weightKg', 20, 500]]) {
    assert.equal(inSuggestLimit(k, lo - 0.01), false, `${k} below`);
    assert.equal(inSuggestLimit(k, hi + 0.01), false, `${k} above`);
    assert.equal(suggestInputValid({ ...ok, [k]: null }), false, `${k} missing`);
    assert.equal(suggestInputValid({ ...ok, [k]: hi + 1 }), false, `${k} out of range`);
  }
});

test('suggest: calories and fat never go below 0', () => {
  const s = suggestTargets({ sex: 'female', age: 120, heightCm: 50, weightKg: 20, goal: 'lose' });
  assert.ok(Object.is(s.calories, 0) && Object.is(s.fat, 0) && Object.is(s.carbs, 0), JSON.stringify(s));
});

// ── goalOn ───────────────────────────────────────────────────────────────────
const row = (date, calories) => ({
  id: date, effectiveDate: date, source: 'manual',
  calories, protein: 1, carbs: 1, fat: 1, fiber: 1, sugar: 1, sodium: 1, steps: 1, goal: 'maintain', workoutKcal: 0, activeRestKcal: 0,
});

test('goalOn: the row with the latest effective date on or before the day, in any order', () => {
  const rows = [row('2026-11-10', 3), row('2020-01-01', 1), row('2026-11-12', 4), row('2026-11-05', 2)];
  assert.equal(goalOn(rows, '2026-11-09').calories, 2);
  assert.equal(goalOn(rows, '2026-11-10').calories, 3, 'a row is in force on its own date');
  assert.equal(goalOn(rows, '2026-11-11').calories, 3, 'a future row does not count yet');
  assert.equal(goalOn(rows, '2026-11-30').calories, 4);
  assert.equal(goalOn(rows, '2021-06-01').calories, 1);
});

test('goalOn: null before the first row, or with no rows; a row without a date is ignored', () => {
  assert.equal(goalOn([row('2026-11-10', 3)], '2026-11-09'), null);
  assert.equal(goalOn([], '2026-11-09'), null);
  assert.equal(goalOn([{ ...row('2026-11-01', 9), effectiveDate: undefined }, row('2020-01-01', 1)], '2026-11-09').calories, 1);
});

// ── migrateGoals ─────────────────────────────────────────────────────────────
test('migrateGoals: the old one set of goals becomes the row in force since 2020-01-01', () => {
  const old = { id: 'goals', calories: 3027, protein: 182, carbs: 433, fat: 94, fiber: 38, sugar: 113, sodium: 2300, steps: 10000, goal: 'gain' };
  const [up, ...rest] = migrateGoals([old]);
  assert.equal(rest.length, 0);
  assert.equal(FIRST_GOAL_DATE, '2020-01-01');
  assert.deepEqual(up, { ...old, id: '2020-01-01', effectiveDate: '2020-01-01', source: 'manual', workoutKcal: 0, activeRestKcal: 0 });
  assert.equal(goalOn([up], '2026-11-10'), up);
});

test('migrateGoals: rows already dated come back as the same array', () => {
  const rows = [row('2020-01-01', 1), row('2026-11-10', 2)];
  assert.equal(migrateGoals(rows), rows);
  assert.deepEqual(migrateGoals([]), []);
});

test('migrateGoals: an old row next to a dated one of 2020-01-01: one row for the date, the later one', () => {
  const old = { id: 'goals', calories: 1, protein: 1, carbs: 1, fat: 1, fiber: 1, sugar: 1, sodium: 1, steps: 1, goal: 'gain' };
  const out = migrateGoals([old, row('2020-01-01', 7)]);
  assert.deepEqual(out.map((g) => [g.id, g.calories]), [['2020-01-01', 7]]);
});

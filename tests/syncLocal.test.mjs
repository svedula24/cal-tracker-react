// The adapter between the app's collections and the sync engine (src/lib/sync/local.ts), over
// fake stores. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { G, scale } from '../src/lib/measure.ts';
import { isSavedFood } from '../src/lib/savedFoods.ts';
import { createLocal, GOALS_SINCE } from '../src/lib/sync/local.ts';

const ID = '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a01';
const ID2 = '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a02';
const DEMO = '0b9d3f0e-6c1b-4f5e-9a55-2f0f3c1f7a03';
const AT = '2026-11-10T19:12:00.000Z';
const TODAY = '2026-11-10';

const banana = {
  id: 'usda:2709224',
  name: 'Banana, raw',
  per100g: { calories: 97, protein: 0.74, carbs: 22.7, fat: 0.28, fiber: 1.7, sugar: 15.8, sodium: 0 },
  portions: [{ label: '1 banana', grams: 126 }],
};
const bananaValues = { calories: 97, protein_g: 0.74, carbs_g: 22.7, fat_g: 0.28, fiber_g: 1.7, sugar_g: 15.8, sodium_mg: 0 };
const honey = { id: 'usda:169640', name: 'Honey', per100g: { calories: 304, protein: 0.3, carbs: 82.4, fat: 0, fiber: 0.2, sugar: 82.1, sodium: 4 }, portions: [] };

/** A food logged in grams, as the app makes it (newEntry + Nutrition's Done). */
const logged = (food, grams, patch = {}) => ({
  id: ID,
  date: TODAY,
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
const demoEntry = { id: DEMO, date: TODAY, time: AT, name: 'Sandwich', servings: 1, nutrients: { calories: 725, protein: 40, carbs: 75, fat: 29, fiber: 4, sugar: 6, sodium: 1650 }, seed: true };
const goals = { id: 'goals', calories: 3027, protein: 182, carbs: 433, fat: 94, fiber: 38, sugar: 113, sodium: 2300, steps: 10000, goal: 'gain' };
const goalRow = (date, patch = {}) => ({
  effective_date: date,
  calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 70, fiber_g: 30, sugar_g: 50, sodium_mg: 2000, steps: 8000, goal: 'lose',
  updated_at: AT,
  deleted_at: null,
  ...patch,
});
const logRow = (patch = {}) => ({
  id: ID,
  fdc_id: 2709224,
  log_date: TODAY,
  logged_at: AT,
  name: 'Banana, raw',
  food_name: 'Banana, raw',
  unit: 'g',
  quantity: 150,
  values: bananaValues,
  food_values: bananaValues,
  updated_at: AT,
  deleted_at: null,
  ...patch,
});
const gone = (key) => ({ ...key, updated_at: AT, deleted_at: AT });
const none = () => ({ food_logs: [], saved_foods: [], goals: [], daily_steps: [] });

/** A store with the Collection methods the adapter uses; `writes` counts them. */
const fakeStore = (items = []) => {
  const s = {
    items: [...items],
    writes: 0,
    put(item) {
      s.writes++;
      s.items = s.items.some((i) => i.id === item.id) ? s.items.map((i) => (i.id === item.id ? item : i)) : [...s.items, item];
    },
    remove(id) {
      s.writes++;
      s.items = s.items.filter((i) => i.id !== id);
    },
  };
  return s;
};

function setup({ entries = [], saved = [], goalItems = [goals], dayLogs = [], foods = [banana, honey], findFood } = {}) {
  const t = {
    entries: fakeStore(entries),
    saved: fakeStore(saved),
    goals: fakeStore(goalItems),
    dayLogs: fakeStore(dayLogs),
    lookups: [],
  };
  t.local = createLocal({
    entries: t.entries,
    saved: t.saved,
    goals: t.goals,
    dayLogs: t.dayLogs,
    findFood:
      findFood ??
      (async (id) => {
        t.lookups.push(id);
        return foods.find((f) => f.id === id) ?? null;
      }),
    today: () => TODAY,
  });
  t.writes = () => t.entries.writes + t.saved.writes + t.goals.writes + t.dayLogs.writes;
  return t;
}
// Lets the bookmark lookups (promises) finish.
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// ── read ─────────────────────────────────────────────────────────────────────
test('read food_logs: the entry as a log; null for a demo entry, a non-UUID id, a missing entry', () => {
  const t = setup({ entries: [logged(banana, 150), demoEntry, logged(banana, 50, { id: 'e1' })] });
  assert.deepEqual(t.local.read('food_logs', ID), {
    id: ID,
    log_date: TODAY,
    logged_at: AT,
    name: 'Banana, raw',
    fdc_id: 2709224,
    food_name: 'Banana, raw',
    unit: 'g',
    quantity: 150,
    values: bananaValues,
    food_values: bananaValues,
  });
  assert.equal(t.local.read('food_logs', DEMO), null);
  assert.equal(t.local.read('food_logs', 'e1'), null);
  assert.equal(t.local.read('food_logs', ID2), null);
});

test('read saved_foods: keyed by the fdc id as text, with the time it was saved', () => {
  const t = setup({ saved: [{ id: banana.id, food: banana, savedAt: '2026-11-09T08:00:00.000Z' }] });
  assert.deepEqual(t.local.read('saved_foods', '2709224'), { fdc_id: 2709224, saved_at: '2026-11-09T08:00:00.000Z' });
  assert.equal(t.local.read('saved_foods', '169640'), null, 'not saved');
  assert.equal(t.local.read('saved_foods', 'usda:2709224'), null, 'the key is the number, not the saved id');
});

test('read saved_foods: an older bookmark without savedAt gets one fixed time, the same on every push', () => {
  const t = setup({ saved: [{ id: banana.id, food: banana }, { id: honey.id, food: honey, savedAt: 'not a time' }] });
  const first = t.local.read('saved_foods', '2709224');
  assert.deepEqual(first, { fdc_id: 2709224, saved_at: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual(t.local.read('saved_foods', '2709224'), first);
  assert.deepEqual(t.local.read('saved_foods', '169640'), { fdc_id: 169640, saved_at: '2020-01-01T00:00:00.000Z' });
});

test('read goals: the one set of goals as the row in force since GOALS_SINCE', () => {
  assert.equal(GOALS_SINCE, '2020-01-01');
  const t = setup();
  assert.deepEqual(t.local.read('goals', GOALS_SINCE), {
    effective_date: '2020-01-01',
    calories: 3027, protein_g: 182, carbs_g: 433, fat_g: 94, fiber_g: 38, sugar_g: 113, sodium_mg: 2300, steps: 10000, goal: 'gain',
  });
  assert.equal(t.local.read('goals', '2026-11-10'), null, 'no other goal row exists on the phone');
  assert.equal(setup({ goalItems: [] }).local.read('goals', GOALS_SINCE), null);
});

test('read daily_steps: the day and its steps; the rollover stays on the phone', () => {
  const t = setup({ dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }] });
  assert.deepEqual(t.local.read('daily_steps', TODAY), { log_date: TODAY, steps: 5782 });
  assert.equal(t.local.read('daily_steps', '2026-11-09'), null);
});

test('read: an unknown table is null, not a throw', () => {
  assert.equal(setup().local.read('nope', 'x'), null);
});

// ── all ──────────────────────────────────────────────────────────────────────
test('all: every sendable entry, every usda bookmark, the goals row, every day log; never a demo entry', () => {
  const t = setup({
    entries: [demoEntry, logged(banana, 150), logged(banana, 50, { id: 'e1' }), logged(honey, 20, { id: ID2 })],
    saved: [{ id: banana.id, food: banana }, { id: 'custom:x', food: { ...banana, id: 'custom:x' } }],
    dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }, { id: '2026-11-09', steps: 4950, rollover: 0 }],
  });
  assert.deepEqual(t.local.all(), [
    { table: 'food_logs', key: ID },
    { table: 'food_logs', key: ID2 },
    { table: 'saved_foods', key: '2709224' },
    { table: 'goals', key: '2020-01-01' },
    { table: 'daily_steps', key: TODAY },
    { table: 'daily_steps', key: '2026-11-09' },
  ]);
});

test('all: every key it lists can be read, and a pulled row maps back to the same key', () => {
  const t = setup({
    entries: [demoEntry, logged(banana, 150)],
    saved: [{ id: banana.id, food: banana }],
    dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }],
  });
  const keys = t.local.all();
  assert.equal(keys.length, 4);
  for (const { table, key } of keys) {
    const row = t.local.read(table, key);
    assert.ok(row, `${table}:${key}`);
    assert.equal(t.local.keyOf(table, row), key);
    assert.equal(t.local.keyOf(table, t.local.tombstone(table, key)), key);
  }
});

test('all: nothing but the goals row on an empty phone; no goals row without goals', () => {
  assert.deepEqual(setup().local.all(), [{ table: 'goals', key: GOALS_SINCE }]);
  assert.deepEqual(setup({ goalItems: [] }).local.all(), []);
});

test('tombstone: the key fields the server expects', () => {
  const { local } = setup();
  assert.deepEqual(local.tombstone('food_logs', ID), { id: ID });
  assert.deepEqual(local.tombstone('saved_foods', '2709224'), { fdc_id: 2709224 });
  assert.deepEqual(local.tombstone('goals', GOALS_SINCE), { effective_date: GOALS_SINCE });
  assert.deepEqual(local.tombstone('daily_steps', TODAY), { log_date: TODAY });
});

// ── apply: food_logs ─────────────────────────────────────────────────────────
test('apply: a pulled log for an entry the phone does not have is added, in grams, not as a demo entry', () => {
  const t = setup({ entries: [demoEntry] });
  t.local.apply({ ...none(), food_logs: [logRow({ logged_at: '2026-11-10T20:12:00+01:00' })] });
  assert.equal(t.entries.items.length, 2);
  const e = t.entries.items[1];
  assert.equal(e.id, ID);
  assert.equal(e.seed, false);
  assert.equal(e.servings, 150);
  assert.equal(e.foodId, 'usda:2709224');
  assert.equal(e.time, AT, 'the time is in the one format Home sorts as text');
  assert.deepEqual(t.local.read('food_logs', ID).quantity, 150, 'and it reads back as the same log');
});

test('apply: a pulled log REPLACES the local entry, keeping what only the phone has (portions, photo)', () => {
  const mine = logged(banana, 150, { photo: 'file:///photo.jpg', name: 'My banana' });
  const t = setup({ entries: [mine] });
  t.local.apply({ ...none(), food_logs: [logRow({ quantity: 200, name: 'Renamed' })] });
  const e = t.entries.items[0];
  assert.equal(t.entries.items.length, 1);
  assert.equal(e.servings, 200);
  assert.equal(e.name, 'Renamed');
  assert.equal(e.photo, 'file:///photo.jpg');
  assert.deepEqual(e.portions, banana.portions);
});

test("apply: the phone's own row sent back changes nothing it shows, and nothing at all the second time", () => {
  const mine = logged(banana, 150, { photo: 'file:///photo.jpg' });
  const t = setup({ entries: [mine] });
  const echo = { ...t.local.read('food_logs', ID), updated_at: AT, deleted_at: null };
  t.local.apply({ ...none(), food_logs: [echo] });
  assert.deepEqual(t.entries.items, [{ ...mine, seed: false }]);
  const after = t.entries.items;
  const writes = t.entries.writes;
  t.local.apply({ ...none(), food_logs: [echo] });
  assert.equal(t.entries.items, after, 'not written again');
  assert.equal(t.entries.writes, writes);
});

test('apply: a pulled deletion removes the entry; for an entry the phone does not have it does nothing', () => {
  const t = setup({ entries: [logged(banana, 150), demoEntry] });
  // A deleted row has only its key and the two times.
  t.local.apply({ ...none(), food_logs: [gone({ id: ID2 })] });
  assert.equal(t.entries.items.length, 2);
  assert.equal(t.entries.writes, 0);
  t.local.apply({ ...none(), food_logs: [gone({ id: ID })] });
  assert.deepEqual(t.entries.items, [demoEntry]);
});

// ── apply: saved_foods ───────────────────────────────────────────────────────
test('apply: a pulled bookmark is stored with its food from the database and the time it was saved', async () => {
  const t = setup();
  t.local.apply({ ...none(), saved_foods: [{ fdc_id: 2709224, saved_at: '2026-11-09T08:00:00.000Z', updated_at: AT, deleted_at: null }] });
  assert.deepEqual(t.saved.items, [], 'the lookup is asynchronous');
  await flush();
  assert.deepEqual(t.lookups, ['usda:2709224']);
  assert.deepEqual(t.saved.items, [{ id: 'usda:2709224', food: banana, savedAt: '2026-11-09T08:00:00.000Z' }]);
  assert.ok(isSavedFood(t.saved.items[0]), 'what is stored survives the saved-foods migration');
  assert.deepEqual(t.local.read('saved_foods', '2709224'), { fdc_id: 2709224, saved_at: '2026-11-09T08:00:00.000Z' });
});

test('apply: a bookmark the phone already has is left alone (no lookup, no write)', async () => {
  const mine = { id: banana.id, food: banana };
  const t = setup({ saved: [mine] });
  t.local.apply({ ...none(), saved_foods: [{ fdc_id: 2709224, saved_at: AT, updated_at: AT, deleted_at: null }] });
  await flush();
  assert.deepEqual(t.lookups, []);
  assert.deepEqual(t.saved.items, [mine]);
  assert.equal(t.saved.writes, 0);
});

test('apply: a bookmark whose food is not found, is not a food, or whose lookup fails is skipped, never thrown', async () => {
  const row = (fdc_id) => ({ fdc_id, saved_at: AT, updated_at: AT, deleted_at: null });
  const unknown = setup({ foods: [] });
  unknown.local.apply({ ...none(), saved_foods: [row(2709224)] });
  await flush();
  assert.deepEqual(unknown.saved.items, []);

  const wrong = setup({ findFood: async () => honey }); // a food with another id
  wrong.local.apply({ ...none(), saved_foods: [row(2709224)] });
  await flush();
  assert.deepEqual(wrong.saved.items, []);

  for (const findFood of [async () => Promise.reject(new Error('the database did not load')), () => { throw new Error('sync throw'); }]) {
    const failing = setup({ findFood });
    assert.doesNotThrow(() => failing.local.apply({ ...none(), saved_foods: [row(2709224)] }));
    await flush();
    assert.deepEqual(failing.saved.items, []);
  }
});

test('apply: a pulled bookmark deletion removes it; one that arrives during the lookup cancels it', async () => {
  const t = setup({ saved: [{ id: banana.id, food: banana }, { id: honey.id, food: honey }] });
  t.local.apply({ ...none(), saved_foods: [gone({ fdc_id: 2709224 }), gone({ fdc_id: 1 })] });
  assert.deepEqual(t.saved.items.map((s) => s.id), [honey.id]);

  let found;
  const slow = setup({ findFood: () => new Promise((resolve) => (found = resolve)) });
  slow.local.apply({ ...none(), saved_foods: [{ fdc_id: 2709224, saved_at: AT, updated_at: AT, deleted_at: null }] });
  await flush();
  slow.local.apply({ ...none(), saved_foods: [gone({ fdc_id: 2709224 })] });
  found(banana);
  await flush();
  assert.deepEqual(slow.saved.items, [], 'the deletion came later: it wins');
});

test('apply: a food bookmarked on the phone while the lookup ran is not replaced', async () => {
  let found;
  const t = setup({ findFood: () => new Promise((resolve) => (found = resolve)) });
  t.local.apply({ ...none(), saved_foods: [{ fdc_id: 2709224, saved_at: AT, updated_at: AT, deleted_at: null }] });
  await flush();
  const mine = { id: banana.id, food: banana, savedAt: '2026-11-10T21:00:00.000Z' };
  t.saved.put(mine);
  found(banana);
  await flush();
  assert.deepEqual(t.saved.items, [mine]);
});

// ── apply: goals ─────────────────────────────────────────────────────────────
test('apply: goals come from the live row with the latest date that has begun; a future or deleted row is ignored', () => {
  const t = setup();
  t.local.apply({
    ...none(),
    goals: [
      goalRow('2020-01-01', { calories: 1000 }),
      goalRow('2026-11-10', { calories: 2222 }), // today: in force
      goalRow('2026-11-11', { calories: 9999 }), // tomorrow
      goalRow('2026-11-09', { calories: 1500 }),
      { effective_date: '2026-11-10', updated_at: '2026-11-10T20:00:00.000Z', deleted_at: AT },
    ],
  });
  assert.deepEqual(t.goals.items, [{ id: 'goals', calories: 2222, protein: 150, carbs: 200, fat: 70, fiber: 30, sugar: 50, sodium: 2000, steps: 8000, goal: 'lose' }]);
});

test('apply: only a future goal row, or only a deleted one: the goals stay as they are', () => {
  const t = setup();
  t.local.apply({ ...none(), goals: [goalRow('2026-11-11'), { effective_date: GOALS_SINCE, updated_at: AT, deleted_at: AT }] });
  assert.deepEqual(t.goals.items, [goals]);
  assert.equal(t.goals.writes, 0);
});

test("apply: the phone's own goals sent back are not written again", () => {
  const t = setup();
  t.local.apply({ ...none(), goals: [{ ...t.local.read('goals', GOALS_SINCE), updated_at: AT, deleted_at: null }] });
  assert.deepEqual(t.goals.items, [goals]);
  assert.equal(t.goals.writes, 0);
});

// ── apply: daily_steps ───────────────────────────────────────────────────────
test("apply: a day's steps replace the local ones and keep the rollover; a new day is added; a deletion removes it", () => {
  const t = setup({ dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }, { id: '2026-11-09', steps: 4950, rollover: 0 }] });
  t.local.apply({
    ...none(),
    daily_steps: [
      { log_date: TODAY, steps: 9000, updated_at: AT, deleted_at: null },
      { log_date: '2026-11-08', steps: 1234, updated_at: AT, deleted_at: null },
      gone({ log_date: '2026-11-09' }),
      gone({ log_date: '2026-11-01' }), // not on the phone
    ],
  });
  assert.deepEqual(t.dayLogs.items, [
    { id: TODAY, steps: 9000, rollover: 200 },
    { id: '2026-11-08', steps: 1234, rollover: 0 },
  ]);
});

// ── apply: as a whole ────────────────────────────────────────────────────────
test('apply is idempotent: the same pull a second time writes nothing', async () => {
  const t = setup({
    entries: [demoEntry, logged(banana, 150, { id: ID2 })],
    saved: [{ id: honey.id, food: honey }],
    dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }],
  });
  const pull = {
    food_logs: [logRow(), logRow({ id: ID2, quantity: 75 }), gone({ id: DEMO })],
    saved_foods: [{ fdc_id: 2709224, saved_at: AT, updated_at: AT, deleted_at: null }, gone({ fdc_id: 169640 })],
    goals: [goalRow('2026-11-01')],
    daily_steps: [{ log_date: TODAY, steps: 9000, updated_at: AT, deleted_at: null }, { log_date: '2026-11-08', steps: 1, updated_at: AT, deleted_at: null }],
  };
  t.local.apply(pull);
  await flush();
  const first = JSON.stringify([t.entries.items, t.saved.items, t.goals.items, t.dayLogs.items]);
  const writes = t.writes();
  assert.ok(writes > 0);
  assert.equal(t.entries.items.length, 2);
  assert.deepEqual(t.saved.items.map((s) => s.id), ['usda:2709224']);

  t.local.apply(structuredClone(pull));
  await flush();
  assert.equal(JSON.stringify([t.entries.items, t.saved.items, t.goals.items, t.dayLogs.items]), first);
  assert.equal(t.writes(), writes, 'no store was written the second time');
});

test('apply: a malformed row is skipped without throwing and the rest of the pull is applied', async () => {
  const t = setup({ dayLogs: [{ id: TODAY, steps: 5782, rollover: 200 }] });
  const before = JSON.stringify([t.goals.items, t.dayLogs.items]);
  assert.doesNotThrow(() =>
    t.local.apply({
      food_logs: [null, 7, {}, { id: ID2, deleted_at: null }, logRow({ id: ID2, values: null }), logRow({ id: ID2, quantity: NaN }), logRow({ id: ID2, log_date: 'yesterday' }), logRow()],
      saved_foods: [null, {}, { fdc_id: 'x', saved_at: AT, deleted_at: null }, { fdc_id: 169640, saved_at: 'never', deleted_at: null }, { fdc_id: 2709224, saved_at: AT, updated_at: AT, deleted_at: null }],
      goals: [null, { effective_date: '2026-11-10', deleted_at: null }, goalRow('2026-11-10', { calories: NaN }), goalRow('2026-11-10', { goal: 'bulk' }), goalRow('not a date')],
      daily_steps: [null, {}, { log_date: TODAY, steps: 'many', deleted_at: null }, { log_date: 'today', steps: 1, deleted_at: null }],
    }),
  );
  await flush();
  assert.deepEqual(t.entries.items.map((e) => e.id), [ID], 'the one good log');
  assert.deepEqual(t.saved.items.map((s) => s.id), ['usda:2709224'], 'the one good bookmark');
  assert.equal(JSON.stringify([t.goals.items, t.dayLogs.items]), before);
});

test('apply: a pull with a table missing, or no pull at all, does not throw', () => {
  const t = setup();
  assert.doesNotThrow(() => t.local.apply({ food_logs: [logRow()] }));
  assert.equal(t.entries.items.length, 1);
  assert.doesNotThrow(() => t.local.apply(undefined));
  assert.doesNotThrow(() => t.local.apply({ food_logs: 'no', saved_foods: {}, goals: null, daily_steps: 3 }));
});

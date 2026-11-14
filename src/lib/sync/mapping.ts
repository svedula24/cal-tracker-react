// Between the app's stored shapes (Entry, SavedFood, Goals, DayLog) and the rows of the sync
// wire format (./types.ts). Pure: no React, no storage, no clock. Unit-tested in
// tests/syncMapping.test.mjs.
import type { Food } from '@/data/foods';
import type { DayLog, Entry } from '@/lib/data';
import type { SavedFood } from '@/lib/savedFoods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { entryGrams, foodOfEntry, G, OZ, scale } from '../measure.ts';
import { NUTRIENT_KEYS, type Goals, type Nutrients } from '../nutrition.ts';
import { isUuid } from '../uuid.ts';
import type { DailyActivityRow, FoodLogRow, GoalRow, NutrientValues, SavedFoodRow, Table } from './types.ts';

/** A row as it is read for a push: the engine adds `updated_at` and `deleted_at`. */
type Unsynced<Row> = Omit<Row, 'updated_at' | 'deleted_at'>;

// ── Nutrients ────────────────────────────────────────────────────────────────
const WIRE_KEY = {
  calories: 'calories',
  protein: 'protein_g',
  carbs: 'carbs_g',
  fat: 'fat_g',
  fiber: 'fiber_g',
  sugar: 'sugar_g',
  sodium: 'sodium_mg',
} as const satisfies Record<keyof Nutrients, keyof NutrientValues>;

/** The app's nutrients under the wire names. The app has no "not reported": a 0 is sent as 0. */
export const toValues = (n: Nutrients): NutrientValues =>
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [WIRE_KEY[k], n[k]])) as NutrientValues;

/** Wire values as the app's nutrients: a nutrient the server holds as NULL (not reported) is 0. */
export const fromValues = (v: NutrientValues): Nutrients =>
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, v[WIRE_KEY[k]] ?? 0])) as Nutrients;

const sameNutrients = (a: Nutrients, b: Nutrients): boolean => NUTRIENT_KEYS.every((k) => a[k] === b[k]);
const allFinite = (v: NutrientValues): boolean => Object.values(v).every((x) => Number.isFinite(x));

// ── Food ids ─────────────────────────────────────────────────────────────────
const USDA_ID = /^usda:(\d+)$/;

/** The FoodData Central id in a food id `usda:<n>`; null for any other id. */
export function fdcIdOf(foodId: string): number | null {
  const m = USDA_ID.exec(foodId);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

const usdaId = (fdcId: number): string => `usda:${fdcId}`;

/**
 * The food id of an entry whose log the server holds in grams without a database food (it did not
 * know the `fdc_id` the entry was logged from) and that this device has never seen. The entry
 * still needs a food to be measured in grams (foodOfEntry); it is never a saved-food key on the
 * server (savedToRow), and it is sent back as the same kind of log (entryToLog).
 */
const customId = (logId: string): string => `custom:${logId}`;

// ── Entries ↔ food_logs ──────────────────────────────────────────────────────
/**
 * A logged entry as a food log, or null when it must not be sent: a demo entry (`seed`), an id
 * that is not a UUID, or a number JSON cannot carry (NaN, Infinity).
 *
 * An entry with a database food behind it (foodOfEntry) is a log in grams: `values` are the
 * entry's own per 100 g (typed-over values included), `food_values` and `food_name` the database
 * food's. When the food's id is not `usda:<n>` there is no `fdc_id` to send, so the log is a
 * custom one in grams (`food_name` and `food_values` null), which is also how the server keeps a
 * log whose `fdc_id` it does not know. Any other entry is a custom log in servings.
 */
export function entryToLog(entry: Entry): Unsynced<FoodLogRow> | null {
  if (entry.seed === true || !isUuid(entry.id)) return null;
  const head = { id: entry.id, log_date: entry.date, logged_at: entry.time, name: entry.name };
  const food = foodOfEntry(entry);
  let row: Unsynced<FoodLogRow>;
  if (food && entry.per100g) {
    const fdcId = fdcIdOf(food.id);
    row = {
      ...head,
      fdc_id: fdcId,
      food_name: fdcId === null ? null : food.name,
      unit: 'g',
      quantity: entryGrams(entry, food),
      values: toValues(entry.per100g),
      food_values: fdcId === null ? null : toValues(food.per100g),
    };
  } else {
    row = { ...head, fdc_id: null, food_name: null, unit: 'serving', quantity: entry.servings, values: toValues(entry.nutrients), food_values: null };
  }
  const sendable = Number.isFinite(row.quantity) && allFinite(row.values) && (row.food_values === null || allFinite(row.food_values));
  return sendable ? row : null;
}

/** Entries are ordered by comparing `time` as text, so every time is in the one format the app writes. */
const isoTime = (t: string): string => {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString();
};

/**
 * A food log from the server as an entry. `existing` is this device's copy of the entry, if it has
 * one: the server does not hold a food's portions or the entry's photo, so they are kept from it.
 *
 * A log in grams always becomes an entry measured in grams (`measure: G`, `servings` = the grams),
 * with a food behind it, so it opens in Nutrition with its Amount in grams:
 * - with an `fdc_id`, the food is `usda:<fdc_id>` under `food_name`, with `food_values`;
 * - without one (a food the server did not know), the food `existing` has, else a food of the
 *   log's own (`custom:<log id>`, the log's name and values, no portions).
 * `foodPer100g` is set only when the food's values differ from the entry's, which is how the app
 * marks an entry whose values were typed over. A log in servings becomes a hand-written entry.
 * The result is never a demo entry.
 */
export function logToEntry(log: FoodLogRow, existing?: Entry): Entry {
  const head = { id: log.id, date: log.log_date, time: isoTime(log.logged_at), name: log.name };
  const photo = existing?.photo ? { photo: existing.photo } : {};
  const known = existing ? foodOfEntry(existing) : null;

  if (log.unit === 'serving') {
    // Its measure (if any) is only a label here; one that belonged to a food in grams is dropped.
    const measure = existing?.measure && !known ? { measure: existing.measure } : {};
    return { ...head, servings: log.quantity, nutrients: fromValues(log.values), ...measure, ...photo, seed: false };
  }

  const per100g = fromValues(log.values);
  let food: Food;
  if (log.fdc_id !== null) {
    const id = usdaId(log.fdc_id);
    food = {
      id,
      name: log.food_name ?? log.name,
      per100g: log.food_values ? fromValues(log.food_values) : per100g,
      portions: known?.id === id ? known.portions : [],
    };
  } else {
    food = known ?? { id: customId(log.id), name: log.name, per100g, portions: [] };
  }
  // The server keeps grams only. The unit this device measured the entry in (ounces, "1 banana")
  // is kept when the copy here is of the same food, so a pulled change, or its own row coming
  // back, does not switch the entry to grams; the amount is the server's either way.
  const unit = existing?.measure && known?.id === food.id && existing.measure.grams > 0 ? existing.measure : G;
  const measure = unit.label === OZ.label ? OZ : unit;
  return {
    ...head,
    servings: log.quantity / measure.grams,
    nutrients: scale(per100g, measure.grams),
    per100g,
    ...(sameNutrients(food.per100g, per100g) ? {} : { foodPer100g: food.per100g }),
    portions: food.portions,
    measure,
    foodId: food.id,
    foodName: food.name,
    ...photo,
    seed: false,
  };
}

// ── Saved foods ──────────────────────────────────────────────────────────────
/**
 * A saved food as a row, or null unless its id is `usda:<n>` (nothing else exists on the server).
 * The app does not record when a food was saved, so the caller supplies `savedAt` (ISO).
 */
export function savedToRow(saved: SavedFood, savedAt: string): Unsynced<SavedFoodRow> | null {
  const fdcId = fdcIdOf(saved.id);
  return fdcId === null ? null : { fdc_id: fdcId, saved_at: savedAt };
}

/** The saved-food id of a row. The row carries no food: the snapshot has to be fetched before it can be shown. */
export const rowToSavedId = (row: Pick<SavedFoodRow, 'fdc_id'>): string => usdaId(row.fdc_id);

// ── Goals ────────────────────────────────────────────────────────────────────
/** One of the app's goal rows as the goal in force from its effective date (the row's key). */
export const goalsToRow = (goals: Goals): Unsynced<GoalRow> => ({
  effective_date: goals.effectiveDate,
  calories: goals.calories,
  protein_g: goals.protein,
  carbs_g: goals.carbs,
  fat_g: goals.fat,
  fiber_g: goals.fiber,
  sugar_g: goals.sugar,
  sodium_mg: goals.sodium,
  steps: goals.steps,
  goal: goals.goal,
  source: goals.source,
  workout_kcal: goals.workoutKcal,
  active_rest_kcal: goals.activeRestKcal,
});

/**
 * A goal row as one of the app's goal rows (id = the effective date). A field a server without it
 * leaves out takes the app's default: typed by hand, nothing added for a workout or active-rest day.
 */
export const rowToGoals = (row: GoalRow): Goals => ({
  id: row.effective_date,
  effectiveDate: row.effective_date,
  source: row.source === 'computed' ? 'computed' : 'manual',
  calories: row.calories,
  protein: row.protein_g,
  carbs: row.carbs_g,
  fat: row.fat_g,
  fiber: row.fiber_g,
  sugar: row.sugar_g,
  sodium: row.sodium_mg,
  steps: row.steps,
  goal: row.goal,
  workoutKcal: row.workout_kcal ?? 0,
  activeRestKcal: row.active_rest_kcal ?? 0,
});

// ── Day logs ─────────────────────────────────────────────────────────────────
/** A day's activity: steps, day type and its own workout calories. The rollover stays on the device: it is never sent. */
export const dayLogToRow = (log: DayLog): Unsynced<DailyActivityRow> => ({
  activity_date: log.id,
  steps: log.steps,
  day_type: log.dayType ?? null,
  workout_kcal: log.workoutKcal ?? null,
});

/** An activity row as a day log, keeping this device's rollover for that day (0 when it has none). */
export const rowToDayLog = (row: DailyActivityRow, existing?: DayLog): DayLog => ({
  id: row.activity_date,
  steps: row.steps,
  rollover: existing?.rollover ?? 0,
  dayType: row.day_type ?? null,
  workoutKcal: row.workout_kcal ?? null,
});

// ── Keys ─────────────────────────────────────────────────────────────────────
const KEY_FIELD = {
  food_logs: 'id',
  saved_foods: 'fdc_id',
  goals: 'effective_date',
  daily_activity: 'activity_date',
} as const satisfies Record<Table, string>;

/** The key of a row, as text: the log's id, the food's `fdc_id`, the goal's or the day's date. */
export const keyOf = (table: Table, row: object): string => String((row as Record<string, unknown>)[KEY_FIELD[table]]);

/** The key fields of a deleted row (the engine adds `updated_at` and `deleted_at`). The inverse of keyOf. */
export const tombstone = (table: Table, key: string): object => ({ [KEY_FIELD[table]]: table === 'saved_foods' ? Number(key) : key });

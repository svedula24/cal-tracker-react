// App data on top of the on-device store (src/lib/store.ts). Every action is a
// local write; when the app has an API URL, the write is also reported to the
// background sync (src/lib/sync/), which copies it to the server later. First
// launch is seeded so Home matches the reference screenshots exactly; anything
// the user logs adds on top.
import { getCollection, makeId, useCollection } from '@/lib/store';
import {
  addDays,
  dailyScore,
  dayKey,
  dayTarget,
  type DayType,
  FIRST_GOAL_DATE,
  goalOn,
  type Goals,
  healthScore,
  migrateGoals,
  type Nutrients,
  stepsToCalories,
  sum,
  todayKey,
} from '@/lib/nutrition';
import type { Food, Portion } from '@/data/foods';
import { defaultServing, scale } from '@/lib/measure';
import { migrateEntries } from '@/lib/migrateEntries';
import { migrateSavedFoods, type SavedFood } from '@/lib/savedFoods';
import { PAST_DAY_FOODS, SAVED_FOODS } from '@/lib/seedFoods';
import { markDirty } from '@/lib/sync/dirty';
import { fdcIdOf } from '@/lib/sync/mapping';

export type Entry = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // ISO timestamp
  name: string;
  servings: number; // quantity of `measure`
  nutrients: Nutrients; // per one `measure` (what the day's totals sum)
  // The food behind the entry, so its measurement can be changed later. Absent
  // on the hand-written demo entries, which only have a serving.
  per100g?: Nutrients;
  // The database food's own values, kept once a value of this entry was typed over
  // (per100g then holds the entry's), so a bookmark still saves the database food.
  foodPer100g?: Nutrients;
  portions?: Portion[];
  measure?: Portion;
  foodId?: string;
  foodName?: string; // the database name, even after the entry is renamed
  photo?: string;
  // Demo data created at first launch: never synced or shown under "Recent".
  // Cleared by any edit (the entry is then the user's); never set by `add`.
  seed?: boolean;
};
// id = date. `dayType` absent or null: not set (nothing added). Rollover stays on the device.
// `workoutKcal`: calories typed for the day (null = the goal's amount for the day type).
export type DayLog = { id: string; steps: number; rollover: number; dayType?: DayType | null; workoutKcal?: number | null };

// ── Seed (dated relative to first launch) ────────────────────────────────────
const n = (calories: number, protein: number, carbs: number, fat: number, fiber: number, sugar: number, sodium: number): Nutrients => ({
  calories, protein, carbs, fat, fiber, sugar, sodium,
});

function at(date: Date, h: number, m: number) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const now = new Date();
const today = dayKey(now);

// Today's entries sum exactly to the reference: 2543 kcal, 174/322/59 g,
// fiber 13 g, sugar 54 g, sodium 3791 mg.
const todaySeed: [string, number, number, Nutrients][] = [
  ['Whole Milk Latte', 8, 40, n(190, 10, 15, 10, 0, 7, 165)],
  ['Three Seed Sourdough', 9, 1, n(240, 8, 46, 2, 3, 1, 400)],
  ['Sliced Part-Skim Mozzarella', 9, 3, n(80, 7, 1, 5, 0, 0, 175)],
  ['Sandwich', 12, 26, n(725, 40, 75, 29, 4, 6, 1650)],
  ["Cookies 'n Cream Protein Bar", 15, 6, n(150, 17, 14, 3, 1, 1, 180)],
  ['Chicken & Jasmine Rice', 17, 40, n(577, 52, 86, 1, 1, 0, 1100)],
  ['Greek Yogurt Bowl', 19, 10, n(517, 40, 68, 9, 4, 22, 120)],
  ['Honey', 19, 12, n(64, 0, 17, 0, 0, 17, 1)],
];

// Previous five days: logged, but under goal (red rings in the week strip).
// Real USDA foods (src/lib/seedFoods.ts; a test checks they exist).

function seedEntries(): Entry[] {
  const out: Entry[] = todaySeed.map(([name, h, m, nutrients]) => ({
    id: makeId(), date: today, time: at(now, h, m), name, servings: 1, nutrients, seed: true,
  }));
  for (let back = 1; back <= 5; back++) {
    const d = addDays(now, -back);
    for (const [name, h, m, food] of PAST_DAY_FOODS) {
      out.push({ ...newEntry(food, defaultServing(food), back % 2 ? 1.5 : 1.25, dayKey(d)), time: at(d, h, m), name, seed: true });
    }
  }
  return out;
}

// One goal, in force since before any log. Today's target adds the 202 kcal of today's steps:
// 3027 + 202 + 200 rollover = the reference budget of 3429, and carbs 382.5 + 202/4 = 433 g, the
// reference's 433 g goal (so the seeded day still scores the reference's 89).
const goalsSeed: Goals[] = [
  {
    id: FIRST_GOAL_DATE,
    effectiveDate: FIRST_GOAL_DATE,
    source: 'manual',
    calories: 3027, protein: 182, carbs: 382.5, fat: 94, fiber: 38, sugar: 113, sodium: 2300,
    steps: 10000, goal: 'gain', workoutKcal: 0, activeRestKcal: 0,
  },
];

const dayLogSeed: DayLog[] = [
  { id: today, steps: 5782, rollover: 200, dayType: null, workoutKcal: null },
  ...[1, 2, 3, 4, 5].map((b) => ({ id: dayKey(addDays(now, -b)), steps: 4000 + b * 950, rollover: 0, dayType: null, workoutKcal: null })),
];

// Streak is display-only (reference shows 16 days).
export const STREAK_DAYS = 16;

// ── Hooks ────────────────────────────────────────────────────────────────────
// Each collection is made in one place (key, seed, migration), for the hooks and
// for sync. The writers are module-level, so the functions the hooks return are
// stable. Each reports the row to sync AFTER the local write (markDirty does
// nothing without an API URL and never throws).
const entriesSeed = seedEntries();
// Stored entries are upgraded once at load (UUID ids, the `seed` flag); see migrateEntries.
const entriesStore = () => getCollection<Entry>('entries', entriesSeed, migrateEntries);
const savedSeed: SavedFood[] = SAVED_FOODS.map((food) => ({ id: food.id, food }));
// Stored entries are cleaned once when the list loads (and saved), so every
// item has a usable snapshot; see migrateSavedFoods.
const savedStore = () => getCollection<SavedFood>('savedFoods', savedSeed, migrateSavedFoods);
// Every goal the user has had, one row per effective date. An older install's one set of goals is
// upgraded to the row in force since FIRST_GOAL_DATE once at load (migrateGoals).
const goalsStore = () => getCollection<Goals>('goals', goalsSeed, migrateGoals);
const dayLogsStore = () => getCollection<DayLog>('dayLogs', dayLogSeed);

/** The collections sync reads and writes (src/lib/sync/index.ts): the same instances the hooks use. */
export const syncStores = () => ({ entries: entriesStore(), saved: savedStore(), goals: goalsStore(), dayLogs: dayLogsStore() });

const addEntry = (entry: Entry) => {
  // Marked as the user's from the start: an entry without the flag is guessed at the next load
  // (migrateEntries), and that guess takes one that is not measured in grams for demo data.
  entriesStore().add({ ...entry, seed: false });
  markDirty('food_logs', entry.id);
};
// Any edit makes a demo entry the user's.
const updateEntry = (id: string, patch: Partial<Entry>) => {
  entriesStore().update(id, { ...patch, seed: false });
  markDirty('food_logs', id);
};
const removeEntry = (id: string) => {
  const store = entriesStore();
  // A demo entry was never sent, so there is nothing to delete on the server.
  const demo = store.items.find((e) => e.id === id)?.seed === true;
  store.remove(id);
  if (!demo) markDirty('food_logs', id, true);
};
export const useEntries = () => ({
  ...useCollection<Entry>('entries', entriesSeed, migrateEntries),
  add: addEntry,
  update: updateEntry,
  remove: removeEntry,
});
export { migrateEntries };
// A day's steps and day type: its sync key is the date. Home's steps card writes them (setDayLog).
const addDayLog = (log: DayLog) => {
  dayLogsStore().add(log);
  markDirty('daily_activity', log.id);
};
const updateDayLog = (id: string, patch: Partial<DayLog>) => {
  dayLogsStore().update(id, patch);
  markDirty('daily_activity', id);
};
const removeDayLog = (id: string) => {
  dayLogsStore().remove(id);
  markDirty('daily_activity', id, true);
};
/** Sets a day's steps and/or day type, creating the day's log if it has none. */
export const setDayLog = (date: string, patch: Partial<Pick<DayLog, 'steps' | 'dayType' | 'workoutKcal'>>) => {
  if (dayLogsStore().items.some((d) => d.id === date)) updateDayLog(date, patch);
  else addDayLog({ id: date, steps: 0, rollover: 0, dayType: null, workoutKcal: null, ...patch });
};
export const useDayLogs = () => ({
  ...useCollection<DayLog>('dayLogs', dayLogSeed),
  add: addDayLog,
  update: updateDayLog,
  remove: removeDayLog,
  set: setDayLog,
});

// Only database foods (`usda:<n>`) exist on the server; its key is the number as text.
const markSaved = (id: string, deleted: boolean) => {
  const fdcId = fdcIdOf(id);
  if (fdcId !== null) markDirty('saved_foods', String(fdcId), deleted);
};
// The time is recorded here, for every screen that bookmarks a food.
const addSaved = (item: SavedFood) => {
  savedStore().add({ ...item, savedAt: item.savedAt ?? new Date().toISOString() });
  markSaved(item.id, false);
};
const removeSaved = (id: string) => {
  savedStore().remove(id);
  markSaved(id, true);
};
export const useSavedFoods = () => ({
  ...useCollection<SavedFood>('savedFoods', savedSeed, migrateSavedFoods),
  add: addSaved,
  remove: removeSaved,
});

// Goals are dated history (user_goals on the server): a change made today is the row dated today,
// so every earlier day keeps the goal it had. Its sync key is that date.
export type GoalPatch = Partial<Omit<Goals, 'id' | 'effectiveDate'>>;

/** Changes the goal from today on: today's row if there is one, else a new row dated today (from the goal in force). */
export const setGoals = (patch: GoalPatch) => {
  const store = goalsStore();
  const date = todayKey();
  if (store.items.some((g) => g.id === date)) store.update(date, patch);
  else store.add({ ...(goalOn(store.items, date) ?? goalsSeed[0]), ...patch, id: date, effectiveDate: date });
  markDirty('goals', date);
};

/** The goal in force on `date` (the seed's if no row has begun, which only damaged data can cause). */
const goalFor = (rows: readonly Goals[], date: string): Goals => goalOn(rows, date) ?? goalsSeed[0];

const useGoalRows = () => useCollection<Goals>('goals', goalsSeed, migrateGoals).items;

/** Today's goal, every goal row, and the writer. */
export function useGoals() {
  const rows = useGoalRows();
  return { goals: goalFor(rows, todayKey()), rows, ready: goalsStore().ready, set: setGoals };
}

/** The goal in force on `date`. */
export const useGoalOn = (date: string): Goals => goalFor(useGoalRows(), date);

/** Everything Home shows for one day, derived from the logs and the goal in force that day. */
export function useDay(date: string) {
  const goals = useGoalOn(date);
  const entries = useEntries().items.filter((e) => e.date === date).sort((a, b) => b.time.localeCompare(a.time));
  const log: DayLog = useDayLogs().items.find((d) => d.id === date) ?? { id: date, steps: 0, rollover: 0, dayType: null, workoutKcal: null };

  const totals = sum(entries);
  const target = dayTarget(goals, log);
  const budget = target.calories + (log.rollover ?? 0);
  // The steps' share of the adjustment, shown on its own on the activity page.
  const stepsKcal = stepsToCalories(log.steps);

  return {
    goals, target, entries, log, totals, stepsKcal, budget,
    // Calories added for the day's activity (steps + workout / active recovery).
    burned: target.adjustment,
    score: dailyScore(totals, budget, target),
    health: healthScore(totals, budget, { ...target, goal: goals.goal }),
  };
}

/** ISO timestamp for "now" moved onto `date` (logging to a selected day). */
export function nowOn(date: string): string {
  const t = new Date();
  const [y, m, d] = date.split('-').map(Number);
  t.setFullYear(y, m - 1, d);
  return t.toISOString();
}

/**
 * Log `quantity` × `measure` of a food for a day (time = now on that day). The
 * entry snapshots the food (per100g, portions), so it can be re-measured later
 * without the 13k-food database being loaded, and survives a data refresh.
 */
export function newEntry(food: Food, measure: Portion, quantity: number, date: string): Entry {
  return {
    id: makeId(),
    date,
    time: nowOn(date),
    name: food.name,
    servings: quantity,
    nutrients: scale(food.per100g, measure.grams),
    per100g: food.per100g,
    portions: food.portions,
    measure,
    foodId: food.id,
    foodName: food.name,
  };
}

/** The calorie budget for a day: the day's target under `goal` (steps and day type included) + rollover. */
export function dayBudget(goal: Goals, log: DayLog | undefined) {
  return dayTarget(goal, log).calories + (log?.rollover ?? 0);
}

/** For the week strip: each date's budget under the goal in force on that date. */
export function useDayBudgets(dates: readonly string[]): Record<string, number> {
  const rows = useGoalRows();
  const logs = useDayLogs().items;
  return Object.fromEntries(dates.map((d) => [d, dayBudget(goalFor(rows, d), logs.find((l) => l.id === d))]));
}


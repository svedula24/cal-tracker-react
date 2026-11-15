// App data on top of the on-device store (src/lib/store.ts). Every action is a
// local write; when the app has an API URL, the write is also reported to the
// background sync (src/lib/sync/), which copies it to the server later. A new
// install starts empty, with only the default goal (DEFAULT_GOAL).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo } from 'react';

import { getCollection, makeId, useCollection } from '@/lib/store';
import {
  dailyScore,
  DEFAULT_GOAL,
  dayTarget,
  type DayType,
  FIRST_GOAL_DATE,
  goalOn,
  type Goals,
  healthScore,
  migrateGoals,
  streakDays,
  type Nutrients,
  stepsToCalories,
  sum,
  todayKey,
} from '@/lib/nutrition';
import type { Food, Portion } from '@/data/foods';
import { demoDayLogs, isDemoSaved } from '@/lib/demoData';
import { scale } from '@/lib/measure';
import { dropDemoEntries, migrateEntries } from '@/lib/migrateEntries';
import { migrateSavedFoods, type SavedFood } from '@/lib/savedFoods';
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
  // on an entry typed in by hand, which only has a serving.
  per100g?: Nutrients;
  // The database food's own values, kept once a value of this entry was typed over
  // (per100g then holds the entry's), so a bookmark still saves the database food.
  foodPer100g?: Nutrients;
  portions?: Portion[];
  measure?: Portion;
  foodId?: string;
  foodName?: string; // the database name, even after the entry is renamed
  photo?: string;
  // true: demo data an older version seeded at first launch, dropped at load (dropDemoEntries)
  // and never synced. false on every entry the user logs or the server sends: an entry without
  // the flag is one from before it existed, which migrateEntries tags at load.
  seed?: boolean;
  // `seed` was set by migrateEntries' guess, not by the old seeding. Dropped all the same.
  seedGuessed?: boolean;
};
// id = date. `dayType` absent or null: not set (nothing added). Rollover stays on the device.
// `workoutKcal`: calories typed for the day (null = the goal's amount for the day type).
export type DayLog = { id: string; steps: number; rollover: number; dayType?: DayType | null; workoutKcal?: number | null };

// A new install starts with the default goal (DEFAULT_GOAL). Synced like any goal row: a new
// install's first sync uploads it to its own new account. An install that has stored goals never uses it.
const goalsSeed: Goals[] = [DEFAULT_GOAL];
const NO_ITEMS: never[] = [];

// ── Hooks ────────────────────────────────────────────────────────────────────
// Each collection is made in one place (key, first-launch items, migration), for the hooks and
// for sync. The writers are module-level, so the functions the hooks return are
// stable. Each reports the row to sync AFTER the local write (markDirty does
// nothing without an API URL and never throws).
// Stored entries are upgraded at load (UUID ids, the `seed` flag), and every demo entry an older
// version seeded is dropped; see migrateEntries.ts.
const migrateStoredEntries = (items: Entry[]) => dropDemoEntries(migrateEntries(items));
const entriesStore = () => getCollection<Entry>('entries', NO_ITEMS, migrateStoredEntries);
// Stored entries are cleaned once when the list loads (and saved), so every
// item has a usable snapshot; see migrateSavedFoods.
const savedStore = () => getCollection<SavedFood>('savedFoods', NO_ITEMS, migrateSavedFoods);
// Every goal the user has had, one row per effective date. An older install's one set of goals is
// upgraded to the row in force since FIRST_GOAL_DATE once at load (migrateGoals).
const goalsStore = () => getCollection<Goals>('goals', goalsSeed, migrateGoals);
const dayLogsStore = () => getCollection<DayLog>('dayLogs', NO_ITEMS);

/** The collections sync reads and writes (src/lib/sync/index.ts): the same instances the hooks use. */
export const syncStores = () => ({ entries: entriesStore(), saved: savedStore(), goals: goalsStore(), dayLogs: dayLogsStore() });

/**
 * Empties the synced collections without reporting anything to sync: for an
 * install that is being linked to another account (src/lib/sync/index.ts linkThisDevice), whose
 * data then arrives from the server. Resolves once all four are stored empty (so the default goal
 * does not come back); rejects if one cannot be.
 */
export const clearLocalData = async (): Promise<void> => {
  await Promise.all(Object.values(syncStores()).map((store) => store.clear()));
};

const DEFAULT_TARGETS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium', 'steps', 'goal'] as const;
const isDefaultGoal = (g: Goals): boolean => g.id === FIRST_GOAL_DATE && DEFAULT_TARGETS.every((k) => g[k] === DEFAULT_GOAL[k]);

/**
 * How much of this install's data is the user's own: its entries, and whether it has any saved
 * food, day log, or goal other than the default one. For the first-run offer to link (only an
 * install with nothing of its own is wiped without asking) and its confirmation.
 */
export function ownData(): { entries: number; other: boolean } {
  const { entries, goals, dayLogs, saved } = syncStores();
  return {
    entries: entries.items.length,
    other: saved.items.length > 0 || dayLogs.items.length > 0 || goals.items.some((g) => !isDefaultGoal(g)),
  };
}

const addEntry = (entry: Entry) => {
  // Marked as the user's from the start: an entry without the flag is guessed at the next load
  // (migrateEntries), and that guess takes one that is not measured in grams for old demo data.
  entriesStore().add({ ...entry, seed: false });
  markDirty('food_logs', entry.id);
};
// Any edit makes an entry the user's: an old one the app only guessed was demo (kept because the user
// had renamed it) then syncs, and can never be taken for demo again, even if edited back to a demo name.
const updateEntry = (id: string, patch: Partial<Entry>) => {
  entriesStore().update(id, { ...patch, seed: false, seedGuessed: undefined });
  markDirty('food_logs', id);
};
const removeEntry = (id: string) => {
  entriesStore().remove(id);
  markDirty('food_logs', id, true);
};
export const useEntries = () => ({
  ...useCollection<Entry>('entries', NO_ITEMS, migrateStoredEntries),
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
  ...useCollection<DayLog>('dayLogs', NO_ITEMS),
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
  ...useCollection<SavedFood>('savedFoods', NO_ITEMS, migrateSavedFoods),
  add: addSaved,
  remove: removeSaved,
});

// ── Demo data from older versions ────────────────────────────────────────────
// Older versions seeded day logs and saved foods at first launch, and those were synced. They are
// removed once per install, as the user's own deletions would be: tombstones go to the server, so
// it and every linked device drop them too. Demo entries were never synced: dropped at load
// (dropDemoEntries). Goals are left alone.
// v2: runs once more, for demo bookmarks pulled from the server with its stand-in date (isDemoSaved).
const DEMO_CLEANED = 'kalo.demo.cleaned.v2';
let demoCleanup: Promise<boolean> | null = null;

/**
 * Removes the old demo day logs and bookmarks (src/lib/demoData.ts) once the stored data has loaded,
 * unless this install already did (DEMO_CLEANED). A seeded day the user has since given a day type
 * or workout calories keeps those: only its demo steps and rollover are cleared. Resolves true when
 * it ran now: call markDemoCleaned once its writes are reported to sync, so it does not run again.
 * Runs once per launch however often it is called; never rejects.
 */
export function removeDemoDataOnce(): Promise<boolean> {
  demoCleanup ??= (async () => {
    const { dayLogs, saved } = syncStores();
    await Promise.all([dayLogs.whenReady(), saved.whenReady()]);
    // Unreadable: not now (the next launch tries again), rather than possibly twice.
    if ((await AsyncStorage.getItem(DEMO_CLEANED).catch(() => '1')) === '1') return false;
    const { remove, clear } = demoDayLogs(dayLogs.items);
    for (const id of remove) removeDayLog(id);
    for (const id of clear) updateDayLog(id, { steps: 0, rollover: 0 });
    for (const s of saved.items.filter(isDemoSaved)) removeSaved(s.id);
    return true;
  })().catch(() => false);
  return demoCleanup;
}

/** Records that this install's demo data is gone (removeDemoDataOnce). */
export const markDemoCleaned = (): Promise<void> => AsyncStorage.setItem(DEMO_CLEANED, '1').catch(() => {});

// Goals are dated history (user_goals on the server): a change made today is the row dated today,
// so every earlier day keeps the goal it had. Its sync key is that date.
export type GoalPatch = Partial<Omit<Goals, 'id' | 'effectiveDate'>>;

/** Changes the goal from today on: today's row if there is one, else a new row dated today (from the goal in force). */
export const setGoals = (patch: GoalPatch) => {
  const store = goalsStore();
  const date = todayKey();
  if (store.items.some((g) => g.id === date)) store.update(date, patch);
  else store.add({ ...(goalOn(store.items, date) ?? DEFAULT_GOAL), ...patch, id: date, effectiveDate: date });
  markDirty('goals', date);
};

/** The goal in force on `date` (the default if no row has begun: no goals at all, as after a link to an account without any). */
const goalFor = (rows: readonly Goals[], date: string): Goals => goalOn(rows, date) ?? DEFAULT_GOAL;

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
  const all = useEntries().items;
  const logs = useDayLogs().items;
  // Memoized so a re-render with the same data hands Home's cards the same objects (they skip
  // rendering).
  return useMemo(() => {
    const entries = all.filter((e) => e.date === date).sort((a, b) => b.time.localeCompare(a.time));
    const log: DayLog = logs.find((d) => d.id === date) ?? { id: date, steps: 0, rollover: 0, dayType: null, workoutKcal: null };

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
  }, [all, logs, goals, date]);
}

/** The user's streak (streakDays): consecutive days with an entry, ending today (or yesterday). */
export function useStreak(): number {
  const entries = useEntries().items;
  const today = todayKey();
  return useMemo(() => streakDays(entries.map((e) => e.date), today), [entries, today]);
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

/** Every day log by its date, built once per change to the logs (the strip pages share it). */
const logsById = new WeakMap<readonly DayLog[], Map<string, DayLog>>();
function logIndex(logs: readonly DayLog[]): Map<string, DayLog> {
  let index = logsById.get(logs);
  if (!index) logsById.set(logs, (index = new Map(logs.map((l) => [l.id, l]))));
  return index;
}

/** For the week strip: each date's budget under the goal in force on that date. Pass only the days on screen. */
export function useDayBudgets(dates: readonly string[]): Record<string, number> {
  const rows = useGoalRows();
  const logs = logIndex(useDayLogs().items);
  return Object.fromEntries(dates.map((d) => [d, dayBudget(goalFor(rows, d), logs.get(d))]));
}


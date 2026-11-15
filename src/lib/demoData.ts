// What older versions seeded as demo data at first launch, frozen here so it can be recognised and
// removed from existing installs (the app no longer seeds any). Pure and Node-importable:
// tests/demoData.test.mjs.
//
// Entries were never synced; they are dropped at load (migrateEntries.ts dropDemoEntries). Day logs
// and saved foods WERE synced (Architecture Decision Log, record 22), so they are removed once per
// install with tombstones (src/lib/data.ts removeDemoDataOnce). Goals are left alone.
import type { DayLog, Entry } from '@/lib/data';
import type { SavedFood } from '@/lib/savedFoods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { addDays, dayKey, parseDay } from './nutrition.ts';

/** The install day's demo entries: hand-written, one serving each. */
export const DEMO_TODAY_NAMES: readonly string[] = [
  'Whole Milk Latte',
  'Three Seed Sourdough',
  'Sliced Part-Skim Mozzarella',
  'Sandwich',
  "Cookies 'n Cream Protein Bar",
  'Chicken & Jasmine Rice',
  'Greek Yogurt Bowl',
  'Honey',
];
/** The five days before it: these USDA foods, 1.5 or 1.25 servings (odd or even days back). */
export const DEMO_PAST_NAMES: readonly string[] = ['Oatmeal', 'Banana', 'Chicken Burrito', 'Brown Rice', 'Greek Yogurt (plain)'];
const DEMO_PAST_SERVINGS = [1.5, 1.25];

/**
 * Whether an entry still looks exactly like a demo one: a demo name, and the servings the seed gave
 * it. For an entry migrateEntries only guessed was demo (`seedGuessed`): one the user renamed or
 * changed is theirs.
 */
export function looksLikeDemoEntry(e: Pick<Entry, 'name' | 'servings'>): boolean {
  if (DEMO_TODAY_NAMES.includes(e.name)) return e.servings === 1;
  if (DEMO_PAST_NAMES.includes(e.name)) return DEMO_PAST_SERVINGS.includes(e.servings);
  return false;
}

// The seeded day logs: on the install day 5,782 steps with a 200 kcal rollover; on the day b days
// before it, 4000 + b × 950 steps (4,950 … 8,750) and no rollover.
const INSTALL_STEPS = 5782;
const INSTALL_ROLLOVER = 200;
const pastSteps = (b: number) => 4000 + b * 950;
const DEMO_DAYS_BACK = [1, 2, 3, 4, 5];

/** The day `b` days before `key`, DST-safe (from noon). */
function before(key: string, b: number): string {
  const noon = parseDay(key);
  noon.setHours(12);
  return dayKey(addDays(noon, -b));
}

/**
 * The demo day logs among `logs`: `remove` (nothing of the user's on them) and `clear` (the user set
 * a day type or workout calories since: only the demo steps and rollover go). Exact values only:
 * - an install day: 5,782 steps and a 200 rollover; or 5,782 steps, no rollover (a device that
 *   pulled the rows: the rollover is never synced) when the two days before hold the seed's 4,950
 *   and 5,900 steps;
 * - each of the five days before an install day, holding exactly its seed steps and no rollover.
 * A day whose steps the user changed no longer matches, and is kept.
 */
export function demoDayLogs(logs: readonly DayLog[]): { remove: string[]; clear: string[] } {
  const byId = new Map(logs.map((l) => [l.id, l]));
  const pastMatches = (install: string, b: number) => {
    const l = byId.get(before(install, b));
    return !!l && l.steps === pastSteps(b) && (l.rollover ?? 0) === 0;
  };
  const demo = new Set<string>();
  for (const l of logs) {
    if (l.steps !== INSTALL_STEPS) continue;
    const rollover = l.rollover ?? 0;
    const install = rollover === INSTALL_ROLLOVER || (rollover === 0 && pastMatches(l.id, 1) && pastMatches(l.id, 2));
    if (!install) continue;
    demo.add(l.id);
    for (const b of DEMO_DAYS_BACK) if (pastMatches(l.id, b)) demo.add(before(l.id, b));
  }
  const remove: string[] = [];
  const clear: string[] = [];
  for (const id of demo) {
    const l = byId.get(id)!;
    const userSet = (l.dayType ?? null) !== null || (l.workoutKcal ?? null) !== null;
    (userSet ? clear : remove).push(id);
  }
  return { remove, clear };
}

/** The demo bookmarks' ids: Clif Bar, Greek yogurt, honey. */
export const DEMO_SAVED_IDS: readonly string[] = ['usda:2708118', 'usda:170894', 'usda:169640'];

/** A demo bookmark: one of those foods, never saved by the user (no `savedAt`: the seed had none). */
export const isDemoSaved = (s: Pick<SavedFood, 'id' | 'savedAt'>): boolean => DEMO_SAVED_IDS.includes(s.id) && s.savedAt == null;

// The foods behind "Recent" on the + menu. Pure (no React / React Native),
// unit-tested in tests/recentFoods.test.mjs.
import type { Food } from '@/data/foods';
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { entryGrams, foodOfEntry } from './measure.ts';

export type RecentFood = { food: Food; grams: number };

/**
 * The database foods the user logged most recently, newest first, one row per
 * food at the amount it was last logged at. What repeats is the database food
 * (its name and values), not the entry's rename or typed-over values. Demo
 * entries and hand-written entries (no database food) never appear.
 */
export function recentFoods(entries: Entry[], limit: number): RecentFood[] {
  const out: RecentFood[] = [];
  const seen = new Set<string>();
  // ISO timestamps: Date.parse, so a zone offset can't change the order.
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  for (const e of newestFirst) {
    if (out.length >= limit) break;
    if (e.seed === true) continue;
    const food = foodOfEntry(e);
    if (!food || seen.has(food.id)) continue;
    seen.add(food.id);
    out.push({ food, grams: entryGrams(e, food) });
  }
  return out;
}

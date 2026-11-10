import { rowToFood, type FoodRow } from '@/lib/foodRow';
import { memoAsync } from '@/lib/memoAsync';
import type { Nutrients } from '@/lib/nutrition';

// Kalo's food database: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), bundled so search works offline.
// Built by scripts/build-usda-foods.mjs.

/** A named amount of a food and what it weighs, e.g. { label: '1 bagel', grams: 105 }. */
export type Portion = { label: string; grams: number };

/** Nutrients are per 100 g; `portions` are the food's USDA portions, default first. */
export type Food = { id: string; name: string; per100g: Nutrients; portions: Portion[] };

/**
 * Loads the database on first use, not at app start: only Food Database needs
 * it. The async import() makes the 1.4 MB JSON its own chunk, fetched when the
 * screen opens (on web; on iOS/Android it's read from the app bundle). A failed
 * load is not cached, so calling again retries.
 */
export const loadFoods = memoAsync(async () => {
  const m = await import('./usda-foods.json');
  // The JSON's rows are typed as plain arrays; they are FoodRow tuples (see the build script).
  const data = ('default' in m ? m.default : m) as unknown as { rows: FoodRow[]; source: string };
  return { foods: data.rows.map(rowToFood), source: data.source };
});

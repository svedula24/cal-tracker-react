import { rowToFood, type FoodRow } from '@/lib/foodRow';
import { memoAsync } from '@/lib/memoAsync';
import type { Nutrients } from '@/lib/nutrition';

// Kalo's food database: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), bundled so search works offline.
// Built by scripts/build-usda-foods.mjs; nutrients are per default serving.
export type Food = { id: string; name: string; serving: string; nutrients: Nutrients };

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

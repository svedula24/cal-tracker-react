import { rowToFood, type FoodRow } from '@/lib/foodRow';
import type { Nutrients } from '@/lib/nutrition';

// Kalo's food database: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), bundled so search works offline.
// Built by scripts/build-usda-foods.mjs; nutrients are per default serving.
export type Food = { id: string; name: string; serving: string; nutrients: Nutrients };

// Built on first use, not at app start: only Food Database needs it. The deferred
// require() means the 1.4 MB JSON module isn't evaluated (and its 13k rows aren't
// mapped) until then. On web the file still downloads with the app bundle.
let db: { foods: Food[]; source: string } | null = null;
function load() {
  if (!db) {
    const { rows, source } = require('./usda-foods.json') as { rows: FoodRow[]; source: string };
    db = { foods: rows.map(rowToFood), source };
  }
  return db;
}

export const getFoods = () => load().foods;
/** Attribution, from the data file the build script wrote. */
export const getFoodDataSource = () => load().source;

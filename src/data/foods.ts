import type { Nutrients } from '@/lib/nutrition';

import { rowToFood, type FoodRow } from '@/lib/foodRow';

import usda from './usda-foods.json';

// Kalo's food database: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), bundled so search works offline.
// Built by scripts/build-usda-foods.mjs; nutrients are per default serving.
export type Food = { id: string; name: string; serving: string; nutrients: Nutrients };

export const foods: Food[] = (usda.rows as FoodRow[]).map(rowToFood);

export const foodById = new Map(foods.map((f) => [f.id, f]));

/** Attribution line for the bundled data. */
export const FOOD_DATA_SOURCE = usda.source;

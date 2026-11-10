// The few USDA foods the demo seed uses, from src/data/seed-foods.json (7 rows,
// written by `npm run build:foods`), so app start never loads the 13k-food file.
import type { Food } from '@/data/foods';
import { rowToFood, type FoodRow } from '@/lib/foodRow';
import { PAST_DAY_SEED, SAVED_SEED_IDS } from '@/lib/seedIds';

import seed from '../data/seed-foods.json';

const byId = new Map((seed.rows as FoodRow[]).map((r) => [r[0], rowToFood(r)]));

// The build script writes every seed id (and a test checks it); an id added to
// seedIds.ts without a rebuild is skipped rather than breaking app start.
export const PAST_DAY_FOODS: [name: string, hour: number, minute: number, food: Food][] = PAST_DAY_SEED.flatMap(
  ([name, hour, minute, fdcId]): [string, number, number, Food][] => {
    const food = byId.get(fdcId);
    return food ? [[name, hour, minute, food]] : [];
  },
);

export const SAVED_FOODS: Food[] = SAVED_SEED_IDS.flatMap((id) => byId.get(id) ?? []);

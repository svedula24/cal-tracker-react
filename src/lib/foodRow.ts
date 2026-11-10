// One compact row of src/data/usda-foods.json → Food. Pure, shared by
// src/data/foods.ts and the unit tests so they can't drift apart.
import type { Food, Portion } from '@/data/foods';

/** [fdcId, name, per-100 g [calories, protein, carbs, fat, fiber, sugar, sodium], portions [[label, grams], …]] */
export type FoodRow = [number, string, [number, number, number, number, number, number, number], [string, number][]];

export const rowToFood = ([fdcId, name, [calories, protein, carbs, fat, fiber, sugar, sodium], portions]: FoodRow): Food => ({
  id: `usda:${fdcId}`,
  name,
  per100g: { calories, protein, carbs, fat, fiber, sugar, sodium },
  portions: portions.map(([label, grams]): Portion => ({ label, grams })),
});

// One compact row of src/data/usda-foods.json → Food. Pure, shared by
// src/data/foods.ts and the unit tests so they can't drift apart.
import type { Food } from '@/data/foods';

export type FoodRow = [number, string, string, number, number, number, number, number, number, number];

export const rowToFood = ([
  fdcId,
  name,
  serving,
  calories,
  protein,
  carbs,
  fat,
  fiber,
  sugar,
  sodium,
]: FoodRow): Food => ({
  id: `usda:${fdcId}`,
  name,
  serving,
  nutrients: { calories, protein, carbs, fat, fiber, sugar, sodium },
});

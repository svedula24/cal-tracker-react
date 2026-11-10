// USDA FoodData Central ids the demo seed uses (src/lib/data.ts). Kept in a pure
// module so tests/seedFoods.test.mjs can check they exist in usda-foods.json
// after every `npm run build:foods`.
export const PAST_DAY_FOODS: [name: string, hour: number, minute: number, id: string][] = [
  ['Oatmeal', 8, 10, 'usda:2708383'],
  ['Banana', 8, 15, 'usda:2709224'],
  ['Chicken Burrito', 13, 0, 'usda:2708546'],
  ['Brown Rice', 19, 5, 'usda:2708410'],
  ['Greek Yogurt (plain)', 21, 0, 'usda:170894'],
];

/** Clif Bar, Greek yogurt, honey. */
export const SAVED_FOOD_IDS = ['usda:2708118', 'usda:170894', 'usda:169640'];

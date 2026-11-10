// USDA FoodData Central ids the demo seed uses. Pure (no imports): read by the app
// (src/lib/seedFoods.ts) and by scripts/build-usda-foods.mjs, which writes these
// foods to src/data/seed-foods.json and fails if any id is missing from the data.

/** Previous five days of demo history: [display name, hour, minute, fdcId]. */
export const PAST_DAY_SEED: [name: string, hour: number, minute: number, fdcId: number][] = [
  ['Oatmeal', 8, 10, 2708383],
  ['Banana', 8, 15, 2709224],
  ['Chicken Burrito', 13, 0, 2708546],
  ['Brown Rice', 19, 5, 2708410],
  ['Greek Yogurt (plain)', 21, 0, 170894],
];

/** Starter saved foods: Clif Bar, Greek yogurt, honey. */
export const SAVED_SEED_IDS = [2708118, 170894, 169640];

export const SEED_FDC_IDS = [...new Set([...PAST_DAY_SEED.map((s) => s[3]), ...SAVED_SEED_IDS])];

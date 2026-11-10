// Pure mapping from the USDA FoodData Central and Open Food Facts API shapes to
// Kalo's Food. No React or React Native imports, so Node can unit-test it
// (tests/foodMappers.test.mjs, `npm test`).
import type { Food } from '@/data/foods';
import type { Nutrients } from '@/lib/nutrition';

// USDA nutrient ids → our fields. Energy has a fallback (Atwater) id for
// Foundation foods that don't report 1008.
const USDA_IDS: Record<keyof Nutrients, number[]> = {
  calories: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005],
  fat: [1004],
  fiber: [1079],
  sugar: [2000, 1063],
  sodium: [1093], // mg
};

// Round to `decimals` places by multiplying (dividing by 0.1 leaves float artifacts like 0.30000000000000004).
export const round = (v: number, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);

export type UsdaFood = { fdcId: number; description: string; foodNutrients?: { nutrientId: number; value?: number }[] };

export function fromUsda(f: UsdaFood): Food | null {
  const values = new Map((f.foodNutrients ?? []).map((n) => [n.nutrientId, n.value]));
  // Without an energy value the food would log as 0 cal; skip it (same rule as Open Food Facts).
  if (!f.description || !USDA_IDS.calories.some((id) => typeof values.get(id) === 'number')) return null;
  const pick = (ids: number[]) => ids.map((id) => values.get(id)).find((v) => typeof v === 'number') ?? 0;
  const n = Object.fromEntries(
    (Object.keys(USDA_IDS) as (keyof Nutrients)[]).map((k) => [k, round(pick(USDA_IDS[k]), k === 'calories' || k === 'sodium' ? 0 : 1)]),
  ) as Nutrients;
  return { id: `usda:${f.fdcId}`, name: titleCase(f.description), serving: '100 g', source: 'usda', nutrients: n };
}

export type OffHit = { code?: string; product_name?: string; brands?: string[] | string; nutriments?: Record<string, number | undefined> };

export function fromOff(h: OffHit): Food | null {
  const m = h.nutriments ?? {};
  const kcal = m['energy-kcal_100g'];
  if (!h.code || !h.product_name || typeof kcal !== 'number') return null; // skip products without calories
  const g = (k: string) => round(m[k] ?? 0, 1);
  const brand = Array.isArray(h.brands) ? h.brands[0] : h.brands?.split(',')[0];
  return {
    id: `off:${h.code}`,
    name: h.product_name.trim(),
    brand: brand?.trim() || undefined,
    serving: '100 g',
    source: 'off',
    nutrients: {
      calories: round(kcal),
      protein: g('proteins_100g'),
      carbs: g('carbohydrates_100g'),
      fat: g('fat_100g'),
      fiber: g('fiber_100g'),
      sugar: g('sugars_100g'),
      sodium: round((m['sodium_100g'] ?? 0) * 1000), // g → mg
    },
  };
}

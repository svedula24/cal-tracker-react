// Saved foods keep a snapshot of the food, so a USDA data refresh can't lose a
// bookmark or turn it into a different food. Pure, so tests/savedFoods.test.mjs
// can check it.
import type { Food } from '@/data/foods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { NUTRIENT_KEYS } from './nutrition.ts';

export type SavedFood = { id: string; food: Food };

/**
 * A food that can be shown and logged: id and name, every per-100 g nutrient a
 * finite number (else totals would turn NaN), portions { label, grams > 0 }.
 * Also guards data arriving from outside the app (a route param, storage).
 */
export const isFood = (x: unknown): x is Food => {
  const f = x as Food | null;
  return (
    !!f &&
    typeof f.id === 'string' &&
    f.id !== '' &&
    typeof f.name === 'string' &&
    f.name !== '' &&
    !!f.per100g &&
    NUTRIENT_KEYS.every((k) => Number.isFinite(f.per100g[k])) &&
    Array.isArray(f.portions) &&
    f.portions.every((p) => !!p && typeof p.label === 'string' && Number.isFinite(p.grams) && p.grams > 0)
  );
};

/** A food passed as a route param (JSON), if it is valid; the URL may have been cut or edited. */
export function parseFood(param: string | undefined): Food | null {
  if (!param) return null;
  try {
    const f: unknown = JSON.parse(param);
    return isFood(f) ? f : null;
  } catch {
    return null;
  }
}

/** A saved entry whose snapshot is a valid food with the entry's id (rows are keyed and removed by it). */
export const isSavedFood = (s: unknown): s is SavedFood => {
  const e = s as SavedFood | null;
  return !!e && typeof e.id === 'string' && isFood(e.food) && e.food.id === e.id;
};

/**
 * One-time cleanup of stored saved foods, run when they load (src/lib/store.ts).
 * Entries from older builds (ids only, or snapshots in an older shape) and
 * anything malformed are dropped; ids are de-duplicated. Returns the same array
 * when nothing changes, so storage isn't rewritten.
 */
export function migrateSavedFoods(items: unknown[]): SavedFood[] {
  const kept = new Map<string, SavedFood>(); // first entry per id wins
  for (const s of items) if (isSavedFood(s) && !kept.has(s.id)) kept.set(s.id, s);
  return kept.size === items.length ? (items as SavedFood[]) : [...kept.values()];
}

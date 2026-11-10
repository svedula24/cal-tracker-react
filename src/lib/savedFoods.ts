// Saved foods keep a snapshot of the food, so a USDA data refresh can't lose a
// bookmark or turn it into a different food. Pure, so tests/savedFoods.test.mjs
// can check it.
import type { Food } from '@/data/foods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { NUTRIENT_KEYS } from './nutrition.ts';

export type SavedFood = { id: string; food: Food };

/**
 * A saved entry whose snapshot can be shown, removed and logged: the snapshot's
 * id matches the entry (rows are keyed and removed by it), it has a name and a
 * serving, and every nutrient is a finite number (else totals would turn NaN).
 */
export const isSavedFood = (s: unknown): s is SavedFood => {
  const e = s as SavedFood | null;
  const f = e?.food;
  return (
    !!f &&
    typeof e.id === 'string' &&
    f.id === e.id &&
    typeof f.name === 'string' &&
    typeof f.serving === 'string' &&
    !!f.nutrients &&
    NUTRIENT_KEYS.every((k) => Number.isFinite(f.nutrients[k]))
  );
};

/**
 * One-time cleanup of stored saved foods, run when they load (src/lib/store.ts).
 * Builds before snapshots (`main`'s original seed: { id: 'honey' } …) stored ids
 * of the old hand-written list, which no USDA food matches, so entries without a
 * usable snapshot are dropped, as is anything malformed; ids are de-duplicated.
 * Returns the same array when nothing changes, so storage isn't rewritten.
 */
export function migrateSavedFoods(items: unknown[]): SavedFood[] {
  const kept = new Map<string, SavedFood>(); // first entry per id wins
  for (const s of items) if (isSavedFood(s) && !kept.has(s.id)) kept.set(s.id, s);
  return kept.size === items.length ? (items as SavedFood[]) : [...kept.values()];
}

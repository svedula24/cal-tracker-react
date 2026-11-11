// A food's portions as the app shows them: the default serving first. The same
// rule as `portionsOf` in scripts/usda/map.mjs (which builds the bundled list),
// applied to portions that arrive from the foods API ordered by gram weight.
// Pure, unit-tested in tests/portions.test.mjs.
import type { Portion } from '@/data/foods';

// Portions that are real but make poor defaults; used only when nothing else
// exists. Keep in sync with AVOID in scripts/usda/map.mjs.
const AVOID = /guideline amount|\bfl oz\b|as ingredient|\bspray\b|miniature|\bnlea\b|\bpackage\b|\bcontainer \(.*lb/i;

const MAX_PORTIONS = 8;

// 1 decimal, or 2 under a gram (a saccharin tablet is 0.04 g), as the mapper rounds.
const roundGrams = (g: number): number => {
  const f = g < 1 ? 100 : 10;
  return Math.round(g * f) / f;
};

/**
 * The default first: of the portions that are not poor defaults ("1 fl oz",
 * "Guideline amount…"), the one closest to 100 g (honey → 1 tbsp, not 1 cup);
 * if all are poor, the closest of all. Ties keep the given order. The rest
 * follow in the given order, at most 8 in total. Grams are rounded; a portion
 * that has no usable weight (rounds to 0, or is not a number) is left out.
 */
export function orderPortions(portions: Portion[]): Portion[] {
  const candidates: Portion[] = [];
  for (const p of portions) {
    if (!Number.isFinite(p.grams)) continue;
    const grams = roundGrams(p.grams);
    if (grams > 0) candidates.push({ label: p.label, grams });
  }
  if (!candidates.length) return [];
  const good = candidates.filter((c) => !AVOID.test(c.label));
  let first: Portion | undefined;
  // Strict "<" keeps the earlier of two equally close portions.
  for (const c of good.length ? good : candidates) {
    if (!first || Math.abs(c.grams - 100) < Math.abs(first.grams - 100)) first = c;
  }
  return [first!, ...candidates.filter((c) => c !== first)].slice(0, MAX_PORTIONS);
}

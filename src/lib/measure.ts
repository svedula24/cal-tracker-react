// Measurements and the nutrition math behind them. Pure (no React / React
// Native), unit-tested in tests/measure.test.mjs. Nutrients are stored per
// 100 g, so any amount is exact: per100g × grams / 100.
import type { Food, Portion } from '@/data/foods';
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { NUTRIENT_KEYS, type Nutrients } from './nutrition.ts';

/** The measure every logged food uses: its quantity is a number of grams. */
export const G: Portion = { label: 'g', grams: 1 };
/** The serving of a food that has no USDA portions. */
export const HUNDRED_G: Portion = { label: '100 g', grams: 100 };
/** One avoirdupois ounce. */
export const OZ: Portion = { label: 'oz', grams: 28.349523125 };

/**
 * The units a food's amount can be typed in: grams, ounces, then the food's own
 * portions ("1 banana", "1 cup, sliced"), default first as the food lists them.
 * The amount is `quantity × unit.grams`.
 */
export const unitsOf = (food: Food): Portion[] => [
  G,
  OZ,
  ...food.portions.filter((p) => p.grams > 0 && !SAME_AS_G_OR_OZ.test(p.label.trim())),
];

// USDA lists "1 oz" as a portion of about 1,600 foods (almonds: 28.4 g): the oz chip already is one.
const SAME_AS_G_OR_OZ = /^(1\s*)?(g|oz)$/i;

/** Two units are the same when they have the same label and weight (stored entries hold copies). */
export const sameUnit = (a: Portion, b: Portion): boolean => a.label === b.label && Math.abs(a.grams - b.grams) < 1e-6;

/**
 * The unit the Nutrition screen starts in: the one a logged entry was measured
 * in, when the food still offers it; otherwise grams (a new food, or an entry
 * measured in something the food no longer lists).
 */
export function unitOf(entry: Entry | undefined, food: Food): Portion {
  const measure = entry?.measure;
  return (measure && unitsOf(food).find((u) => sameUnit(u, measure))) || G;
}

/** The food's default serving: its first portion, else 100 g. */
export const defaultServing = (food: Food): Portion => food.portions[0] ?? HUNDRED_G;

/**
 * The grams the Nutrition screen starts at: for a new food, its default
 * serving; for a logged entry, what it already stands for (its measure, or
 * the default serving when an older entry has none, × its quantity). Exact;
 * the field rounds for display.
 */
export function entryGrams(entry: Entry | undefined, food: Food): number {
  if (!entry) return defaultServing(food).grams;
  const per = entry.measure?.grams ?? defaultServing(food).grams;
  const grams = per * entry.servings;
  return grams > 0 ? grams : defaultServing(food).grams;
}

/** Nutrients in `grams` of a food. Exact; round only for display. */
export const scale = (per100g: Nutrients, grams: number): Nutrients =>
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, (per100g[k] * grams) / 100])) as Nutrients;

/**
 * The database food behind a logged entry (null for hand-written entries), under
 * its database name even after the entry was renamed and with its database
 * values even after the entry's were typed over, so a bookmark saves the food,
 * not the user's label or edits.
 */
export const foodOfEntry = (e: Entry): Food | null =>
  e.per100g && e.portions && e.foodId
    ? { id: e.foodId, name: e.foodName ?? e.name, per100g: e.foodPer100g ?? e.per100g, portions: e.portions }
    : null;

/** `quantity` × a per-measure nutrient set. */
export const times = (n: Nutrients, quantity: number): Nutrients =>
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, n[k] * quantity])) as Nutrients;

/**
 * A typed number: digits with one "." or "," (a comma is a decimal point,
 * "1,5", unless it groups thousands, "1,000"), not negative, kept to 2
 * decimals. No upper bound, except that the value must print back (qtyText) as
 * plain digits the field accepts again; from 1e21 JS prints an exponent. Null
 * when invalid, so a typo can't become a day's total.
 */
export function parseValue(text: string): number | null {
  const t = text.trim();
  if (!/^[\d.,]+$/.test(t)) return null;
  const normalized = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  if (!/^\d*\.?\d+$/.test(normalized) && !/^\d+\.$/.test(normalized)) return null;
  const n = Math.round(Number(normalized) * 100) / 100; // round first: "0.004" is 0
  return Number.isFinite(n) && !String(n).includes('e') ? n : null;
}

/** A typed quantity (grams, servings): a typed number above 0. */
export function parseQty(text: string): number | null {
  const n = parseValue(text);
  return n !== null && n > 0 ? n : null;
}

/**
 * A per-unit nutrient set after the user types `shown` for one nutrient while
 * the screen shows `quantity` units: the nutrient becomes shown / quantity per
 * unit, so the card reads back what was typed and still scales with the amount.
 */
export const withValue = (perUnit: Nutrients, key: keyof Nutrients, shown: number, quantity: number): Nutrients => ({
  ...perUnit,
  [key]: shown / quantity,
});

/**
 * An entry's per-100 g values after some were typed over: only the edited
 * nutrients are replaced (per gram × 100), so the others stay exactly as stored.
 */
export const editedPer100g = (per100g: Nutrients, perGram: Nutrients, edited: Iterable<keyof Nutrients>): Nutrients => {
  const out = { ...per100g };
  for (const key of edited) out[key] = perGram[key] * 100;
  return out;
};

/**
 * What typing `text` into a value field means: the number to apply, or null
 * for no change (an invalid draft, or nothing to do). Typing back exactly what
 * the field showed when it took focus ("0.7" for 0.74) is not an edit: the
 * exact value at focus is kept, or restored if something else was typed since.
 */
export function typedValue(text: string, atFocus: { text: string; value: number }, current: number): number | null {
  const n = parseValue(text);
  if (n === null) return null;
  if (text.trim() !== atFocus.text) return n;
  return current !== atFocus.value ? atFocus.value : null;
}

/** The quantity as shown in the field: "1", "1.5", "0.33". */
export const qtyText = (n: number): string => String(Math.round(n * 100) / 100);

/** Display rounding: whole numbers, except one decimal under 10 (so 0.3 g isn't shown as 0). */
export const fmt = (v: number): string => (Math.abs(v) < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v)));

/** What a list row shows: "1 bagel (105 g)" and the nutrients of that serving. */
export function servingSummary(food: Food): { serving: string; nutrients: Nutrients } {
  const p = defaultServing(food);
  const serving = p === HUNDRED_G ? p.label : `${p.label} (${fmt(p.grams)} g)`;
  return { serving, nutrients: scale(food.per100g, p.grams) };
}

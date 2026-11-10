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
 * its database name even after the entry was renamed, so a bookmark saves the
 * food, not the user's label.
 */
export const foodOfEntry = (e: Entry): Food | null =>
  e.per100g && e.portions && e.foodId ? { id: e.foodId, name: e.foodName ?? e.name, per100g: e.per100g, portions: e.portions } : null;

/** `quantity` × a per-measure nutrient set. */
export const times = (n: Nutrients, quantity: number): Nutrients =>
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, n[k] * quantity])) as Nutrients;

export const MAX_QTY = 10000;

/**
 * A typed quantity: digits with one "." or "," (a comma is a decimal point,
 * "1,5", unless it groups thousands, "1,000"), positive, at most MAX_QTY, kept
 * to 2 decimals. Null when invalid, so a typo can't become a day's total.
 */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (!/^[\d.,]+$/.test(t)) return null;
  const normalized = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  if (!/^\d*\.?\d+$/.test(normalized) && !/^\d+\.$/.test(normalized)) return null;
  const n = Math.round(Number(normalized) * 100) / 100; // round first: "0.004" is 0, not a quantity
  return n > 0 && n <= MAX_QTY ? n : null;
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

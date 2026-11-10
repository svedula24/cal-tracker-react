// Measurements and the nutrition math behind them. Pure (no React / React
// Native), unit-tested in tests/measure.test.mjs. Nutrients are stored per
// 100 g, so any amount is exact: per100g × grams × quantity / 100.
import type { Food, Portion } from '@/data/foods';
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { NUTRIENT_KEYS, type Nutrients } from './nutrition.ts';

export const OZ_GRAMS = 28.3495;
export const OZ: Portion = { label: 'Oz', grams: OZ_GRAMS };
export const G: Portion = { label: 'G', grams: 1 };
/** The serving of a food that has no USDA portions. */
export const HUNDRED_G: Portion = { label: '100 g', grams: 100 };

/** The food's default serving: its first portion, else 100 g. */
export const defaultServing = (food: Food): Portion => food.portions[0] ?? HUNDRED_G;

/** Chip text for a measurement: "1 bagel" → "Bagel", "1 large (4-1/2\" dia)" → "Large (4-1/2\" dia)", "0.5 cup" stays. */
export function chipLabel(p: Portion): string {
  const text = p.label.replace(/^1 (?=\D)/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The measurements to offer: the food's named portions (or 100 g when it has
 * none), then ounces and grams, unless a USDA portion already is 1 oz / 1 g
 * (that one keeps USDA's weight; no duplicate chip).
 */
export function measurementsFor(portions: Portion[]): Portion[] {
  const named = portions.length ? portions : [HUNDRED_G];
  const have = new Set(named.map((p) => chipLabel(p).toLowerCase()));
  return [...named, ...[OZ, G].filter((u) => !have.has(u.label.toLowerCase()))];
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
  const n = Number(normalized);
  return n > 0 && n <= MAX_QTY ? Math.round(n * 100) / 100 : null;
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

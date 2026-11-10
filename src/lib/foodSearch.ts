// Online food search: USDA FoodData Central (generic foods, lab-measured) and
// Open Food Facts (packaged/branded products, crowdsourced). Both are called
// straight from the app; there is no Kalo backend. Values are per 100 g.
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { Food } from '@/data/foods';
import type { Nutrients } from '@/lib/nutrition';

// A free key from https://api.data.gov/signup (1,000 requests/hour). It ships
// inside the app, which is what api.data.gov keys are for. DEMO_KEY works but
// allows only a few requests per hour.
const USDA_KEY = process.env.EXPO_PUBLIC_USDA_API_KEY || 'DEMO_KEY';
const USDA_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const OFF_URL = 'https://search.openfoodfacts.org/search';
const PAGE = 12;

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
const round = (v: number, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);

type UsdaFood = { fdcId: number; description: string; foodNutrients?: { nutrientId: number; value?: number }[] };

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

type OffHit = { code?: string; product_name?: string; brands?: string[] | string; nutriments?: Record<string, number | undefined> };

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

async function searchUsda(q: string, signal: AbortSignal): Promise<Food[]> {
  // Generic foods only; Open Food Facts covers branded products.
  const url = `${USDA_URL}?api_key=${USDA_KEY}&pageSize=${PAGE}&dataType=Foundation,SR%20Legacy&query=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.status === 429 ? 'USDA (hourly limit reached)' : 'USDA');
  const data: { foods?: UsdaFood[] } = await res.json();
  // Foundation and SR Legacy often list the same food twice; keep the first of each name.
  const byName = new Map<string, Food>();
  for (const f of (data.foods ?? []).map(fromUsda)) {
    if (f && !byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f);
  }
  return [...byName.values()];
}

async function searchOff(q: string, signal: AbortSignal): Promise<Food[]> {
  const url = `${OFF_URL}?page_size=${PAGE}&fields=code,product_name,brands,nutriments&q=${encodeURIComponent(q)}`;
  // Open Food Facts asks native apps to identify themselves. On web the header
  // would trigger a CORS preflight the server rejects, and browsers send their own.
  const headers = Platform.OS === 'web' ? undefined : { 'User-Agent': 'Kalo/0.1 (calorie tracker prototype)' };
  const res = await fetch(url, { signal, headers });
  if (!res.ok) throw new Error('Open Food Facts');
  const data: { hits?: OffHit[] } = await res.json();
  return (data.hits ?? []).map(fromOff).filter((f): f is Food => !!f);
}

// search.openfoodfacts.org sends no CORS header, so browsers can't call it: the web
// preview searches USDA only. EXPO_PUBLIC_OFF_ON_WEB=1 (set only by `npm run verify`,
// whose flows mock the API) turns it on for web at build time; it's inlined, not a runtime switch.
export const OFF_ENABLED = Platform.OS !== 'web' || process.env.EXPO_PUBLIC_OFF_ON_WEB === '1';

// Same query (any case) → same results, so retyping doesn't spend the USDA hourly limit.
// Keeps the 50 most recently used queries (a Map iterates in insertion order).
const CACHE_MAX = 50;
const cache = new Map<string, Food[]>();
function cacheGet(key: string) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // mark as most recently used
  }
  return hit;
}
function cacheSet(key: string, foods: Food[]) {
  cache.delete(key);
  cache.set(key, foods);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export type RemoteSearch = { foods: Food[]; loading: boolean; errors: string[] };
type State = RemoteSearch & { key: string }; // key = the query these results belong to

/** Debounced search across both databases; a failing source doesn't hide the other's results. */
export function useRemoteFoodSearch(query: string): RemoteSearch {
  const q = query.trim();
  const key = q.toLowerCase();
  const [state, setState] = useState<State>({ key: '', foods: [], loading: false, errors: [] });

  useEffect(() => {
    if (q.length < 2) {
      setState({ key, foods: [], loading: false, errors: [] });
      return;
    }
    const hit = cacheGet(key);
    if (hit) {
      setState({ key, foods: hit, loading: false, errors: [] });
      return;
    }
    const ctrl = new AbortController();
    setState({ key, foods: [], loading: true, errors: [] });
    const timer = setTimeout(async () => {
      const sources = [
        { name: 'USDA', run: searchUsda },
        ...(OFF_ENABLED ? [{ name: 'Open Food Facts', run: searchOff }] : []),
      ];
      const results = await Promise.allSettled(sources.map((src) => src.run(q, ctrl.signal)));
      if (ctrl.signal.aborted) return;
      const foods = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      // Name the source that failed; network errors (offline, CORS on web) carry no useful message.
      const errors = results.flatMap((r, i) =>
        r.status === 'rejected' ? [r.reason instanceof Error && r.reason.message.startsWith(sources[i].name) ? r.reason.message : sources[i].name] : [],
      );
      if (!errors.length) cacheSet(key, foods); // never cache a partial (failed) result
      setState({ key, foods, loading: false, errors });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, key]);

  // On the render right after the query changes, the effect hasn't run yet: report
  // loading and hide the old query's results, so neither "No foods match" nor stale
  // rows show for that frame.
  if (state.key !== key) return { foods: [], loading: q.length >= 2, errors: [] };
  return { foods: state.foods, loading: state.loading, errors: state.errors };
}

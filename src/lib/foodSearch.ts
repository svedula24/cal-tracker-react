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

const round = (v: number, step = 1) => Math.round(v / step) * step;
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);

type UsdaFood = { fdcId: number; description: string; foodNutrients?: { nutrientId: number; value?: number }[] };

export function fromUsda(f: UsdaFood): Food | null {
  const values = new Map((f.foodNutrients ?? []).map((n) => [n.nutrientId, n.value]));
  // Without an energy value the food would log as 0 cal; skip it (same rule as Open Food Facts).
  if (!f.description || !USDA_IDS.calories.some((id) => typeof values.get(id) === 'number')) return null;
  const pick = (ids: number[]) => ids.map((id) => values.get(id)).find((v) => typeof v === 'number') ?? 0;
  const n = Object.fromEntries(
    (Object.keys(USDA_IDS) as (keyof Nutrients)[]).map((k) => [k, round(pick(USDA_IDS[k]), k === 'calories' || k === 'sodium' ? 1 : 0.1)]),
  ) as Nutrients;
  return { id: `usda:${f.fdcId}`, name: titleCase(f.description), serving: '100 g', source: 'usda', nutrients: n };
}

type OffHit = { code?: string; product_name?: string; brands?: string[] | string; nutriments?: Record<string, number | undefined> };

export function fromOff(h: OffHit): Food | null {
  const m = h.nutriments ?? {};
  const kcal = m['energy-kcal_100g'];
  if (!h.code || !h.product_name || typeof kcal !== 'number') return null; // skip products without calories
  const g = (k: string) => round(m[k] ?? 0, 0.1);
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
  const seen = new Set<string>();
  return (data.foods ?? [])
    .map(fromUsda)
    .filter((f): f is Food => !!f && !seen.has(f.name.toLowerCase()) && !!seen.add(f.name.toLowerCase()));
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
// preview searches USDA only. The e2e suite sets __KALO_OFF_ON_WEB to test it behind mocks.
export const offOnWeb = () => !!(globalThis as { __KALO_OFF_ON_WEB?: boolean }).__KALO_OFF_ON_WEB;
const offAvailable = () => Platform.OS !== 'web' || offOnWeb();

// Same query (any case) → same results, so retyping doesn't spend the USDA hourly limit.
const cache = new Map<string, Food[]>();

export type RemoteSearch = { foods: Food[]; loading: boolean; errors: string[] };

/** Debounced search across both databases; a failing source doesn't hide the other's results. */
export function useRemoteFoodSearch(query: string): RemoteSearch {
  const q = query.trim();
  const [state, setState] = useState<RemoteSearch>({ foods: [], loading: false, errors: [] });

  useEffect(() => {
    if (q.length < 2) {
      setState({ foods: [], loading: false, errors: [] });
      return;
    }
    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit) {
      setState({ foods: hit, loading: false, errors: [] });
      return;
    }
    const ctrl = new AbortController();
    // Clear the previous query's results so they can't be tapped under the new search.
    setState({ foods: [], loading: true, errors: [] });
    const timer = setTimeout(async () => {
      const sources = [
        { name: 'USDA', run: searchUsda },
        ...(offAvailable() ? [{ name: 'Open Food Facts', run: searchOff }] : []),
      ];
      const results = await Promise.allSettled(sources.map((src) => src.run(q, ctrl.signal)));
      if (ctrl.signal.aborted) return;
      const foods = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      // Name the source that failed; network errors (offline, CORS on web) carry no useful message.
      const errors = results.flatMap((r, i) =>
        r.status === 'rejected' ? [r.reason instanceof Error && r.reason.message.startsWith(sources[i].name) ? r.reason.message : sources[i].name] : [],
      );
      if (!errors.length) cache.set(key, foods); // never cache a partial (failed) result
      setState({ foods, loading: false, errors });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  return state;
}

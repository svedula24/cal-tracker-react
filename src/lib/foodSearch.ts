// Online food search: USDA FoodData Central (generic foods, lab-measured) and
// Open Food Facts (packaged/branded products, crowdsourced). Both are called
// straight from the app; there is no Kalo backend. Values are per 100 g.
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { Food } from '@/data/foods';
import { fromOff, fromUsda, type OffHit, type UsdaFood } from '@/lib/foodMappers';

// A free key from https://api.data.gov/signup (1,000 requests/hour). It ships
// inside the app, which is what api.data.gov keys are for. DEMO_KEY works but
// allows only a few requests per hour.
const USDA_KEY = process.env.EXPO_PUBLIC_USDA_API_KEY || 'DEMO_KEY';
const USDA_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const OFF_URL = 'https://search.openfoodfacts.org/search';
const PAGE = 12;

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

/** `stale`: `foods` belong to the previous query and are shown (disabled) until the new results arrive. */
export type RemoteSearch = { foods: Food[]; loading: boolean; errors: string[]; stale: boolean };
type State = { key: string; foods: Food[]; loading: boolean; errors: string[] }; // key = the query `foods` belong to

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
    // Keep the previous results (and their key) on screen while this query loads.
    setState((s) => ({ ...s, loading: true, errors: [] }));
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

  if (q.length < 2) return { foods: [], loading: false, errors: [], stale: false };
  // Results for an older query: keep showing them so the list doesn't jump while
  // typing, but flagged stale (the screen disables them) and still loading, so
  // "No foods match" can't show before the current query's results arrive.
  if (state.key !== key) return { foods: state.foods, loading: true, errors: [], stale: state.foods.length > 0 };
  return { foods: state.foods, loading: state.loading, errors: state.errors, stale: false };
}

import { useEffect, useRef, useState } from 'react';

import { type Food, loadFoods } from '@/data/foods';
import { API_URL } from '@/lib/config';
import { createFoodIndex } from '@/lib/foodIndex';
import { createFoodSearch, type SearchState } from '@/lib/foodSearch';
import { searchFoodsApi } from '@/lib/foodsApi';

// The bundled list (~13k USDA foods, searched in memory, offline), indexed on
// first use and kept across opens, so the screen never re-shows its spinner.
type Bundled = { search(q: string): Food[]; count: string; source: string };
let built: Bundled | null = null;

async function build(): Promise<Bundled> {
  const { foods, source } = await loadFoods();
  if (!built) {
    const search = createFoodIndex(foods);
    built = { search: (q) => search(q), count: foods.length.toLocaleString('en-US'), source };
  }
  return built;
}

// The timeout returns to the event loop first, so the heavy work (on
// iOS/Android the bundled JSON is evaluated synchronously) can't run before the
// screen's next frame is committed.
const loadBundled = () => (built ? Promise.resolve(built) : new Promise<void>((r) => setTimeout(r, 0)).then(build));

/** What the screen shows of the bundled list once it is loaded. */
type BundledInfo = { count: string; source: string } | null;
const info = (): BundledInfo => built && { count: built.count, source: built.source };

/**
 * Food Database's search. With EXPO_PUBLIC_API_URL it asks the foods API and
 * falls back to the bundled list when the API can't be reached (the list is
 * only loaded then). Without it the bundled list loads when the screen opens
 * and answers every query. One controller per mount (see foodSearch.ts).
 */
export function useFoodSearch(query: string) {
  const [view, setView] = useState<{ state: SearchState; bundled: BundledInfo }>(() => ({
    state: { query: '', results: [], status: API_URL || built ? 'idle' : 'loading', source: API_URL ? 'api' : 'bundled' },
    bundled: info(),
  }));
  const controller = useRef<ReturnType<typeof createFoodSearch> | null>(null);

  useEffect(() => {
    const url = API_URL;
    const search = createFoodSearch({
      remote: url ? (q, signal) => searchFoodsApi(url, q, { signal }) : undefined,
      local: loadBundled,
      onState: (state) => setView({ state, bundled: info() }),
    });
    controller.current = search;
    return () => {
      search.dispose(); // aborts the request in flight, clears the timers
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    controller.current?.setQuery(query);
  }, [query]);

  return {
    ...view.state,
    /** Whether searches go to the API (while it can be reached). */
    remote: API_URL !== null,
    /** The bundled list's size and attribution; null until it has loaded. */
    bundled: view.bundled,
    retry: () => controller.current?.retry(),
  };
}

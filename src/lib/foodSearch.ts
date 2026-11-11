// The Food Database search: which source answers a query, and when. Pure (no
// React / React Native), so Node can unit-test it with fake timers:
// tests/foodSearch.test.mjs.
//
// With `remote` (the foods API): a query is debounced, the previous request is
// aborted and late responses are ignored. Recent answers are cached, so a query
// seen before (a backspace) is answered at once, with no request. A request that fails or takes longer
// than `timeoutMs` falls back to the bundled list, and the controller stays on
// that list for the rest of its life (no timeout on every keystroke). If the
// bundled list cannot load either, the state is 'failed' and the API is tried
// again by retry() or the next query.
// Without `remote`: the bundled list loads at once and every query is searched
// synchronously.
import type { Food } from '@/data/foods';

export type SearchState = {
  /** The trimmed query `results` are for (while 'loading', still the previous one). */
  query: string;
  results: Food[];
  /** 'failed': neither source could answer. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** Where `results` came from. */
  source: 'api' | 'bundled';
};

type LocalIndex = { search(q: string): Food[] };
type Shown = Omit<SearchState, 'status'>;

export function createFoodSearch(opts: {
  /** Absent → bundled list only. */
  remote?: (q: string, signal: AbortSignal) => Promise<Food[]>;
  /** Loads the bundled index (memoised by the caller; a rejection may be retried). */
  local: () => Promise<LocalIndex>;
  /**
   * Called on every change. Nothing is emitted at creation: until the first call
   * the state is idle with `remote`, loading without it (the bundled list is on its way).
   */
  onState: (s: SearchState) => void;
  /** Default 150. Applies to remote searches only. */
  debounceMs?: number;
  /** Default 4000. A remote search slower than this counts as unreachable. */
  timeoutMs?: number;
  /** Default 30. How many recent remote answers are kept, by query, for this controller's life. */
  cacheSize?: number;
}): { setQuery(q: string): void; retry(): void; dispose(): void } {
  const { remote, local, onState, debounceMs = 150, timeoutMs = 4000, cacheSize = 30 } = opts;

  let query = '';
  let index: LocalIndex | null = null;
  let loadingLocal = false;
  let useLocal = !remote; // true once the bundled list answers the queries
  let shown: Shown = { query: '', results: [], source: remote ? 'api' : 'bundled' };
  let disposed = false;

  // Successful remote answers by trimmed query, least recently used first (a
  // Map keeps insertion order). Never holds bundled results or failures.
  const cache = new Map<string, Food[]>();
  const remember = (q: string, results: Food[]) => {
    cache.delete(q);
    cache.set(q, results);
    while (cache.size > Math.max(0, cacheSize)) cache.delete(cache.keys().next().value as string);
  };

  // The remote request in progress, if any. `seq` changes whenever it is
  // superseded, so its late answer (or abort error) is ignored.
  let seq = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;

  const emit = (status: SearchState['status'], next: Shown = shown) => {
    shown = next;
    onState({ ...shown, status });
  };

  const cancelRemote = () => {
    seq++;
    clearTimeout(debounce);
    clearTimeout(timeout);
    inflight?.abort();
    inflight = null;
  };

  /** Answers the current query from the loaded bundled index. */
  const searchLocal = (idx: LocalIndex) =>
    query ? emit('ready', { query, results: idx.search(query), source: 'bundled' }) : emit('idle', { query: '', results: [], source: 'bundled' });

  const loadLocal = (announce = true) => {
    if (loadingLocal) return;
    loadingLocal = true;
    if (announce) emit('loading');
    Promise.resolve()
      .then(local)
      .then(
        (idx) => {
          loadingLocal = false;
          if (disposed) return;
          index = idx;
          searchLocal(idx); // the query typed by now, not the one that started the load
        },
        () => {
          loadingLocal = false;
          if (disposed) return;
          useLocal = !remote; // nothing to stay on: with an API, the next attempt asks it again
          // An API search with nothing typed any more has nothing to retry.
          if (remote && !query) emit('idle', { query: '', results: [], source: 'api' });
          else emit('failed', { query, results: [], source: 'bundled' });
        },
      );
  };

  const startRemote = () => {
    if (!remote) return;
    const mine = ++seq;
    const q = query;
    const request = new AbortController();
    inflight = request;
    const fallBack = () => {
      if (mine !== seq) return;
      cancelRemote();
      useLocal = true;
      if (index) searchLocal(index);
      else loadLocal();
    };
    timeout = setTimeout(fallBack, timeoutMs);
    Promise.resolve()
      .then(() => remote(q, request.signal))
      .then((results) => {
        if (mine !== seq) return;
        clearTimeout(timeout);
        inflight = null;
        remember(q, results);
        emit('ready', { query: q, results, source: 'api' });
      }, fallBack);
  };

  if (!remote) loadLocal(false);

  return {
    setQuery(raw) {
      const q = raw.trim();
      if (disposed || q === query) return;
      query = q;
      if (useLocal) {
        // Not loaded yet: the state stays loading (or failed, with its Retry) and
        // the load answers this query when it arrives.
        if (index) searchLocal(index);
        return;
      }
      cancelRemote();
      if (!q) return emit('idle', { query: '', results: [], source: 'api' });
      const cached = cache.get(q);
      if (cached) {
        remember(q, cached); // now the most recently used
        return emit('ready', { query: q, results: cached, source: 'api' });
      }
      emit('loading'); // the previous results stay up meanwhile
      debounce = setTimeout(startRemote, debounceMs);
    },
    retry() {
      if (disposed) return;
      if (useLocal) {
        if (!index) loadLocal();
      } else if (query) {
        cancelRemote();
        emit('loading');
        startRemote();
      }
    },
    dispose() {
      disposed = true;
      cancelRemote();
      cache.clear();
    },
  };
}

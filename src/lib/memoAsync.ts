/**
 * Caches `fn`'s promise so concurrent and later calls share one run. A rejection
 * (or a synchronous throw) is forgotten, so the next call runs `fn` again (a
 * retry). Pure; tested in tests/memoAsync.test.mjs.
 */
export function memoAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= Promise.resolve()
      .then(fn)
      .catch((e: unknown) => {
        pending = null;
        throw e;
      }));
}

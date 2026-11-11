// One-time upgrade of stored entries, run when they load (src/lib/store.ts).
// Pure and Node-importable, so tests/migrateEntries.test.mjs can check it.
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { isUuid, uuid } from './uuid.ts';

/**
 * (1) An entry whose id is not a UUID gets a new one (the server's log ids are
 * client-made UUIDs). (2) An entry from before the `seed` flag is tagged: demo
 * data when it has no food or is not measured in grams (every entry the app logs
 * itself uses the gram measure; hand-written ones exist only as seeds), else the
 * user's. Returns the same array when nothing changes, so storage isn't rewritten.
 */
export function migrateEntries(items: Entry[]): Entry[] {
  let changed = false;
  const next = items.map((e) => {
    const reId = !isUuid(e.id);
    const tag = typeof e.seed !== 'boolean';
    if (!reId && !tag) return e;
    changed = true;
    return {
      ...e,
      id: reId ? uuid() : e.id,
      seed: tag ? !e.foodId || e.measure?.label !== 'g' : e.seed,
    };
  });
  return changed ? next : items;
}

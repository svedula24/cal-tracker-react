// One-time upgrade of stored entries, run when they load (src/lib/store.ts).
// Pure and Node-importable, so tests/migrateEntries.test.mjs can check it.
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { isUuid, uuid } from './uuid.ts';

/**
 * (1) An entry whose id is not a UUID gets a new one (the server's log ids are
 * client-made UUIDs). Nothing stored refers to an entry by id: the id only
 * travels in the Nutrition route's `id` parameter, so the one stale reference
 * possible is a web URL opened before the upgrade, which shows "Entry not found".
 *
 * (2) An entry from before the `seed` flag is tagged: demo data when it has no
 * food or is not measured in grams, else the user's. This is a guess from the
 * entry's shape, since older data did not record where an entry came from:
 * - every entry logged from a food uses the gram measure, and so does a demo
 *   entry of a past day once it was edited (Done rewrites its measure to grams),
 *   so both are the user's;
 * - a hand-written entry has no food, and those exist only as demo data. One
 *   the user edited before this flag existed is still tagged demo, until it is
 *   edited again.
 *
 * Returns the same array when nothing changes, so storage isn't rewritten.
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

/**
 * Demo entries are dropped once the user has any entry of their own (logged on the phone, or pulled
 * from the server, such as an import): from then on they only add made-up food to real days. They
 * were never sent, so there is nothing to delete on the server. Runs at load, after migrateEntries,
 * so the list is saved once. Returns the same array when nothing changes.
 */
export function dropDemoEntries(items: Entry[]): Entry[] {
  if (!items.some((e) => e.seed === true) || !items.some((e) => e.seed !== true)) return items;
  return items.filter((e) => e.seed !== true);
}

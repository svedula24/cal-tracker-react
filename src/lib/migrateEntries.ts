// One-time upgrade of stored entries, run when they load (src/lib/store.ts).
// Pure and Node-importable, so tests/migrateEntries.test.mjs can check it.
import type { Entry } from '@/lib/data';

// Relative with the .ts extension so Node's test runner can import it as well.
import { looksLikeDemoEntry } from './demoData.ts';
import { isUuid, uuid } from './uuid.ts';

/**
 * (1) An entry whose id is not a UUID gets a new one (the server's log ids are
 * client-made UUIDs). Nothing stored refers to an entry by id: the id only
 * travels in the Nutrition route's `id` parameter, so the one stale reference
 * possible is a web URL opened before the upgrade, which shows "Entry not found".
 *
 * (2) An entry from before the `seed` flag is tagged: demo data (which older
 * versions seeded at first launch) when it has no food or is not measured in
 * grams, else the user's. A guess from the entry's shape, since older data did
 * not record where an entry came from: every entry logged from a food uses the
 * gram measure, and a hand-written entry existed only as demo data. Every entry
 * written since carries the flag (false), so the guess only sees old data.
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
    const seed = tag ? !e.foodId || e.measure?.label !== 'g' : e.seed;
    return {
      ...e,
      id: reId ? uuid() : e.id,
      seed,
      // Recorded as a guess: dropDemoEntries drops it only while it still looks like the demo.
      ...(tag && seed ? { seedGuessed: true } : {}),
    };
  });
  return changed ? next : items;
}

/**
 * Drops the demo entries: the user decided that an install shows only their own data, the same as
 * the server. Every entry the app seeded (`seed` true) goes; one migrateEntries only guessed was
 * demo (`seedGuessed`) goes only while it still looks like the demo (a demo name and the seed's
 * servings: looksLikeDemoEntry), so one the user renamed or changed is kept. Demo entries were never
 * sent (entryToLog returns null for them), so there is nothing to delete on the server, and this
 * reports nothing to sync. Runs at load, after migrateEntries, so the list is saved once. Same array
 * when nothing changes.
 */
export function dropDemoEntries(items: Entry[]): Entry[] {
  const isDemo = (e: Entry) => e.seed === true && (e.seedGuessed !== true || looksLikeDemoEntry(e));
  return items.some(isDemo) ? items.filter((e) => !isDemo(e)) : items;
}

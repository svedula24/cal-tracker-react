// Between the app's collections and the sync engine's callbacks (./engine.ts): which local rows
// exist, what each looks like on the wire, and how pulled rows are written back. Pure: no React
// Native, no storage, no clock (the stores arrive through `deps`), so Node can
// unit-test it with fake stores: tests/syncLocal.test.mjs.
//
// Keys are exactly what the server uses: a log's id; a saved food's FoodData Central id as text
// ("2709224" for the saved id `usda:2709224`); a goal row's effective date (also its id here); a
// day's date for its steps.
import type { Food } from '@/data/foods';
import type { DayLog, Entry } from '@/lib/data';
import type { Goals } from '@/lib/nutrition';
import type { SavedFood } from '@/lib/savedFoods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { isSavedFood } from '../savedFoods.ts';
import { dayLogToRow, entryToLog, fdcIdOf, goalsToRow, keyOf, logToEntry, rowToDayLog, rowToGoals, rowToSavedId, savedToRow, tombstone } from './mapping.ts';
import type { SyncChanges, Table } from './types.ts';

/** The part of a Collection (src/lib/store.ts) this file uses. `put` replaces the item with that id, or appends it. */
type Store<T> = { items: T[]; put(item: T): void; remove(id: string): void };

/** `saved_at` of a bookmark made before the app recorded it: fixed, so it is the same on every push. */
const SAVED_AT_UNKNOWN = '2020-01-01T00:00:00.000Z';

const isDay = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isTime = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const allFinite = (o: object): boolean => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));
// Both sides are plain JSON data built by the same functions, so equal data has equal text.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createLocal(deps: {
  entries: Store<Entry>;
  saved: Store<SavedFood>;
  goals: Store<Goals>;
  dayLogs: Store<DayLog>;
  /** A database food by its `usda:<n>` id, for a pulled bookmark (the row carries only the id). */
  findFood: (id: string) => Promise<Food | null>;
}): {
  read: (table: Table, key: string) => object | null;
  all: () => { table: Table; key: string }[];
  apply: (changes: SyncChanges) => void;
  tombstone: (table: Table, key: string) => object;
  keyOf: (table: Table, row: object) => string;
} {
  const { entries, saved, goals, dayLogs, findFood } = deps;

  const byId = <T extends { id: string }>(store: Store<T>, id: string): T | undefined => store.items.find((i) => i.id === id);
  // By number, so the key "7" finds the food however its id was written.
  const savedByKey = (key: string): SavedFood | undefined => saved.items.find((s) => /^\d+$/.test(key) && fdcIdOf(s.id) === Number(key));

  const read = (table: Table, key: string): object | null => {
    switch (table) {
      case 'food_logs': {
        const entry = byId(entries, key);
        return entry ? entryToLog(entry) : null;
      }
      case 'saved_foods': {
        const s = savedByKey(key);
        return s ? savedToRow(s, isTime(s.savedAt) ? s.savedAt : SAVED_AT_UNKNOWN) : null;
      }
      case 'goals': {
        const g = byId(goals, key);
        if (!g || !isDay(g.effectiveDate) || g.effectiveDate !== key) return null;
        const row = goalsToRow(g);
        return allFinite(row) ? row : null;
      }
      case 'daily_activity': {
        const log = byId(dayLogs, key);
        return log && isDay(log.id) && Number.isFinite(log.steps) ? dayLogToRow(log) : null;
      }
      default:
        return null;
    }
  };

  // Demo ENTRIES are left out (entryToLog returns null for them). The seeded goals, day logs
  // (steps) and saved foods are sent on purpose: the user chose to sync them now although they
  // still hold the demo values (Architecture Decision Log, record 22).
  const all = (): { table: Table; key: string }[] => {
    const out: { table: Table; key: string }[] = [];
    for (const e of entries.items) if (entryToLog(e)) out.push({ table: 'food_logs', key: e.id });
    for (const s of saved.items) {
      const fdcId = fdcIdOf(s.id);
      if (fdcId !== null) out.push({ table: 'saved_foods', key: String(fdcId) });
    }
    for (const g of goals.items) if (read('goals', g.id)) out.push({ table: 'goals', key: g.id });
    for (const d of dayLogs.items) if (read('daily_activity', d.id)) out.push({ table: 'daily_activity', key: d.id });
    return out;
  };

  // Bookmarks whose food is being looked up: saved id → the row that asked. A later row for the
  // same id (a newer save, or its deletion) replaces or drops the request, so an old lookup that
  // finishes late stores nothing.
  const lookups = new Map<string, object>();

  /** One bad row is skipped; the rest of the pull is still applied. */
  const each = <Row>(rows: Row[] | undefined, one: (row: Row) => void) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      try {
        one(row);
      } catch {}
    }
  };

  // Writes go straight to the stores: nothing here marks a row dirty, or a pulled row would be
  // sent back. A row equal to what the store holds is not written again (no save, no re-render).
  const apply = (changes: SyncChanges): void => {
    each(changes?.food_logs, (row) => {
      if (typeof row.id !== 'string' || row.id === '') return;
      const existing = byId(entries, row.id);
      // A deleted row has only its key: checked before anything else is read from it.
      if (row.deleted_at != null) {
        if (existing) entries.remove(row.id);
        return;
      }
      if (!isDay(row.log_date) || !isTime(row.logged_at) || typeof row.name !== 'string') return;
      const next = logToEntry(row, existing);
      if (!Number.isFinite(next.servings) || !allFinite(next.nutrients)) return;
      if (!same(existing, next)) entries.put(next);
    });

    each(changes?.saved_foods, (row) => {
      if (!Number.isSafeInteger(row.fdc_id) || row.fdc_id < 0) return;
      const id = rowToSavedId(row);
      if (row.deleted_at != null) {
        lookups.delete(id);
        if (byId(saved, id)) saved.remove(id);
        return;
      }
      if (byId(saved, id) || !isTime(row.saved_at)) return;
      lookups.set(id, row);
      Promise.resolve()
        .then(() => findFood(id))
        .then((food) => {
          if (lookups.get(id) !== row) return;
          lookups.delete(id);
          const item = { id, food, savedAt: row.saved_at };
          // Not found, or bookmarked on the phone in the meantime: nothing to store.
          if (isSavedFood(item) && !byId(saved, id)) saved.put(item);
        })
        .catch(() => {
          if (lookups.get(id) === row) lookups.delete(id);
        });
    });

    // Every goal row is kept (each past day is judged by the goal in force that day), keyed by its
    // effective date. A deleted row is removed.
    each(changes?.goals, (row) => {
      if (!isDay(row.effective_date)) return;
      const existing = byId(goals, row.effective_date);
      if (row.deleted_at != null) {
        if (existing) goals.remove(row.effective_date);
        return;
      }
      if (!allFinite(row) || !['lose', 'maintain', 'gain'].includes(row.goal)) return;
      if (row.source != null && row.source !== 'computed' && row.source !== 'manual') return;
      const next = rowToGoals(row);
      if (!allFinite(next)) return;
      // Compared as rows: a stored row may hold the same values with its fields in another order.
      if (!existing || !same(goalsToRow(existing), goalsToRow(next))) goals.put(next);
    });

    each(changes?.daily_activity, (row) => {
      if (!isDay(row.activity_date)) return;
      const existing = byId(dayLogs, row.activity_date);
      if (row.deleted_at != null) {
        if (existing) dayLogs.remove(row.activity_date);
        return;
      }
      if (!Number.isFinite(row.steps)) return;
      if (row.workout_kcal != null && !Number.isFinite(row.workout_kcal)) return;
      if (row.day_type != null && !['workout', 'active_rest', 'rest'].includes(row.day_type)) return;
      const next = rowToDayLog(row, existing);
      if (!same(existing, next)) dayLogs.put(next);
    });
  };

  return { read, all, apply, tombstone, keyOf };
}

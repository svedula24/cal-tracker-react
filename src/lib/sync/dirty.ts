// Where the data hooks (src/lib/data.ts) report a local write. Its own file, with no React
// Native in it, so data.ts does not import the module that imports data.ts (./index.ts), and so
// Node can unit-test it: tests/syncDirty.test.mjs.
//
// The engine is created a moment after launch (once the stored data has loaded): writes
// reported before then are kept and replayed. Without an API URL nothing is kept at all.

// Relative with the .ts extension so Node's test runner can import it as well.
import { API_URL } from '../config.ts';
import type { Table } from './types.ts';

type Mark = (table: Table, key: string, deleted?: boolean) => void;

let engine: Mark | null = null;
// Latest mark per row, in order: "<table>:<key>" → [table, key, deleted].
const early = new Map<string, [Table, string, boolean]>();

/**
 * A local row was written (`deleted`: removed). Call it AFTER the write: the row is read when it
 * is sent. Synchronous, never throws, and does nothing when the app has no API URL.
 */
export function markDirty(table: Table, key: string, deleted = false): void {
  if (!API_URL) return;
  try {
    if (engine) return engine(table, key, deleted);
    const id = `${table}:${key}`;
    early.delete(id); // re-inserted last: the order of the writes is kept
    early.set(id, [table, key, deleted]);
  } catch {} // a local write never fails because of sync
}

/** The engine exists: it gets the writes reported so far, then every later one. */
export function attachEngine(mark: Mark): void {
  engine = mark;
  for (const [table, key, deleted] of early.values()) {
    try {
      mark(table, key, deleted);
    } catch {}
  }
  early.clear();
}

// The sync engine: which local rows still have to reach the server, and when a
// request is made. Pure (no React / React Native / fetch; everything arrives
// through `opts`), so Node can unit-test it with fake timers:
// tests/syncEngine.test.mjs.
//
// The outbox holds dirty KEYS, not rows: `"<table>:<key>" → { updatedAt, deleted }`.
// The row is read when it is sent, so ten edits of one row send one row. One
// request runs at a time. It pushes up to `batchSize` dirty rows and pulls what
// changed on the server since the cursor; while rows are left, or the server has
// more, the next request follows at once. A failure keeps the outbox and retries
// after `retryMs[attempt]`. A 401 registers again and uploads everything to the
// new account. Nothing is ever thrown to the caller.
//
// Stored (JSON): `sync:outbox` the outbox object, `sync:cursor` a number or
// null, `sync:primed` '1' once the rows that existed before sync were queued.
import { SyncUnauthorized } from './types.ts';
import type { SyncChanges, SyncRequest, SyncResponse, Table } from './types.ts';

type Dirty = { updatedAt: number; deleted: boolean };
type Sent = Dirty & { id: string };

const TABLES: Table[] = ['food_logs', 'saved_foods', 'goals', 'daily_activity'];
const OUTBOX = 'sync:outbox';
const CURSOR = 'sync:cursor';
const PRIMED = 'sync:primed';

/** The stored outbox, or null when it is not one (corrupt: the caller starts over). */
function parseOutbox(raw: string): [string, Dirty][] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, Dirty>);
    const ok = entries.every(([, e]) => e && Number.isFinite(e.updatedAt) && typeof e.deleted === 'boolean');
    // A day's activity was once the table `daily_steps` (same key): an older outbox entry is kept under the new name.
    return ok ? entries.map(([id, e]) => [id.replace(/^daily_steps:/, 'daily_activity:'), { updatedAt: e.updatedAt, deleted: e.deleted }]) : null;
  } catch {
    return null;
  }
}

export function createSync(opts: {
  /** Throws SyncUnauthorized on a 401; any other rejection = the server could not be reached. */
  push: (body: SyncRequest) => Promise<SyncResponse>;
  /** Gets and stores a fresh token (first run, or after a 401). */
  register: () => Promise<void>;
  hasToken: () => Promise<boolean>;
  /** The local row in wire format WITHOUT updated_at/deleted_at; null if it is gone. */
  read: (table: Table, key: string) => object | null;
  /** The key fields of a deleted row. */
  tombstone: (table: Table, key: string) => object;
  /** The key of a pulled row. */
  keyOf: (table: Table, row: object) => string;
  /** Every local row that should be on the server (no demo entries). */
  all: () => { table: Table; key: string }[];
  /** Writes pulled rows into the local store. Must not mark them dirty. */
  apply: (changes: SyncChanges) => void;
  storage: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  /** ms; default Date.now. */
  now?: () => number;
  /** Default 2000: how long after the last local change the push starts. */
  pushDelayMs?: number;
  /** Default [5000, 15000, 60000, 300000]: the wait after each failure in a row; the last value repeats. */
  retryMs?: number[];
  /** Default 400 rows per request. */
  batchSize?: number;
}): {
  /** A local write happened. */
  markDirty(table: Table, key: string, deleted?: boolean): void;
  /** Sync now (app start, app came to the foreground). Also resets the retry delay. */
  kick(): void;
  dispose(): void;
} {
  const { push, register, hasToken, read, tombstone, keyOf, all, apply, storage, now = Date.now, pushDelayMs = 2000, batchSize = 400 } = opts;
  const retryMs = opts.retryMs?.length ? opts.retryMs : [5000, 15000, 60000, 300000];

  const outbox = new Map<string, Dirty>();
  let cursor: number | null = null;
  let primed = false;
  let loaded = false;
  let disposed = false;

  let running = false; // a sync is in progress
  let again = false; // kick() arrived meanwhile: sync once more afterwards
  let attempt = 0; // failures in a row
  // The one pending timer: the push delay, or (`waiting`) the retry after a failure.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;

  // One write at a time per storage key, always of the latest value: a change
  // made during a write is written when that write ends. Nothing before the
  // stored state is loaded (it would overwrite it) and nothing after dispose.
  const saver = (key: string, value: () => string) => {
    let state: 'idle' | 'queued' | 'writing' = 'idle';
    let stale = false;
    const save = () => {
      if (disposed || !loaded || state === 'queued') return;
      if (state === 'writing') return void (stale = true);
      state = 'queued';
      Promise.resolve()
        .then(() => {
          if (disposed) return;
          state = 'writing';
          return storage.set(key, value());
        })
        .catch(() => {}) // not saved: the next change writes it again
        .then(() => {
          state = 'idle';
          if (stale) {
            stale = false;
            save();
          }
        });
    };
    return save;
  };
  const saveOutbox = saver(OUTBOX, () => JSON.stringify(Object.fromEntries(outbox)));
  const saveCursor = saver(CURSOR, () => JSON.stringify(cursor));
  const savePrimed = saver(PRIMED, () => (primed ? '1' : ''));

  // Loads the stored state once. Keys marked dirty before it arrives are merged
  // with it: the newer `updatedAt` per key wins.
  const ready = (async () => {
    // undefined = could not be read, as opposed to null = nothing stored.
    const get = (key: string) => Promise.resolve().then(() => storage.get(key)).catch(() => undefined);
    const [rawOutbox, rawCursor, rawPrimed] = await Promise.all([get(OUTBOX), get(CURSOR), get(PRIMED)]);
    if (disposed) return;
    primed = rawPrimed === '1';
    try {
      const n: unknown = JSON.parse(rawCursor ?? 'null');
      cursor = typeof n === 'number' && Number.isFinite(n) ? n : null;
    } catch {} // corrupt: pull from the start
    const stored = rawOutbox === null ? [] : rawOutbox === undefined ? null : parseOutbox(rawOutbox);
    // Unreadable: what was waiting is unknown, so everything is queued again.
    if (!stored) primed = false;
    const early = outbox.size > 0;
    for (const [id, e] of stored ?? []) {
      const mine = outbox.get(id);
      if (!mine || e.updatedAt > mine.updatedAt) outbox.set(id, e);
    }
    loaded = true;
    if (early) saveOutbox();
  })();

  const clock = () => {
    try {
      const t = now();
      if (Number.isFinite(t)) return t;
    } catch {}
    return Date.now();
  };

  const arm = (ms: number, retry: boolean) => {
    clearTimeout(timer);
    waiting = retry;
    timer = setTimeout(() => {
      timer = undefined;
      waiting = false;
      void run();
    }, ms);
  };

  /** Queues every local row (first run, and after a 401). A key already dirty keeps its own time. */
  const markAll = () => {
    const t = clock();
    for (const { table, key } of all()) {
      const id = `${table}:${key}`;
      if (!outbox.has(id)) outbox.set(id, { updatedAt: t, deleted: false });
    }
  };

  /** The next request: up to `batchSize` dirty rows, read now. `bad` = keys whose row could not be read. */
  const collect = (bad: Set<string>) => {
    const changes: Partial<Record<Table, object[]>> = {};
    const sent: Sent[] = [];
    let dropped = false;
    const max = Math.max(1, batchSize);
    for (const [id, e] of outbox) {
      if (sent.length >= max) break;
      if (bad.has(id)) continue;
      const cut = id.indexOf(':');
      const table = id.slice(0, cut) as Table;
      const key = id.slice(cut + 1);
      const at = new Date(e.updatedAt).toISOString();
      try {
        const row = e.deleted ? tombstone(table, key) : read(table, key);
        if (!row) {
          outbox.delete(id); // gone without a delete: nothing to send
          dropped = true;
          continue;
        }
        (changes[table] ??= []).push({ ...row, updated_at: at, deleted_at: e.deleted ? at : null });
        sent.push({ id, ...e });
      } catch {
        bad.add(id); // stays dirty; the rest still goes
      }
    }
    if (dropped) saveOutbox();
    return { body: { cursor, changes } as SyncRequest, sent };
  };

  /** A successful response: clears what was sent, applies what was pulled, moves the cursor. */
  const settle = (sent: Sent[], res: SyncResponse) => {
    if (typeof res?.cursor !== 'number') throw new Error('malformed sync response');
    // Sent and unchanged since it was read → the server has it (or rejected it,
    // and would again). Edited meanwhile → stays dirty and is sent next.
    let cleared = false;
    for (const s of sent) {
      const e = outbox.get(s.id);
      if (e && e.updatedAt === s.updatedAt && e.deleted === s.deleted) cleared = outbox.delete(s.id);
    }
    if (cleared) saveOutbox();

    // A pulled row older than a local edit still waiting is skipped: the edit
    // is pushed next and wins on the server too.
    const pulled: Record<Table, object[]> = { food_logs: [], saved_foods: [], goals: [], daily_activity: [] };
    let count = 0;
    for (const table of TABLES) {
      for (const row of (res.changes?.[table] ?? []) as { updated_at: string }[]) {
        const e = outbox.get(`${table}:${keyOf(table, row)}`);
        if (e && e.updatedAt > Date.parse(row.updated_at)) continue;
        pulled[table].push(row);
        count++;
      }
    }
    // The cursor moves only after apply: if apply throws, the same rows are pulled again.
    if (count) apply(pulled as SyncChanges);
    if (res.cursor !== cursor) {
      cursor = res.cursor;
      saveCursor();
    }
  };

  /** Requests until nothing is left to send or pull. False (or a throw) = failed: retry later. */
  const cycle = async (): Promise<boolean> => {
    await ready;
    const bad = new Set<string>();
    let reauthed = false; // the previous request was a 401
    for (;;) {
      if (disposed) return true;
      if (!primed) {
        markAll();
        primed = true;
        saveOutbox();
        savePrimed();
      }
      if (!(await hasToken())) {
        if (disposed) return true;
        await register();
      }
      if (disposed) return true;
      const { body, sent } = collect(bad);
      const before = cursor;
      let res: SyncResponse;
      try {
        res = await push(body);
      } catch (e) {
        if (disposed) return true;
        if (!(e instanceof SyncUnauthorized) || reauthed) throw e;
        // The server no longer knows this device: a new account, which has
        // nothing. Unprimed first (and stored), so the upload of everything
        // survives a failed register() or a restart.
        reauthed = true;
        primed = false;
        cursor = null;
        savePrimed();
        saveCursor();
        await register();
        continue;
      }
      if (disposed) return true;
      settle(sent, res);
      reauthed = false;
      attempt = 0;
      let left = false;
      for (const id of outbox.keys()) if (!bad.has(id)) left = true;
      // `has_more` without a cursor that moved would ask the same question forever.
      if (!left && !(res.has_more && cursor !== before)) return bad.size === 0;
    }
  };

  const run = async () => {
    if (disposed) return;
    if (running) return void (again = true);
    running = true;
    again = false;
    clearTimeout(timer);
    timer = undefined;
    waiting = false;
    const ok = await cycle().catch(() => false);
    running = false;
    if (disposed) return;
    if (!ok) {
      again = false;
      arm(retryMs[Math.min(attempt, retryMs.length - 1)], true);
      attempt++;
    } else if (again) void run();
    else if (outbox.size) arm(pushDelayMs, false); // marked in the instant the sync ended
  };

  return {
    markDirty(table, key, deleted = false) {
      if (disposed) return;
      outbox.set(`${table}:${key}`, { updatedAt: clock(), deleted });
      saveOutbox();
      // Running: the sync sends it before it ends. Waiting to retry: that timer sends it.
      if (running || (waiting && timer)) return;
      arm(pushDelayMs, false);
    },
    kick() {
      if (disposed) return;
      attempt = 0;
      void run();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

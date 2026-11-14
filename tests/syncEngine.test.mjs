// The sync engine (src/lib/sync/engine.ts): the outbox, first-run priming, one
// request at a time, batches, the pull filter, backoff, re-registration on a
// 401, dispose. Run: npm test
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { createSync } from '../src/lib/sync/engine.ts';
import { SyncUnauthorized } from '../src/lib/sync/types.ts';

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
});

const T0 = Date.UTC(2026, 10, 10, 12);
const iso = (ms) => new Date(ms).toISOString();
// Lets every settled promise run its handlers (the engine chains quite a few).
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

// The engine does not look inside a row, so every table uses the same toy shape:
// { k: the key, v: a value }. On the wire: plus updated_at and deleted_at.
const row = (k, v, at) => ({ k, v, updated_at: iso(at), deleted_at: null });
const gone = (k, at) => ({ k, updated_at: iso(at), deleted_at: iso(at) });
const none = () => ({ food_logs: [], saved_foods: [], goals: [], daily_activity: [] });
const dirty = (updatedAt, deleted = false) => ({ updatedAt, deleted });
const PRIMED = { 'sync:primed': '1' };

/**
 * An engine over fakes. `rows`: the local store, "<table>:<key>" → v. `stored`:
 * what storage holds at creation (default: already primed). `gate`: a promise
 * the storage reads wait for. Anything else overrides an engine option.
 * t.pushes[i] = { body, resolve, reject }; t.answer(partial response) resolves the last one.
 */
function setup({ rows = {}, stored = PRIMED, token = true, gate, ...opts } = {}) {
  const t = {
    clock: T0,
    rows: new Map(Object.entries(rows)),
    disk: new Map(Object.entries(stored)),
    gets: [],
    writes: [],
    pushes: [],
    applied: [],
    registers: 0,
    registerFails: false,
    token,
  };
  const split = (id) => ({ table: id.slice(0, id.indexOf(':')), key: id.slice(id.indexOf(':') + 1) });
  t.sync = createSync({
    push: (body) => {
      const d = deferred();
      t.pushes.push({ body, ...d });
      return d.promise;
    },
    register: async () => {
      t.registers++;
      if (t.registerFails) throw new Error('offline');
      t.token = true;
    },
    hasToken: async () => t.token,
    read: (table, key) => (t.rows.has(`${table}:${key}`) ? { k: key, v: t.rows.get(`${table}:${key}`) } : null),
    tombstone: (table, key) => ({ k: key }),
    keyOf: (table, r) => r.k,
    all: () => [...t.rows.keys()].map(split),
    apply: (changes) => t.applied.push(changes),
    storage: {
      get: async (key) => {
        t.gets.push(key);
        await gate;
        return t.disk.get(key) ?? null;
      },
      set: async (key, value) => {
        t.writes.push([key, value]);
        t.disk.set(key, value);
      },
    },
    now: () => t.clock,
    ...opts,
  });
  t.answer = async (res = {}) => {
    const p = t.pushes.at(-1);
    p.resolve({ cursor: p.body.cursor ?? 0, has_more: false, rejected: [], ...res, changes: { ...none(), ...res.changes } });
    await flush();
  };
  t.fail = async (error = new Error('offline')) => {
    t.pushes.at(-1).reject(error);
    await flush();
  };
  /** Advances the fake timers, then lets the engine run. */
  t.tick = async (ms) => {
    mock.timers.tick(ms);
    await flush();
  };
  t.bodies = () => t.pushes.map((p) => p.body);
  /** The outbox as stored. */
  t.outbox = () => JSON.parse(t.disk.get('sync:outbox') ?? '{}');
  return t;
}

test('at creation the stored state is read once; nothing is requested or written until kick or markDirty', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  await t.tick(1_000_000);
  assert.deepEqual(t.gets.toSorted(), ['sync:cursor', 'sync:outbox', 'sync:primed']);
  assert.deepEqual([t.pushes.length, t.writes.length, t.registers], [0, 0, 0]);
});

test('first run: every local row is queued with now(), uploaded once, and the flag is stored', async () => {
  const rows = { 'food_logs:a': 1, 'goals:2026-11-01': 2 };
  const t = setup({ stored: {}, rows });
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 1, T0)], goals: [row('2026-11-01', 2, T0)] } }]);
  assert.equal(t.disk.get('sync:primed'), '1');
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0), 'goals:2026-11-01': dirty(T0) });

  await t.answer({ cursor: 2 });
  assert.deepEqual(t.outbox(), {});
  assert.equal(t.disk.get('sync:cursor'), '2');
  assert.deepEqual(t.applied, []);

  // The next launch (same storage): primed, so nothing is uploaded again.
  const next = setup({ stored: Object.fromEntries(t.disk), rows });
  next.sync.kick();
  await flush();
  assert.deepEqual(next.bodies(), [{ cursor: 2, changes: {} }]);
});

test('markDirty: one push, pushDelayMs after the last call; the row is read then, so repeated edits send one row', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.markDirty('food_logs', 'a');
  await t.tick(1999);
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0) }); // stored at once, not after the delay
  t.clock = T0 + 1999;
  t.rows.set('food_logs:a', 2);
  t.sync.markDirty('food_logs', 'a');
  await t.tick(1999);
  assert.equal(t.pushes.length, 0);
  await t.tick(1);
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 2, T0 + 1999)] } }]);
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0 + 1999) }); // still dirty until the server answers
  await t.answer({ cursor: 1 });
  assert.deepEqual(t.outbox(), {});
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 1);
});

test('pushDelayMs is configurable; a deleted key is sent as tombstone() with deleted_at = updated_at', async () => {
  const t = setup({ rows: { 'saved_foods:171705': 1 }, pushDelayMs: 50 });
  t.sync.markDirty('saved_foods', '171705', true);
  t.sync.markDirty('daily_activity', '2026-11-10', true); // no local row: a tombstone needs none
  await t.tick(50);
  assert.deepEqual(t.bodies(), [
    { cursor: null, changes: { saved_foods: [gone('171705', T0)], daily_activity: [gone('2026-11-10', T0)] } },
  ]);
});

test('a dirty key whose row is gone and was not marked deleted is dropped', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.markDirty('food_logs', 'ghost');
  t.sync.markDirty('food_logs', 'a');
  await t.tick(2000);
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 1, T0)] } }]);
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0) });
});

test('without a token the device is registered first, once', async () => {
  const t = setup({ token: false });
  t.sync.kick();
  await flush();
  assert.deepEqual([t.registers, t.pushes.length], [1, 1]);
  await t.answer();
  t.sync.kick();
  await flush();
  assert.deepEqual([t.registers, t.pushes.length], [1, 2]);
});

test('one request at a time: a kick or an edit during a request runs after it, never beside it', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.kick();
  await flush();
  t.sync.kick();
  t.sync.kick();
  t.sync.markDirty('food_logs', 'a');
  await t.tick(10_000);
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: {} }]);

  await t.answer({ cursor: 3 }); // the edit goes out at once…
  assert.deepEqual(t.bodies()[1], { cursor: 3, changes: { food_logs: [row('a', 1, T0)] } });
  assert.equal(t.pushes.length, 2);
  await t.answer({ cursor: 4 }); // …then the remembered kick, once
  assert.deepEqual(t.bodies()[2], { cursor: 4, changes: {} });
  await t.answer({ cursor: 4 });
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 3);
});

test('an edit or a delete made while its row is in flight stays dirty and is sent next', async () => {
  const t = setup({ rows: { 'food_logs:a': 1, 'food_logs:b': 1 } });
  t.sync.markDirty('food_logs', 'a');
  t.sync.markDirty('food_logs', 'b');
  await t.tick(2000);
  assert.deepEqual(t.bodies()[0].changes, { food_logs: [row('a', 1, T0), row('b', 1, T0)] });

  t.sync.markDirty('food_logs', 'b', true); // same millisecond: only `deleted` differs
  t.clock = T0 + 500;
  t.rows.set('food_logs:a', 2);
  t.sync.markDirty('food_logs', 'a');
  await t.answer({ cursor: 5 });
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0 + 500), 'food_logs:b': dirty(T0, true) });
  assert.deepEqual(t.bodies()[1], { cursor: 5, changes: { food_logs: [row('a', 2, T0 + 500), gone('b', T0)] } });
  await t.answer({ cursor: 7 });
  assert.deepEqual(t.outbox(), {});
  assert.equal(t.pushes.length, 2);
});

test('batches: more dirty keys than batchSize go out in consecutive requests, with no delay between them', async () => {
  const rows = { 'food_logs:a': 1, 'food_logs:b': 2, 'food_logs:c': 3, 'food_logs:d': 4, 'goals:e': 5 };
  const t = setup({ stored: {}, rows, batchSize: 2 });
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies()[0], { cursor: null, changes: { food_logs: [row('a', 1, T0), row('b', 2, T0)] } });
  await t.answer({ cursor: 1 }); // no timer is advanced from here on
  assert.deepEqual(Object.keys(t.outbox()), ['food_logs:c', 'food_logs:d', 'goals:e']);
  assert.deepEqual(t.bodies()[1], { cursor: 1, changes: { food_logs: [row('c', 3, T0), row('d', 4, T0)] } });
  await t.answer({ cursor: 2 });
  assert.deepEqual(t.bodies()[2], { cursor: 2, changes: { goals: [row('e', 5, T0)] } });
  await t.answer({ cursor: 3 });
  assert.equal(t.pushes.length, 3);
  assert.deepEqual(t.outbox(), {});
});

test('pull filter: a pulled row older than a pending local edit is skipped; the rest reaches apply as a full SyncChanges', async () => {
  const t = setup({ rows: { 'food_logs:a': 1, 'food_logs:b': 1, 'food_logs:d': 1 } });
  t.sync.kick();
  await flush();
  t.clock = T0 + 1000; // edited while the pull is in flight
  for (const k of ['a', 'b', 'd']) t.sync.markDirty('food_logs', k);

  const older = row('a', 'server', T0 + 999);
  const newer = row('b', 'server', T0 + 1001);
  const same = row('d', 'server', T0 + 1000);
  const fresh = row('c', 'server', T0 - 5000);
  const goal = row('2026-11-01', 'server', T0);
  await t.answer({ cursor: 9, changes: { food_logs: [older, newer, same, fresh], goals: [goal] } });
  assert.deepEqual(t.applied, [{ food_logs: [newer, same, fresh], saved_foods: [], goals: [goal], daily_activity: [] }]);

  // All three local edits are still pushed (the server decides who wins).
  assert.deepEqual(t.bodies()[1], { cursor: 9, changes: { food_logs: [row('a', 1, T0 + 1000), row('b', 1, T0 + 1000), row('d', 1, T0 + 1000)] } });
  await t.answer({ cursor: 12 });
  assert.equal(t.applied.length, 1); // nothing pulled: apply is not called
});

test('apply is not called when every pulled row is filtered out', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.kick();
  await flush();
  t.sync.markDirty('food_logs', 'a');
  await t.answer({ cursor: 2, changes: { food_logs: [row('a', 'server', T0 - 1)] } });
  assert.deepEqual(t.applied, []);
  assert.equal(t.disk.get('sync:cursor'), '2'); // the cursor still moves
});

test('has_more: the next page is pulled at once with the new cursor, which is stored each time', async () => {
  const t = setup();
  t.sync.kick();
  await flush();
  const x = row('x', 1, T0);
  await t.answer({ cursor: 500, has_more: true, changes: { food_logs: [x] } });
  assert.equal(t.disk.get('sync:cursor'), '500');
  assert.deepEqual(t.bodies()[1], { cursor: 500, changes: {} });
  await t.answer({ cursor: 730 });
  assert.equal(t.disk.get('sync:cursor'), '730');
  assert.deepEqual([t.pushes.length, t.applied.length], [2, 1]);

  // A server that says has_more without moving the cursor is not asked forever.
  t.sync.kick();
  await flush();
  await t.answer({ cursor: 730, has_more: true });
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 3);
});

test('a rejected key leaves the outbox and is not sent again; one edited meanwhile gets one more try', async () => {
  const t = setup({ rows: { 'food_logs:a': 1, 'food_logs:b': -1 } });
  t.sync.markDirty('food_logs', 'a');
  t.sync.markDirty('food_logs', 'b');
  await t.tick(2000);
  await t.answer({ cursor: 1, rejected: [{ table: 'food_logs', key: 'b', reason: 'negative' }] });
  assert.deepEqual(t.outbox(), {});
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 1);
  assert.deepEqual(t.applied, []);

  t.sync.markDirty('food_logs', 'b');
  await t.tick(2000);
  t.clock = T0 + 10;
  t.rows.set('food_logs:b', 1); // fixed while the bad copy is in flight
  t.sync.markDirty('food_logs', 'b');
  await t.answer({ cursor: 1, rejected: [{ table: 'food_logs', key: 'b', reason: 'negative' }] });
  assert.deepEqual(t.bodies()[2].changes, { food_logs: [row('b', 1, T0 + 10)] });
});

test('failure: the outbox is kept and the request retried after retryMs[attempt], the last value repeating; success resets it', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.markDirty('food_logs', 'a');
  await t.tick(2000);
  const body = { cursor: null, changes: { food_logs: [row('a', 1, T0)] } };
  await t.fail();
  let sent = 1;
  for (const wait of [5000, 15_000, 60_000, 300_000, 300_000]) {
    assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0) });
    await t.tick(wait - 1);
    assert.equal(t.pushes.length, sent);
    await t.tick(1);
    assert.equal(t.pushes.length, ++sent);
    assert.deepEqual(t.bodies().at(-1), body);
    await t.fail();
  }
  await t.tick(300_000);
  await t.answer({ cursor: 1 });
  assert.deepEqual(t.outbox(), {});

  // After a success the next failure starts from the first delay again.
  t.sync.markDirty('food_logs', 'a');
  await t.tick(2000);
  await t.fail();
  sent = t.pushes.length;
  await t.tick(4999);
  assert.equal(t.pushes.length, sent);
  await t.tick(1);
  assert.equal(t.pushes.length, sent + 1);
});

test('retryMs is configurable', async () => {
  const t = setup({ retryMs: [100] });
  t.sync.kick();
  await flush();
  for (let sent = 1; sent < 4; sent++) {
    await t.fail();
    await t.tick(99);
    assert.equal(t.pushes.length, sent);
    await t.tick(1);
    assert.equal(t.pushes.length, sent + 1);
  }
});

test('kick during a backoff syncs now and resets the delay', async () => {
  const t = setup();
  t.sync.kick();
  await flush();
  await t.fail();
  await t.tick(5000);
  await t.fail(); // the next wait would be 15 s
  t.sync.kick();
  await flush();
  assert.equal(t.pushes.length, 3);
  await t.fail();
  await t.tick(4999);
  assert.equal(t.pushes.length, 3); // and the 15 s timer is gone
  await t.tick(1);
  assert.equal(t.pushes.length, 4);
  await t.answer();
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 4);
});

test('markDirty during a backoff does not shorten the wait; the retry sends the new row too', async () => {
  const t = setup({ rows: { 'food_logs:a': 1, 'food_logs:b': 2 } });
  t.sync.markDirty('food_logs', 'a');
  await t.tick(2000);
  await t.fail();
  await t.tick(1000);
  t.sync.markDirty('food_logs', 'b');
  await t.tick(3999); // well past pushDelayMs
  assert.equal(t.pushes.length, 1);
  assert.deepEqual(Object.keys(t.outbox()), ['food_logs:a', 'food_logs:b']);
  await t.tick(1);
  assert.deepEqual(t.bodies()[1].changes, { food_logs: [row('a', 1, T0), row('b', 2, T0)] });
});

test('401: registers again, forgets the cursor, queues every local row and syncs again at once', async () => {
  const t = setup({ stored: { ...PRIMED, 'sync:cursor': '7' }, rows: { 'food_logs:a': 1, 'food_logs:b': 2 } });
  t.clock = T0 - 1000;
  t.sync.markDirty('food_logs', 'a');
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies()[0], { cursor: 7, changes: { food_logs: [row('a', 1, T0 - 1000)] } });

  t.clock = T0;
  await t.fail(new SyncUnauthorized());
  assert.equal(t.registers, 1);
  assert.equal(t.disk.get('sync:cursor'), 'null');
  // A key that was already dirty keeps its own edit time.
  assert.deepEqual(t.bodies()[1], { cursor: null, changes: { food_logs: [row('a', 1, T0 - 1000), row('b', 2, T0)] } });
  await t.answer({ cursor: 2 });
  assert.deepEqual(t.outbox(), {});
  assert.deepEqual([t.disk.get('sync:cursor'), t.disk.get('sync:primed')], ['2', '1']);
  await t.tick(1_000_000);
  assert.deepEqual([t.pushes.length, t.registers], [2, 1]);
});

test('a second 401 in a row is an ordinary failure: backoff, not a loop; the retry may register again', async () => {
  const t = setup({ rows: { 'food_logs:a': 1 } });
  t.sync.kick();
  await flush();
  await t.fail(new SyncUnauthorized());
  await t.fail(new SyncUnauthorized());
  assert.deepEqual([t.pushes.length, t.registers], [2, 1]);
  await t.tick(4999);
  assert.deepEqual([t.pushes.length, t.registers], [2, 1]);
  await t.tick(1);
  assert.equal(t.pushes.length, 3);
  await t.fail(new SyncUnauthorized());
  assert.deepEqual([t.pushes.length, t.registers], [4, 2]);
  await t.answer({ cursor: 1 });
  assert.deepEqual(t.outbox(), {});
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 4);
});

test('register() failing is a failure like any other: retried with backoff, nothing lost', async () => {
  const t = setup({ stored: {}, token: false, rows: { 'food_logs:a': 1 } });
  t.registerFails = true;
  t.sync.kick();
  await flush();
  assert.deepEqual([t.registers, t.pushes.length], [1, 0]);
  assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0) });
  await t.tick(5000);
  assert.deepEqual([t.registers, t.pushes.length], [2, 0]);
  t.registerFails = false;
  await t.tick(15_000);
  assert.equal(t.registers, 3);
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 1, T0)] } }]);
});

test('a 401 whose register() fails still uploads everything later, even after a restart', async () => {
  const rows = { 'food_logs:a': 1 };
  const t = setup({ stored: { ...PRIMED, 'sync:cursor': '7' }, rows });
  t.sync.kick();
  await flush();
  t.registerFails = true;
  await t.fail(new SyncUnauthorized());
  assert.deepEqual([t.disk.get('sync:primed'), t.disk.get('sync:cursor')], ['', 'null']);
  await t.tick(5000);
  assert.deepEqual(t.bodies()[1], { cursor: null, changes: { food_logs: [row('a', 1, T0)] } });

  const next = setup({ stored: { 'sync:primed': '', 'sync:cursor': 'null' }, rows });
  next.sync.kick();
  await flush();
  assert.deepEqual(next.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 1, T0)] } }]);
});

test('read() throwing for one row: the others are sent, that key stays dirty and is retried after the backoff', async () => {
  let broken = true;
  const t = setup({
    read: (table, key) => {
      if (key === 'bad' && broken) throw new Error('mapping bug');
      return { k: key, v: 1 };
    },
  });
  t.sync.markDirty('food_logs', 'bad');
  t.sync.markDirty('food_logs', 'good');
  await t.tick(2000);
  assert.deepEqual(t.bodies()[0].changes, { food_logs: [row('good', 1, T0)] });
  await t.answer({ cursor: 1 });
  assert.deepEqual(t.outbox(), { 'food_logs:bad': dirty(T0) });
  await t.tick(4999);
  assert.equal(t.pushes.length, 1); // no hot loop on the row that cannot be read
  broken = false;
  await t.tick(1);
  assert.deepEqual(t.bodies()[1], { cursor: 1, changes: { food_logs: [row('bad', 1, T0)] } });
  await t.answer({ cursor: 2 });
  assert.deepEqual(t.outbox(), {});
});

test('all() throwing on the first run: not primed, retried, then uploaded', async () => {
  let broken = true;
  const t = setup({
    stored: {},
    all: () => {
      if (broken) throw new Error('not hydrated');
      return [{ table: 'food_logs', key: 'a' }];
    },
    rows: { 'food_logs:a': 1 },
  });
  t.sync.kick();
  await flush();
  assert.deepEqual([t.pushes.length, t.disk.get('sync:primed')], [0, undefined]);
  broken = false;
  await t.tick(5000);
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [row('a', 1, T0)] } }]);
  assert.equal(t.disk.get('sync:primed'), '1');
});

test('apply() or keyOf() throwing: the cursor does not move, so the same rows are pulled again', async () => {
  for (const which of ['apply', 'keyOf']) {
    let broken = true;
    const applied = [];
    const t = setup({
      rows: { 'food_logs:a': 1 },
      apply: (c) => {
        if (broken && which === 'apply') throw new Error('store bug');
        applied.push(c);
      },
      keyOf: (table, r) => {
        if (broken && which === 'keyOf') throw new Error('mapping bug');
        return r.k;
      },
    });
    t.sync.markDirty('food_logs', 'a');
    await t.tick(2000);
    const x = row('x', 1, T0);
    await t.answer({ cursor: 4, changes: { food_logs: [x] } });
    assert.equal(t.disk.get('sync:cursor'), undefined, which);
    assert.deepEqual(t.outbox(), {}, which); // the push itself did succeed
    broken = false;
    await t.tick(5000);
    assert.deepEqual(t.bodies()[1], { cursor: null, changes: {} }, which);
    await t.answer({ cursor: 4, changes: { food_logs: [x] } });
    assert.deepEqual(applied, [{ ...none(), food_logs: [x] }], which);
    assert.equal(t.disk.get('sync:cursor'), '4', which);
  }
});

test('hasToken, push, tombstone or now throwing synchronously, and a malformed response: survived and retried', async () => {
  let broken = true;
  const boom = () => {
    if (broken) throw new Error('boom');
  };
  const t = setup({
    rows: { 'food_logs:a': 1 },
    hasToken: () => (boom(), Promise.resolve(true)),
    now: () => (boom(), T0),
  });
  assert.doesNotThrow(() => t.sync.markDirty('food_logs', 'a'));
  assert.doesNotThrow(() => t.sync.kick());
  await flush();
  assert.equal(t.pushes.length, 0);
  assert.ok(Number.isFinite(t.outbox()['food_logs:a'].updatedAt)); // the real clock stood in
  broken = false;
  await t.tick(5000);
  assert.equal(t.pushes.length, 1);

  const calls = [];
  const u = setup({
    push: (body) => {
      calls.push(body);
      boom();
      return Promise.resolve(calls.length === 2 ? {} : { cursor: 1, has_more: false, changes: none(), rejected: [] });
    },
    tombstone: (table, key) => (boom(), { k: key }),
  });
  broken = true;
  u.sync.markDirty('food_logs', 'a', true);
  await u.tick(2000);
  assert.deepEqual(calls, [{ cursor: null, changes: {} }]); // the tombstone threw: held back; then push threw
  broken = false;
  await u.tick(5000); // answered with `{}`: not a response
  assert.deepEqual(u.outbox(), { 'food_logs:a': dirty(T0, true) });
  await u.tick(15_000);
  assert.deepEqual(calls[2], { cursor: null, changes: { food_logs: [gone('a', T0)] } });
  assert.deepEqual(u.outbox(), {});
});

test('storage that cannot be written or read: the engine still syncs from memory', async () => {
  const t = setup({
    rows: { 'food_logs:a': 1 },
    storage: { get: () => Promise.reject(new Error('no disk')), set: () => Promise.reject(new Error('disk full')) },
  });
  t.sync.markDirty('food_logs', 'b', true);
  await t.tick(2000);
  // The stored outbox could not be read, so every local row is queued again.
  assert.deepEqual(t.bodies(), [{ cursor: null, changes: { food_logs: [gone('b', T0), row('a', 1, T0)] } }]);
  await t.answer({ cursor: 3 });
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies()[1], { cursor: 3, changes: {} });

  const sync = createSync({
    storage: { get: () => { throw new Error('no storage'); }, set: () => { throw new Error('no storage'); } },
    push: () => Promise.reject(new Error('offline')),
    register: async () => {},
    hasToken: async () => true,
    read: () => null,
    tombstone: () => ({}),
    keyOf: () => '',
    all: () => [],
    apply: () => {},
  });
  assert.doesNotThrow(() => (sync.markDirty('goals', 'x'), sync.kick()));
  await flush();
  sync.dispose();
});

test('the stored outbox and cursor are used after a restart', async () => {
  const t = setup({
    stored: {
      ...PRIMED,
      'sync:cursor': '12',
      'sync:outbox': JSON.stringify({ 'food_logs:a': dirty(T0 - 60_000), 'goals:2026-11-01': dirty(T0 - 30_000, true) }),
    },
    rows: { 'food_logs:a': 1 },
  });
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies(), [{ cursor: 12, changes: { food_logs: [row('a', 1, T0 - 60_000)], goals: [gone('2026-11-01', T0 - 30_000)] } }]);
});

test('a stored outbox entry of the old table daily_steps is sent as daily_activity', async () => {
  const t = setup({
    stored: { ...PRIMED, 'sync:cursor': '3', 'sync:outbox': JSON.stringify({ 'daily_steps:2026-11-10': dirty(T0 - 1000, true) }) },
  });
  t.sync.kick();
  await flush();
  assert.deepEqual(t.bodies(), [{ cursor: 3, changes: { daily_activity: [gone('2026-11-10', T0 - 1000)] } }]);
});

test('markDirty before the stored state has loaded is merged with it: the newer updatedAt per key wins', async () => {
  const gate = deferred();
  const stored = { 'food_logs:a': dirty(T0 + 100), 'food_logs:b': dirty(T0 - 100), 'food_logs:c': dirty(T0 - 100) };
  const t = setup({
    gate: gate.promise,
    stored: { ...PRIMED, 'sync:outbox': JSON.stringify(stored) },
    rows: { 'food_logs:a': 1, 'food_logs:c': 3, 'food_logs:d': 4 },
  });
  t.sync.markDirty('food_logs', 'a'); // older than the stored mark
  t.sync.markDirty('food_logs', 'b', true); // newer
  t.sync.markDirty('food_logs', 'd'); // new
  t.sync.kick(); // waits for the load as well
  await flush();
  assert.deepEqual([t.writes.length, t.pushes.length], [0, 0]); // nothing overwrites what is stored

  gate.resolve();
  await flush();
  assert.deepEqual(t.outbox(), {
    'food_logs:a': dirty(T0 + 100),
    'food_logs:b': dirty(T0, true),
    'food_logs:d': dirty(T0),
    'food_logs:c': dirty(T0 - 100),
  });
  assert.deepEqual(t.bodies(), [
    { cursor: null, changes: { food_logs: [row('a', 1, T0 + 100), gone('b', T0), row('d', 4, T0), row('c', 3, T0 - 100)] } },
  ]);
});

test('a corrupt stored outbox: start empty and prime again; a corrupt cursor: pull from the start', async () => {
  for (const raw of ['{not json', '[1]', 'null', '"x"', '{"food_logs:a":{"updatedAt":"x","deleted":false}}', '{"food_logs:a":null}']) {
    const t = setup({ stored: { ...PRIMED, 'sync:cursor': '9', 'sync:outbox': raw }, rows: { 'food_logs:a': 1 } });
    t.sync.kick();
    await flush();
    assert.deepEqual(t.bodies(), [{ cursor: 9, changes: { food_logs: [row('a', 1, T0)] } }], raw);
    assert.deepEqual(t.outbox(), { 'food_logs:a': dirty(T0) }, raw);
  }
  for (const raw of ['abc', '"7"', '{}']) {
    const t = setup({ stored: { ...PRIMED, 'sync:cursor': raw }, rows: { 'food_logs:a': 1 } });
    t.sync.kick();
    await flush();
    assert.deepEqual(t.bodies(), [{ cursor: null, changes: {} }], raw); // still primed: no upload
  }
});

test('storage writes: one at a time per key, and the latest outbox is written when the write in progress ends', async () => {
  const sets = [];
  const t = setup({
    storage: {
      get: async () => null,
      set: (key, value) => {
        const d = deferred();
        sets.push({ key, value: JSON.parse(value), ...d });
        return d.promise;
      },
    },
  });
  await flush();
  t.sync.markDirty('food_logs', 'a');
  await flush();
  assert.deepEqual(sets.map((s) => s.value), [{ 'food_logs:a': dirty(T0) }]);
  t.sync.markDirty('food_logs', 'b');
  t.sync.markDirty('food_logs', 'c');
  await flush();
  assert.equal(sets.length, 1);
  sets[0].resolve();
  await flush();
  assert.equal(sets.length, 2);
  assert.deepEqual(Object.keys(sets[1].value), ['food_logs:a', 'food_logs:b', 'food_logs:c']);
  sets[1].resolve();
  await flush();
  assert.equal(sets.length, 2);
  t.sync.dispose();
});

test('dispose: no timer is left, late responses and failures are ignored, nothing is written afterwards', async () => {
  // A push delay pending.
  const a = setup({ rows: { 'food_logs:a': 1 } });
  a.sync.markDirty('food_logs', 'a');
  a.sync.dispose();
  await a.tick(1_000_000);
  assert.deepEqual([a.pushes.length, a.writes.length], [0, 0]);

  // A request in flight: its answer is not applied, the cursor is not stored.
  const b = setup({ rows: { 'food_logs:a': 1 } });
  b.sync.kick();
  await flush();
  const written = b.writes.length;
  b.sync.markDirty('food_logs', 'a'); // its write has not started yet
  b.sync.dispose();
  await b.answer({ cursor: 5, has_more: true, changes: { food_logs: [row('x', 1, T0)] } });
  b.sync.markDirty('food_logs', 'a');
  b.sync.kick();
  await b.tick(1_000_000);
  assert.deepEqual([b.pushes.length, b.applied.length, b.writes.length], [1, 0, written]);

  // A request in flight that then fails: no retry.
  const c = setup();
  c.sync.kick();
  await flush();
  c.sync.dispose();
  await c.fail();
  await c.tick(1_000_000);
  assert.equal(c.pushes.length, 1);

  // Waiting to retry.
  const d = setup();
  d.sync.kick();
  await flush();
  await d.fail();
  d.sync.dispose();
  await d.tick(1_000_000);
  assert.equal(d.pushes.length, 1);

  // Disposed before the stored state arrived.
  const gate = deferred();
  const e = setup({ gate: gate.promise, stored: {}, rows: { 'food_logs:a': 1 } });
  e.sync.kick();
  e.sync.dispose();
  gate.resolve();
  await e.tick(1_000_000);
  assert.deepEqual([e.pushes.length, e.writes.length, e.registers], [0, 0, 0]);
});

test('scenario: first run in two batches, an edit in flight, a paged pull, a failure, a 401, then quiet', async () => {
  const t = setup({
    stored: {},
    token: false,
    batchSize: 2,
    rows: { 'food_logs:a': 1, 'food_logs:b': 2, 'food_logs:c': 3, 'goals:2026-11-01': 4 },
  });

  // First run: register, then the first two of four existing rows.
  t.sync.kick();
  await flush();
  assert.equal(t.registers, 1);
  assert.deepEqual(t.bodies()[0], { cursor: null, changes: { food_logs: [row('a', 1, T0), row('b', 2, T0)] } });

  // "a" is edited while that request is in flight: it stays dirty and leads the second batch.
  t.clock = T0 + 1000;
  t.rows.set('food_logs:a', 10);
  t.sync.markDirty('food_logs', 'a');
  await t.answer({ cursor: 2 });
  assert.deepEqual(t.bodies()[1], { cursor: 2, changes: { food_logs: [row('a', 10, T0 + 1000), row('c', 3, T0)] } });

  // The server has rows from another device, in two pages; the goal goes out with the first follow-up.
  const r1 = row('r1', 'remote', T0 - 9000);
  await t.answer({ cursor: 4, has_more: true, changes: { food_logs: [r1] } });
  assert.deepEqual(t.applied[0], { ...none(), food_logs: [r1] });
  assert.deepEqual(t.bodies()[2], { cursor: 4, changes: { goals: [row('2026-11-01', 4, T0)] } });
  const steps = row('2026-11-09', 8000, T0 - 8000);
  await t.answer({ cursor: 6, has_more: true, changes: { daily_activity: [steps] } });
  assert.deepEqual(t.applied[1], { ...none(), daily_activity: [steps] });
  assert.deepEqual(t.bodies()[3], { cursor: 6, changes: {} });

  // The last page fails: nothing is lost, and the retry waits 5 s.
  await t.fail();
  assert.deepEqual(t.outbox(), {});
  assert.equal(t.disk.get('sync:cursor'), '6');
  t.clock = T0 + 5000;
  t.rows.delete('food_logs:b');
  t.sync.markDirty('food_logs', 'b', true); // deleted while offline
  await t.tick(4999);
  assert.equal(t.pushes.length, 4);
  await t.tick(1);
  assert.deepEqual(t.bodies()[4], { cursor: 6, changes: { food_logs: [gone('b', T0 + 5000)] } });

  // The server has forgotten this device: register again, and upload everything from scratch.
  t.clock = T0 + 9000;
  await t.fail(new SyncUnauthorized());
  assert.equal(t.registers, 2);
  assert.deepEqual(t.bodies()[5], { cursor: null, changes: { food_logs: [gone('b', T0 + 5000), row('a', 10, T0 + 9000)] } });
  await t.answer({ cursor: 1 });
  assert.deepEqual(t.bodies()[6], { cursor: 1, changes: { food_logs: [row('c', 3, T0 + 9000)], goals: [row('2026-11-01', 4, T0 + 9000)] } });
  await t.answer({ cursor: 3 });

  // Quiet: nothing dirty, no timer, no further request.
  await t.tick(1_000_000);
  assert.equal(t.pushes.length, 7);
  assert.deepEqual(t.outbox(), {});
  assert.deepEqual([t.disk.get('sync:cursor'), t.disk.get('sync:primed'), t.registers, t.applied.length], ['3', '1', 2, 2]);
});

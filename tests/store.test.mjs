// The on-device store's load-time migration (src/lib/store.ts), with AsyncStorage
// mocked in memory. Run: npm test (uses --experimental-test-module-mocks)
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const disk = new Map();
const writes = [];
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: {
    getItem: async (k) => disk.get(k) ?? null,
    setItem: async (k, v) => {
      writes.push(k);
      disk.set(k, v);
    },
  },
});
globalThis.window = {}; // the store hydrates only where `window` exists
const { Collection, makeId } = await import('../src/lib/store.ts');

test('makeId returns a UUID v4 (the server keys logs by client-made UUIDs)', () => {
  assert.match(makeId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(makeId(), makeId());
});

const hydrated = (c) =>
  new Promise((resolve) => {
    const un = c.subscribe(() => {
      un();
      resolve(c);
    });
  });

test('a migration that changes stored data is applied and saved once', async () => {
  disk.set('a', JSON.stringify([{ id: 'x' }]));
  const c = await hydrated(new Collection('a', [], (items) => items.map((i) => ({ ...i, upgraded: true }))));
  assert.deepEqual(c.items, [{ id: 'x', upgraded: true }]);
  assert.deepEqual(JSON.parse(disk.get('a')), [{ id: 'x', upgraded: true }]);
  assert.equal(writes.filter((k) => k === 'a').length, 1);
});

test('a migration that returns the same array does not rewrite storage', async () => {
  disk.set('b', JSON.stringify([{ id: 'y' }]));
  const c = await hydrated(new Collection('b', [], (items) => items));
  assert.deepEqual(c.items, [{ id: 'y' }]);
  assert.equal(writes.filter((k) => k === 'b').length, 0);
});

test('a migration that throws leaves the data as stored and the store usable', async () => {
  disk.set('c', JSON.stringify([{ id: 'z' }]));
  const c = await hydrated(new Collection('c', [], () => {
    throw new Error('bad data');
  }));
  assert.equal(c.ready, true);
  assert.deepEqual(c.items, [{ id: 'z' }]);
  c.add({ id: 'w' });
  assert.deepEqual(JSON.parse(disk.get('c')), [{ id: 'z' }, { id: 'w' }]);
});

test('the migration runs after writes made during loading are replayed (it sees them too)', async () => {
  disk.set('d', JSON.stringify([{ id: 'old' }]));
  const c = new Collection('d', [], (items) => items.map((i) => ({ ...i, upgraded: true })));
  c.add({ id: 'early' }); // before hydration
  await hydrated(c);
  assert.deepEqual(c.items, [{ id: 'old', upgraded: true }, { id: 'early', upgraded: true }]);
  assert.deepEqual(JSON.parse(disk.get('d')), c.items);
});

test('an early write duplicating stored data is de-duplicated by the migration', async () => {
  disk.set('e', JSON.stringify([{ id: 'honey' }]));
  const dedupe = (items) => {
    const seen = new Map();
    for (const i of items) if (!seen.has(i.id)) seen.set(i.id, i);
    return seen.size === items.length ? items : [...seen.values()];
  };
  const c = new Collection('e', [], dedupe);
  c.add({ id: 'honey' }); // tapped Save before storage had loaded
  await hydrated(c);
  assert.deepEqual(c.items, [{ id: 'honey' }]);
  assert.deepEqual(JSON.parse(disk.get('e')), [{ id: 'honey' }]);
});

test('nothing stored yet: the seed is migrated and saved', async () => {
  const c = await hydrated(new Collection('f', [{ id: 's' }], (items) => items.map((i) => ({ ...i, upgraded: true }))));
  assert.deepEqual(c.items, [{ id: 's', upgraded: true }]);
  assert.deepEqual(JSON.parse(disk.get('f')), c.items);
});

test('hydration re-renders subscribers even when the data equals the seed', async () => {
  const seed = [{ id: 's' }];
  const c = await hydrated(new Collection('h', seed)); // nothing stored: the seed is kept
  assert.equal(c.ready, true);
  assert.deepEqual(c.items, seed);
  assert.notEqual(c.items, seed, 'a new snapshot reference, or useSyncExternalStore would skip the render');
});

test('corrupt stored JSON falls back to the seed, which is migrated', async () => {
  disk.set('g', '{not json');
  const c = await hydrated(new Collection('g', [{ id: 's' }], (items) => items.map((i) => ({ ...i, upgraded: true }))));
  assert.deepEqual(c.items, [{ id: 's', upgraded: true }]);
});

// ── put and whenReady (used by sync: src/lib/sync/local.ts and index.ts) ─────
test('put replaces the item with that id whole (no merge), or appends it', async () => {
  disk.set('p1', JSON.stringify([{ id: 'a', v: 1, extra: true }, { id: 'b', v: 2 }]));
  const c = await hydrated(new Collection('p1', []));
  c.put({ id: 'a', v: 9 });
  assert.deepEqual(c.items, [{ id: 'a', v: 9 }, { id: 'b', v: 2 }], 'replaced in place; `extra` is gone');
  c.put({ id: 'c', v: 3 });
  assert.deepEqual(c.items, [{ id: 'a', v: 9 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }]);
  assert.deepEqual(JSON.parse(disk.get('p1')), c.items);
});

test('put notifies subscribers', async () => {
  const c = await hydrated(new Collection('p2', [{ id: 'a' }]));
  let calls = 0;
  c.subscribe(() => calls++);
  c.put({ id: 'a', v: 1 });
  assert.equal(calls, 1);
});

test('a put before hydration is shown at once and replayed onto the stored data', async () => {
  disk.set('p3', JSON.stringify([{ id: 'stored', v: 1 }, { id: 'both', v: 1, old: true }]));
  const c = new Collection('p3', [{ id: 'seed' }]);
  c.put({ id: 'both', v: 2 }); // replaces the stored one
  c.put({ id: 'new', v: 3 }); // appended to the stored data, not to the seed
  assert.deepEqual(c.items, [{ id: 'seed' }, { id: 'both', v: 2 }, { id: 'new', v: 3 }], 'visible before storage has loaded');
  await c.whenReady();
  assert.deepEqual(c.items, [{ id: 'stored', v: 1 }, { id: 'both', v: 2 }, { id: 'new', v: 3 }]);
  assert.deepEqual(JSON.parse(disk.get('p3')), c.items);
});

test('whenReady resolves after hydration, with the stored data in place', async () => {
  disk.set('w1', JSON.stringify([{ id: 'stored' }]));
  const c = new Collection('w1', [{ id: 'seed' }]);
  assert.equal(c.ready, false);
  assert.deepEqual(c.items, [{ id: 'seed' }]);
  await c.whenReady();
  assert.equal(c.ready, true);
  assert.deepEqual(c.items, [{ id: 'stored' }]);
});

test('whenReady resolves at once on a collection that has already hydrated, every time', async () => {
  const c = await hydrated(new Collection('w2', [{ id: 's' }]));
  await c.whenReady();
  await c.whenReady();
  assert.equal(c.ready, true);
});

for (const [how, getItem] of [
  ['rejects', async () => Promise.reject(new Error('storage is broken'))],
  ['throws', () => { throw new Error('storage is missing'); }],
]) {
  test(`whenReady resolves when reading storage ${how}: the seed is used`, async (t) => {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    t.mock.method(AsyncStorage, 'getItem', getItem);
    const c = new Collection(`w3-${how}`, [{ id: 'seed' }]);
    await c.whenReady();
    assert.equal(c.ready, true);
    assert.deepEqual(c.items, [{ id: 'seed' }]);
  });
}

test('whenReady resolves even when a subscriber throws during hydration', async () => {
  disk.set('w5', JSON.stringify([{ id: 'stored' }]));
  const c = new Collection('w5', []);
  c.subscribe(() => {
    throw new Error('a broken screen');
  });
  await c.whenReady();
  assert.equal(c.ready, true);
  assert.deepEqual(c.items, [{ id: 'stored' }]);
});

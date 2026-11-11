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

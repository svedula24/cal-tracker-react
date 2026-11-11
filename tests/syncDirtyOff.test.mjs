// Reporting local writes to sync (src/lib/sync/dirty.ts) in a build WITHOUT an API URL: nothing
// is kept. Its own file: the URL is read once per process. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.EXPO_PUBLIC_API_URL;
const { attachEngine, markDirty } = await import('../src/lib/sync/dirty.ts');

test('without an API URL markDirty is a no-op: nothing is queued for an engine', () => {
  assert.doesNotThrow(() => markDirty('food_logs', 'a'));
  markDirty('food_logs', 'b', true);
  const seen = [];
  attachEngine((...args) => seen.push(args)); // never happens in the app; shows nothing was queued
  assert.deepEqual(seen, []);
  markDirty('food_logs', 'c');
  assert.deepEqual(seen, [], 'still a no-op with an engine attached');
});

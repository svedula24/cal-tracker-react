// Reporting local writes to sync (src/lib/sync/dirty.ts) in a build WITH an API URL: writes made
// before the engine exists are queued and replayed. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:9'; // read once, when config.ts loads
const { attachEngine, markDirty } = await import('../src/lib/sync/dirty.ts');

test('writes before the engine exists are replayed in order, the latest per row; later ones go straight through', () => {
  markDirty('food_logs', 'a');
  markDirty('saved_foods', '7');
  markDirty('food_logs', 'b');
  markDirty('food_logs', 'a', true); // added, then deleted: only the delete, and after `b`
  const seen = [];
  attachEngine((table, key, deleted) => seen.push([table, key, deleted]));
  assert.deepEqual(seen, [
    ['saved_foods', '7', false],
    ['food_logs', 'b', false],
    ['food_logs', 'a', true],
  ]);

  markDirty('daily_steps', '2026-11-10');
  assert.deepEqual(seen.at(-1), ['daily_steps', '2026-11-10', false]);
  assert.equal(seen.length, 4, 'the queue was emptied: nothing is replayed twice');
});

test('an engine that throws never fails the local write', () => {
  attachEngine(() => {
    throw new Error('engine is broken');
  });
  assert.doesNotThrow(() => markDirty('food_logs', 'a'));
  assert.equal(markDirty('food_logs', 'a'), undefined, 'synchronous: no promise to forget');
});

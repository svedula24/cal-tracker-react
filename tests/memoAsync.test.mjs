// memoAsync (src/lib/memoAsync.ts): the retry contract behind loading the food
// database. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoAsync } from '../src/lib/memoAsync.ts';

test('concurrent and later calls share one run', async () => {
  let runs = 0;
  const load = memoAsync(async () => ++runs);
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(await load(), 1);
  assert.deepEqual([a, b, runs], [1, 1, 1]);
});

test('a rejection is forgotten, so the next call retries', async () => {
  let runs = 0;
  const load = memoAsync(async () => {
    if (++runs === 1) throw new Error('offline');
    return 'data';
  });
  await assert.rejects(load(), /offline/);
  assert.equal(await load(), 'data');
  assert.equal(runs, 2);
  assert.equal(await load(), 'data'); // the success is kept
  assert.equal(runs, 2);
});

test('two callers joining a run that fails both see the failure; the next call retries', async () => {
  let runs = 0;
  const load = memoAsync(async () => {
    if (++runs === 1) throw new Error('offline');
    return 'data';
  });
  const p1 = load();
  const p2 = load();
  await assert.rejects(p1, /offline/);
  await assert.rejects(p2, /offline/);
  assert.equal(await load(), 'data');
  assert.equal(runs, 2);
});

test('a synchronous throw becomes a rejection and is forgotten too', async () => {
  let runs = 0;
  const load = memoAsync(() => {
    if (++runs === 1) throw new Error('sync');
    return Promise.resolve('data');
  });
  await assert.rejects(load(), /sync/); // not a thrown exception
  assert.equal(await load(), 'data');
});

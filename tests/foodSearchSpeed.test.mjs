// Lookup speed budget (a hard requirement: results within 100-200 ms of a keystroke
// on a low-end phone). This guards the search itself; the end-to-end check, with
// rendering under a 6x CPU slowdown, is the "food search speed" flow in npm run verify.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { createFoodIndex } from '../src/lib/foodIndex.ts';
import { rowToFood } from '../src/lib/foodRow.ts';

const raw = readFileSync(new URL('../src/data/usda-foods.json', import.meta.url), 'utf8');
const time = (fn) => {
  const t = performance.now();
  const out = fn();
  return [performance.now() - t, out];
};

test('loading and indexing all foods takes under 150 ms', () => {
  const [ms] = time(() => createFoodIndex(JSON.parse(raw).rows.map(rowToFood)));
  assert.ok(ms < 150, `took ${ms.toFixed(1)} ms`);
});

test('every query, including the broadest single letters, takes under 20 ms', () => {
  const search = createFoodIndex(JSON.parse(raw).rows.map(rowToFood));
  search('warm up');
  for (const q of ['b', 'c', 's', 'p', 'raw', 'banana', 'chicken breast', 'greek yog', 'zzqx']) {
    const [ms] = time(() => search(q));
    assert.ok(ms < 20, `"${q}" took ${ms.toFixed(1)} ms`);
  }
});

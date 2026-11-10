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
  const queries = ['b', 'c', 's', 'p', 'raw', 'banana', 'chicken breast', 'greek yog', 'zzqx'];
  queries.forEach((q) => search(q)); // warm up: a single cold run on a shared CI machine is noise
  for (const q of queries) {
    // Median of 5 runs: steady-state typing speed. (~1-2 ms locally for the broadest query.)
    const runs = Array.from({ length: 5 }, () => time(() => search(q))[0]).sort((a, b) => a - b);
    assert.ok(runs[2] < 20, `"${q}" took ${runs[2].toFixed(1)} ms (median of 5)`);
  }
});

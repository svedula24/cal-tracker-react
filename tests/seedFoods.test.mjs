// The demo seed's foods (src/data/seed-foods.json, written by the build script)
// must exist in the full data and match it exactly. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SEED_FDC_IDS } from '../src/lib/seedIds.ts';

const read = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf8'));
const all = new Map(read('usda-foods.json').rows.map((r) => [r[0], r]));
const seed = read('seed-foods.json').rows;

test('every seed id has a row in seed-foods.json, identical to usda-foods.json', () => {
  assert.deepEqual(seed.map((r) => r[0]), SEED_FDC_IDS);
  for (const row of seed) assert.deepEqual(row, all.get(row[0]), `${row[0]} differs; run npm run build:foods`);
});

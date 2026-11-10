// Every food the demo seed points at must exist in the bundled USDA data, so a
// data rebuild can't silently thin out the demo history. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { PAST_DAY_FOODS, SAVED_FOOD_IDS } from '../src/lib/seedFoods.ts';

const ids = new Set(JSON.parse(readFileSync(new URL('../src/data/usda-foods.json', import.meta.url), 'utf8')).rows.map((r) => `usda:${r[0]}`));

test('seed food ids exist in usda-foods.json', () => {
  const missing = [...PAST_DAY_FOODS.map((f) => f[3]), ...SAVED_FOOD_IDS].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `update src/lib/seedFoods.ts: ${missing.join(', ')} not in the data`);
});

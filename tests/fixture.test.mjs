// The e2e test data's copy of the default goal matches the app's (e2e/fixture.mjs, src/lib/nutrition.ts).
// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_GOAL as e2e } from '../e2e/fixture.mjs';
import { DEFAULT_GOAL as app } from '../src/lib/nutrition.ts';

test("e2e/fixture.mjs DEFAULT_GOAL is the app's DEFAULT_GOAL", () => {
  assert.deepEqual(e2e, app);
});

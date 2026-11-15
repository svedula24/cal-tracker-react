// The save rules of the steps and workout-calories cards (src/lib/dayDraft.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDraftBox, parseWhole, stepsToSave, workoutToSave } from '../src/lib/dayDraft.ts';

test('parseWhole: whole numbers with commas, nothing else', () => {
  assert.equal(parseWhole('1,234'), 1234);
  assert.equal(parseWhole(' 520 '), 520);
  assert.equal(parseWhole(''), null);
  assert.equal(parseWhole('12.5'), null);
  assert.equal(parseWhole('-3'), null);
  assert.equal(parseWhole('12345678'), null);
});

test('DraftBox: the latest text is handed out once, so Enter then blur saves once', () => {
  const box = createDraftBox();
  box.set('2026-11-15', '123');
  box.set('2026-11-15', '1234'); // the last keystroke, before any render
  assert.equal(box.take('2026-11-15'), '1234'); // Enter
  assert.equal(box.take('2026-11-15'), null); // blur right after: nothing to save
});

test('DraftBox: nothing typed gives nothing; text typed for another day is dropped', () => {
  const box = createDraftBox();
  assert.equal(box.take('2026-11-15'), null);
  box.set('2026-11-14', '900');
  assert.equal(box.take('2026-11-15'), null); // the card moved to another day
  assert.equal(box.take('2026-11-14'), null); // and it is gone
});

test('stepsToSave: a changed whole number only', () => {
  assert.equal(stepsToSave('1234', 1000), 1234);
  assert.equal(stepsToSave('1,000', 1000), null); // unchanged
  assert.equal(stepsToSave('abc', 1000), null);
  assert.equal(stepsToSave(null, 1000), null);
});

test('workoutToSave: a number, or empty for the goal amount; nothing when nothing was typed', () => {
  assert.deepEqual(workoutToSave('520'), { kcal: 520 });
  assert.deepEqual(workoutToSave(''), { kcal: null }); // emptied: back to the goal's amount
  assert.deepEqual(workoutToSave('  '), { kcal: null });
  assert.equal(workoutToSave(null), null);
  assert.equal(workoutToSave('lots'), null);
});

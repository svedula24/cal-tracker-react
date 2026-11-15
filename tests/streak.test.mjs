// The streak on Home: consecutive days with an entry, ending today or yesterday (src/lib/nutrition.ts).
// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

// A zone with DST, so the spring-forward and fall-back days are covered (Node applies TZ when set).
process.env.TZ = 'America/New_York';

const { streakDays } = await import('../src/lib/nutrition.ts');

test('no entries: 0', () => {
  assert.equal(streakDays([], '2026-11-15'), 0);
});

test('today only: 1; repeated dates count once', () => {
  assert.equal(streakDays(['2026-11-15'], '2026-11-15'), 1);
  assert.equal(streakDays(['2026-11-15', '2026-11-15', '2026-11-15'], '2026-11-15'), 1);
});

test('nothing today yet: the run ending yesterday counts', () => {
  assert.equal(streakDays(['2026-11-12', '2026-11-13', '2026-11-14'], '2026-11-15'), 3);
});

test('neither today nor yesterday: 0, however long the run before', () => {
  assert.equal(streakDays(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], '2026-11-15'), 0);
});

test('a gap ends the streak; a future day does not count', () => {
  assert.equal(streakDays(['2026-11-10', '2026-11-11', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'], '2026-11-15'), 3);
});

test('across a month and a year boundary', () => {
  assert.equal(streakDays(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02'), 4);
  assert.equal(streakDays(['2025-12-30', '2025-12-31', '2026-01-01'], '2026-01-02'), 3);
  assert.equal(streakDays(['2028-02-28', '2028-02-29', '2028-03-01'], '2028-03-01'), 3); // leap day
});

test('across the DST changes: no day skipped or counted twice', () => {
  // US 2026: spring forward on March 8, fall back on November 1.
  assert.equal(streakDays(['2026-03-07', '2026-03-08', '2026-03-09'], '2026-03-09'), 3);
  assert.equal(streakDays(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02'), 3);
  assert.equal(streakDays(['2026-03-07', '2026-03-09'], '2026-03-09'), 1);
});

test('takes any iterable of day keys', () => {
  assert.equal(streakDays(new Set(['2026-11-14', '2026-11-15']), '2026-11-15'), 2);
});

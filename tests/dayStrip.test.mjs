// The scrolling day strip on Home: pages of 7 days back from today (src/lib/nutrition.ts).
// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { caloriesByDay, daysBetween, dayKey, stripPage, stripPageOf } from '../src/lib/nutrition.ts';

// A zone with DST, so the spring-forward and fall-back weeks are covered (Node applies TZ when set).
process.env.TZ = 'America/New_York';

const keys = (page, today) => stripPage(page, today).map((d) => d.key);
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

test('page 0 is the old strip: five days back, today, tomorrow', () => {
  const today = at(2026, 11, 14);
  const days = stripPage(0, today);
  assert.deepEqual(days.map((d) => d.key), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.deepEqual(days.map((d) => d.isToday), [false, false, false, false, false, true, false]);
  assert.deepEqual(days.map((d) => d.isFuture), [false, false, false, false, false, false, true]);
  assert.equal(days[5].label, 'Sat');
  assert.equal(days[5].day, 14);
  assert.deepEqual(stripPage(0, today), days);
});

test('each earlier page is the 7 days before, with no today or future day', () => {
  const today = at(2026, 11, 14);
  assert.deepEqual(keys(1, today), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  for (const p of [1, 2, 30, 52]) {
    const days = stripPage(p, today);
    assert.ok(days.every((d) => !d.isToday && !d.isFuture), `page ${p}`);
    assert.equal(daysBetween(new Date(stripPage(p - 1, today)[0].key + 'T12:00'), new Date(days[6].key + 'T12:00')), -1, `page ${p} ends the day before page ${p - 1}`);
  }
});

test('pages cross month and year boundaries', () => {
  const today = at(2026, 1, 3);
  assert.deepEqual(keys(0, today), ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.deepEqual(keys(1, today), ['2025-12-22', '2025-12-23', '2025-12-24', '2025-12-25', '2025-12-26', '2025-12-27', '2025-12-28']);
  // Leap day.
  assert.deepEqual(keys(0, at(2028, 3, 2)), ['2028-02-26', '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02', '2028-03-03']);
});

test('pages across DST changes have 7 distinct consecutive days, from any time of day', () => {
  // US DST: 2026-03-08 springs forward, 2026-11-01 falls back.
  assert.notEqual(at(2026, 3, 7).getTimezoneOffset(), at(2026, 3, 9).getTimezoneOffset(), 'TZ with DST is in effect');
  for (const today of [at(2026, 3, 10, 0), at(2026, 3, 10, 23), at(2026, 11, 3, 0), at(2026, 11, 3, 23), at(2026, 3, 8, 3), at(2026, 11, 1, 1)]) {
    for (let p = 0; p < 6; p++) {
      const k = keys(p, today);
      assert.equal(new Set(k).size, 7);
      for (let i = 1; i < 7; i++) assert.equal(daysBetween(new Date(k[i - 1] + 'T12:00'), new Date(k[i] + 'T12:00')), 1, `${k[i - 1]} -> ${k[i]}`);
    }
  }
});

test('daysBetween counts calendar days, not 24-hour spans', () => {
  assert.equal(daysBetween(at(2026, 3, 7, 23), at(2026, 3, 8, 23)), 1); // 23 hours apart
  assert.equal(daysBetween(at(2026, 10, 31, 0), at(2026, 11, 1, 23)), 1); // 24+ hours apart
  assert.equal(daysBetween(at(2026, 1, 1), at(2025, 1, 1)), -365);
});

test('stripPageOf finds the page of a day, and every day of every page round-trips', () => {
  for (const today of [at(2026, 11, 14), at(2026, 1, 3, 0), at(2026, 3, 9, 23), at(2026, 11, 2, 0)]) {
    for (let p = 0; p < 60; p++) for (const d of stripPage(p, today)) assert.equal(stripPageOf(d.key, today), p, `${d.key} from ${dayKey(today)}`);
  }
  const today = at(2026, 11, 14);
  assert.equal(stripPageOf('2026-11-14', today), 0);
  assert.equal(stripPageOf('2026-11-09', today), 0);
  assert.equal(stripPageOf('2026-11-08', today), 1);
  assert.equal(stripPageOf('2025-11-14', today), 52); // a year back
  // No future pages: anything after tomorrow belongs to page 0.
  assert.equal(stripPageOf('2026-11-15', today), 0);
  assert.equal(stripPageOf('2027-01-01', today), 0);
});

test('caloriesByDay sums each day once, rounded like sum()', () => {
  const n = (calories) => ({ calories, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  const map = caloriesByDay([
    { date: '2026-11-14', servings: 1, nutrients: n(100.4) },
    { date: '2026-11-14', servings: 2, nutrients: n(50) },
    { date: '2026-11-13', servings: 0.5, nutrients: n(301) },
  ]);
  assert.equal(map.get('2026-11-14'), 200);
  assert.equal(map.get('2026-11-13'), 151);
  assert.equal(map.get('2026-11-12'), undefined);
  assert.equal(caloriesByDay([]).size, 0);
});

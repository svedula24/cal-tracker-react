// Recognising what older versions seeded as demo data (src/lib/demoData.ts). Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

// A zone with DST, so a seed spanning the fall-back day is covered (Node applies TZ when set).
process.env.TZ = 'America/New_York';

const { demoDayLogs, isDemoSaved, looksLikeDemoEntry } = await import('../src/lib/demoData.ts');

const log = (id, steps, rollover = 0, extra = {}) => ({ id, steps, rollover, dayType: null, workoutKcal: null, ...extra });
// What the seed wrote on an install on 2026-11-10 (the user's server rows: 11-10 5782, 11-09 4950, 11-08 5900, …).
const seeded = () => [
  log('2026-11-10', 5782, 200),
  log('2026-11-09', 4950),
  log('2026-11-08', 5900),
  log('2026-11-07', 6850),
  log('2026-11-06', 7800),
  log('2026-11-05', 8750),
];
const sorted = ({ remove, clear }) => ({ remove: [...remove].sort(), clear: [...clear].sort() });

test('day logs: every seeded day is removed; the user\'s days are kept', () => {
  const mine = [log('2026-11-11', 5782), log('2026-11-12', 4950), log('2026-11-04', 9700), log('2026-11-14', 8000, 0, { dayType: 'workout' })];
  const got = sorted(demoDayLogs([...seeded(), ...mine]));
  assert.deepEqual(got, { remove: ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'], clear: [] });
});

test('day logs: near misses are kept (5,783 steps; another rollover; steps on the wrong day)', () => {
  assert.deepEqual(sorted(demoDayLogs([log('2026-11-10', 5783, 200), log('2026-11-09', 4950)])), { remove: [], clear: [] });
  assert.deepEqual(sorted(demoDayLogs([log('2026-11-10', 5782, 150), log('2026-11-09', 4950)])), { remove: [], clear: [] });
  // 5,900 is the seed's value two days back, not one.
  assert.deepEqual(sorted(demoDayLogs([log('2026-11-10', 5782, 200), log('2026-11-09', 5900)])), { remove: ['2026-11-10'], clear: [] });
  // The user changed one past day's steps: that day is theirs now.
  const edited = seeded().map((l) => (l.id === '2026-11-08' ? { ...l, steps: 6000 } : l));
  assert.ok(!demoDayLogs(edited).remove.includes('2026-11-08'));
  // A past day with a rollover is not the seed's.
  assert.ok(!demoDayLogs(seeded().map((l) => (l.id === '2026-11-09' ? { ...l, rollover: 50 } : l))).remove.includes('2026-11-09'));
});

test('day logs: no install day, nothing matches (seed-like steps alone are not enough)', () => {
  assert.deepEqual(sorted(demoDayLogs(seeded().slice(1))), { remove: [], clear: [] });
  assert.deepEqual(sorted(demoDayLogs([log('2026-11-10', 5782)])), { remove: [], clear: [] }); // no rollover, no seed days before
  assert.deepEqual(sorted(demoDayLogs([])), { remove: [], clear: [] });
});

test('day logs: pulled from the server (no rollover there), the full seed pattern still matches', () => {
  const pulled = seeded().map((l) => ({ ...l, rollover: 0 }));
  assert.deepEqual(sorted(demoDayLogs(pulled)).remove.length, 6);
});

test('day logs: a seeded day the user gave a day type or workout calories is cleared, not deleted', () => {
  const logs = seeded().map((l) =>
    l.id === '2026-11-10' ? { ...l, dayType: 'rest' } : l.id === '2026-11-07' ? { ...l, workoutKcal: 300 } : l,
  );
  const got = sorted(demoDayLogs(logs));
  assert.deepEqual(got.clear, ['2026-11-07', '2026-11-10']);
  assert.deepEqual(got.remove, ['2026-11-05', '2026-11-06', '2026-11-08', '2026-11-09']);
});

test('day logs: a seed across the fall-back day and a month boundary', () => {
  const logs = [log('2026-11-02', 5782, 200), log('2026-11-01', 4950), log('2026-10-31', 5900), log('2026-10-30', 6850)];
  assert.deepEqual(sorted(demoDayLogs(logs)).remove, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('saved foods: the three demo bookmarks without savedAt; one the user saved (savedAt) is kept', () => {
  for (const id of ['usda:2708118', 'usda:170894', 'usda:169640']) {
    assert.equal(isDemoSaved({ id }), true);
    assert.equal(isDemoSaved({ id, savedAt: '2026-11-12T10:00:00.000Z' }), false);
  }
  assert.equal(isDemoSaved({ id: 'usda:2709224' }), false);
});

test('entries: a guessed entry looks like demo only with a demo name and the seed\'s servings', () => {
  assert.equal(looksLikeDemoEntry({ name: 'Whole Milk Latte', servings: 1 }), true);
  assert.equal(looksLikeDemoEntry({ name: 'Whole Milk Latte', servings: 2 }), false);
  assert.equal(looksLikeDemoEntry({ name: 'My latte', servings: 1 }), false);
  assert.equal(looksLikeDemoEntry({ name: 'Oatmeal', servings: 1.5 }), true);
  assert.equal(looksLikeDemoEntry({ name: 'Oatmeal', servings: 1.25 }), true);
  assert.equal(looksLikeDemoEntry({ name: 'Oatmeal', servings: 1 }), false);
});

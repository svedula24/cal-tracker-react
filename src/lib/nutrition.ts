// Pure nutrition math + date helpers. No React, no storage.

export type Nutrients = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number; // mg
};

export type Goals = Nutrients & {
  id: 'goals';
  steps: number;
  goal: 'lose' | 'maintain' | 'gain';
};

export const NUTRIENT_KEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'] as const;

export const zero = (): Nutrients => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });

export function sum(items: { servings: number; nutrients: Nutrients }[]): Nutrients {
  const t = zero();
  for (const i of items) for (const k of NUTRIENT_KEYS) t[k] += i.nutrients[k] * i.servings;
  for (const k of NUTRIENT_KEYS) t[k] = Math.round(t[k]);
  return t;
}

/** Calories burned from steps (~0.035 kcal per step). */
export const stepsToCalories = (steps: number) => Math.round(steps * 0.035);

// ── Dates (local time, keyed YYYY-MM-DD) ─────────────────────────────────────
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export const parseDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayKey = () => dayKey(new Date());

/** The 7-day strip: five days back, today, tomorrow (matches the reference). */
export function weekStrip(today = new Date()) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 5);
    return {
      key: dayKey(date),
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      day: date.getDate(),
      isToday: i === 5,
      isFuture: i === 6,
    };
  });
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// ── Scores ───────────────────────────────────────────────────────────────────
const ON_TRACK_MIN = 0.7;
const ON_TRACK_MAX = 1.15;

export type ScoreRow = { key: 'calories' | 'protein' | 'carbs' | 'fat'; label: string; eaten: number; goal: number; unit: string; onTrack: boolean; ratio: number };

/**
 * Daily Score (0-100): each of calories/protein/carbs/fat scores 100 inside the
 * on-track band (70-115% of goal) and loses 7.5 points per percent outside it.
 * Weighted 30/30/20/20. The seeded reference day scores 89.
 */
export function dailyScore(t: Nutrients, calorieBudget: number, g: Goals) {
  const defs = [
    { key: 'calories', label: 'Calories', goal: calorieBudget, unit: '', w: 0.3 },
    { key: 'protein', label: 'Protein', goal: g.protein, unit: 'g', w: 0.3 },
    { key: 'carbs', label: 'Carbs', goal: g.carbs, unit: 'g', w: 0.2 },
    { key: 'fat', label: 'Fat', goal: g.fat, unit: 'g', w: 0.2 },
  ] as const;
  let score = 0;
  const rows: ScoreRow[] = defs.map((d) => {
    const ratio = d.goal > 0 ? t[d.key] / d.goal : 0;
    const dist = ratio < ON_TRACK_MIN ? ON_TRACK_MIN - ratio : ratio > ON_TRACK_MAX ? ratio - ON_TRACK_MAX : 0;
    score += d.w * Math.max(0, 100 - 750 * dist);
    return { key: d.key, label: d.label, eaten: t[d.key], goal: d.goal, unit: d.unit, onTrack: dist === 0, ratio };
  });
  const value = Math.round(score);
  const headline = value >= 85 ? 'Great balance' : value >= 70 ? 'Good progress' : 'Needs attention';
  const lowest = rows
    .filter((r) => r.key !== 'calories')
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 2)
    .sort((a, b) => ['protein', 'carbs', 'fat'].indexOf(a.key) - ['protein', 'carbs', 'fat'].indexOf(b.key))
    .map((r) => r.label.toLowerCase());
  const tip = rows.every((r) => r.onTrack && r.ratio >= 0.9)
    ? 'Keep it up — every macro is on target.'
    : `Shift your next meal toward ${lowest.join(' and ')}.`;
  return { value, headline, tip, rows };
}

/** Health Score (0-10) + a one-paragraph summary. Seeded reference day: 7/10. */
export function healthScore(t: Nutrients, calorieBudget: number, g: Goals) {
  const below: string[] = [];
  if (t.calories < 0.9 * calorieBudget) below.push('calorie');
  if (t.carbs < 0.9 * g.carbs) below.push('carb');
  if (t.fat < 0.9 * g.fat) below.push('fat');
  const over: string[] = [];
  if (t.calories > 1.1 * calorieBudget) over.push('calorie');
  const value = Math.max(0, 10 - below.length - over.length);
  const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`);
  const parts: string[] = [];
  if (below.length) {
    let s = `You're below ${list(below)} goals`;
    if (t.protein >= 0.95 * g.protein) s += ', though protein exceeds its goal';
    const aim = g.goal === 'gain' ? 'support weight gain' : g.goal === 'lose' ? 'stay on track' : 'maintain your weight';
    parts.push(`${s}; increase overall intake to ${aim}.`);
  } else if (over.length) parts.push("You're over your calorie goal; go lighter for the rest of the day.");
  else parts.push("You're hitting your calorie and macro goals.");
  const extra: string[] = [];
  if (t.sodium > g.sodium) extra.push('Sodium is also high');
  if (t.fiber < 0.5 * g.fiber) extra.push(extra.length ? 'while fiber is low' : 'Fiber is low');
  if (extra.length) parts.push(`${extra.join(', ')}.`);
  return { value, text: parts.join(' ') };
}

/** Week-strip ring status for a past day. */
export function dayStatus(eaten: number, budget: number): 'none' | 'good' | 'bad' {
  if (eaten === 0 || budget <= 0) return 'none';
  const r = eaten / budget;
  return r >= 0.9 && r <= 1.1 ? 'good' : 'bad';
}

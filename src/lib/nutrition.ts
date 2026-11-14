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

export type GoalType = 'lose' | 'maintain' | 'gain';
export type GoalSource = 'computed' | 'manual';
/** What kind of day it was: a workout or active-rest day adds the goal's calories for it. */
export type DayType = 'workout' | 'active_rest' | 'rest';

/**
 * A goal row: the targets in force from `effectiveDate` (YYYY-MM-DD) until the next row's date.
 * `id` is the effective date (one row per day). `source`: whether the calorie and macro targets
 * were filled from suggestTargets ('computed') or typed ('manual').
 */
export type Goals = Nutrients & {
  id: string;
  effectiveDate: string;
  source: GoalSource;
  steps: number;
  goal: GoalType;
  /** Added to the day's calories on a workout day. */
  workoutKcal: number;
  /** Added to the day's calories on an active-rest day. */
  activeRestKcal: number;
};

export const NUTRIENT_KEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'] as const;

export const zero = (): Nutrients => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });

export function sum(items: { servings: number; nutrients: Nutrients }[]): Nutrients {
  const t = zero();
  for (const i of items) for (const k of NUTRIENT_KEYS) t[k] += i.nutrients[k] * i.servings;
  for (const k of NUTRIENT_KEYS) t[k] = Math.round(t[k]);
  return t;
}

/** Rounds half away from zero (Math.round takes -2.5 to -2); the server rounds the same way. */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** Calories burned from steps (~0.035 kcal per step). */
export const stepsToCalories = (steps: number) => roundHalfAway((Number.isFinite(steps) ? steps : 0) * 0.035);

// ── Goals over time ──────────────────────────────────────────────────────────
/** The date of the goal in force since before any log: the seed's, and an old install's one set of goals. */
export const FIRST_GOAL_DATE = '2020-01-01';

const isDayKey = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);

/** The goal in force on `date` (YYYY-MM-DD): the row with the latest effective date on or before it; null if none has begun. */
export function goalOn(rows: readonly Goals[], date: string): Goals | null {
  let best: Goals | null = null;
  for (const row of rows) {
    if (!isDayKey(row?.effectiveDate) || row.effectiveDate > date) continue;
    if (!best || row.effectiveDate > best.effectiveDate) best = row;
  }
  return best;
}

/**
 * Stored goals as dated rows. Before goals had dates the app stored one object under the id
 * `goals`: it becomes the row in force since FIRST_GOAL_DATE. A row missing the newer fields gets
 * their defaults (typed by hand, no workout or active-rest calories). Returns the same array
 * when nothing changes.
 */
export function migrateGoals(items: Goals[]): Goals[] {
  let changed = false;
  const out = items.map((item) => {
    const old = item as Partial<Goals> & { id: string };
    const effectiveDate = isDayKey(old.effectiveDate) ? old.effectiveDate : isDayKey(old.id) ? old.id : FIRST_GOAL_DATE;
    const next: Goals = {
      ...(old as Goals),
      id: effectiveDate,
      effectiveDate,
      source: old.source === 'computed' ? 'computed' : 'manual',
      workoutKcal: Number.isFinite(old.workoutKcal) ? (old.workoutKcal as number) : 0,
      activeRestKcal: Number.isFinite(old.activeRestKcal) ? (old.activeRestKcal as number) : 0,
    };
    const same =
      next.id === old.id &&
      next.effectiveDate === old.effectiveDate &&
      next.source === old.source &&
      next.workoutKcal === old.workoutKcal &&
      next.activeRestKcal === old.activeRestKcal;
    if (same) return item;
    changed = true;
    return next;
  });
  if (!changed) return items;
  // Rows that now share a date (only from damaged data): the later one wins, as with `put`.
  const byDate = new Map<string, Goals>();
  for (const row of out) byDate.set(row.id, row);
  return [...byDate.values()];
}

// ── Day targets ──────────────────────────────────────────────────────────────
/** A day's targets: the goal's, adjusted for the day's activity. `adjustment`: the calories added. */
export type DayTarget = Nutrients & { adjustment: number };

/**
 * A day's activity. `workoutKcal`: calories typed for that day, used instead of the goal's amount
 * whatever the day type (0 is a value); null or absent = the goal's amount for the day type.
 */
export type DayActivity = { steps?: number | null; dayType?: DayType | null; workoutKcal?: number | null };

/** The calories a day's type adds: the day's own workout calories if set, else the goal's for that day type. */
export function dayKcal(goal: Pick<Goals, 'workoutKcal' | 'activeRestKcal'>, activity: DayActivity | null | undefined): number {
  const own = activity?.workoutKcal;
  const kcal =
    own != null ? own : activity?.dayType === 'workout' ? goal.workoutKcal : activity?.dayType === 'active_rest' ? goal.activeRestKcal : 0;
  return Number.isFinite(kcal) ? kcal : 0;
}

/**
 * The targets for a day under `goal`. The day's adjustment, round(steps × 0.035) + dayKcal, is
 * added to calories, and a quarter of it (as grams) to carbs; every other target is the goal's.
 * No activity counts as 0 steps and no day type. The rules are shared with the server:
 * shared/targets-fixtures.json.
 */
export function dayTarget(goal: Nutrients & Pick<Goals, 'workoutKcal' | 'activeRestKcal'>, activity: DayActivity | null | undefined): DayTarget {
  const adjustment = stepsToCalories(activity?.steps ?? 0) + dayKcal(goal, activity);
  const target: DayTarget = { ...zero(), adjustment };
  for (const k of NUTRIENT_KEYS) target[k] = goal[k];
  target.calories = goal.calories + adjustment;
  target.carbs = goal.carbs + adjustment / 4;
  return target;
}

/** What is left of each target after the day's totals (negative once over). */
export function remaining(target: Nutrients, totals: Nutrients): Nutrients {
  const left = zero();
  for (const k of NUTRIENT_KEYS) left[k] = target[k] - totals[k];
  return left;
}

export type SuggestInput = { sex: 'male' | 'female'; age: number; heightCm: number; weightKg: number; goal: GoalType };

const GOAL_FACTOR: Record<GoalType, number> = { lose: 0.8, maintain: 1, gain: 1.1 };

/** The inputs a suggestion accepts (inclusive); outside them there is no suggestion. Shared with the server. */
export const SUGGEST_LIMITS: Record<'age' | 'heightCm' | 'weightKg', readonly [number, number]> = { age: [10, 120], heightCm: [50, 300], weightKg: [20, 500] };

type SuggestBody = Pick<SuggestInput, 'age' | 'heightCm' | 'weightKg'>;

/** Whether one suggestion input is a number within SUGGEST_LIMITS. */
export const inSuggestLimit = (k: keyof SuggestBody, v: number | null | undefined): boolean =>
  typeof v === 'number' && v >= SUGGEST_LIMITS[k][0] && v <= SUGGEST_LIMITS[k][1];

/** Whether age, height and weight all are (a suggestion can be made from them). */
export const suggestInputValid = (body: { [K in keyof SuggestBody]: number | null | undefined }): boolean =>
  inSuggestLimit('age', body.age) && inSuggestLimit('heightCm', body.heightCm) && inSuggestLimit('weightKg', body.weightKg);

/**
 * Suggested calorie and macro targets: Mifflin–St Jeor BMR × 1.2 (sedentary) × the goal's factor
 * (lose 0.8, maintain 1, gain 1.1); protein 1.8 g per kg; fat 25% of the calories; carbs the rest.
 * Calories, fat and carbs never go below 0. Only for inputs within SUGGEST_LIMITS (suggestInputValid).
 * The inputs are not kept anywhere: only the numbers are saved, as a goal.
 */
export function suggestTargets({ sex, age, heightCm, weightKg, goal }: SuggestInput): Pick<Nutrients, 'calories' | 'protein' | 'carbs' | 'fat'> {
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
  const calories = Math.max(0, roundHalfAway(bmr * 1.2 * GOAL_FACTOR[goal]));
  const protein = roundHalfAway(1.8 * weightKg);
  const fat = Math.max(0, roundHalfAway((0.25 * calories) / 9));
  const carbs = Math.max(0, roundHalfAway((calories - 4 * protein - 9 * fat) / 4));
  return { calories, protein, carbs, fat };
}

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
export function dailyScore(t: Nutrients, calorieBudget: number, g: Nutrients) {
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
export function healthScore(t: Nutrients, calorieBudget: number, g: Nutrients & Pick<Goals, 'goal'>) {
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

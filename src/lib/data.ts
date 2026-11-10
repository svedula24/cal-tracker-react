// App data on top of the on-device store (src/lib/store.ts). UI only: nothing
// here talks to a server. First launch is seeded so Home matches the reference
// screenshots exactly; anything the user logs adds on top.
import { makeId, useCollection } from '@/lib/store';
import {
  addDays,
  dailyScore,
  dayKey,
  type Goals,
  healthScore,
  type Nutrients,
  stepsToCalories,
  sum,
} from '@/lib/nutrition';
import { foodById, type Food } from '@/data/foods';

export type Entry = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // ISO timestamp
  name: string;
  servings: number;
  nutrients: Nutrients; // per serving
  foodId?: string;
  photo?: string;
};
export type DayLog = { id: string; steps: number; waterCups: number; rollover: number }; // id = date
// id = food id. `food` is a snapshot, so a saved food survives a USDA data
// refresh that renumbers it (FNDDS ids change between releases).
export type SavedFood = { id: string; food?: Food };

// ── Seed (dated relative to first launch) ────────────────────────────────────
const n = (calories: number, protein: number, carbs: number, fat: number, fiber: number, sugar: number, sodium: number): Nutrients => ({
  calories, protein, carbs, fat, fiber, sugar, sodium,
});

function at(date: Date, h: number, m: number) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const now = new Date();
const today = dayKey(now);

// Today's entries sum exactly to the reference: 2543 kcal, 174/322/59 g,
// fiber 13 g, sugar 54 g, sodium 3791 mg.
const todaySeed: [string, number, number, Nutrients][] = [
  ['Whole Milk Latte', 8, 40, n(190, 10, 15, 10, 0, 7, 165)],
  ['Three Seed Sourdough', 9, 1, n(240, 8, 46, 2, 3, 1, 400)],
  ['Sliced Part-Skim Mozzarella', 9, 3, n(80, 7, 1, 5, 0, 0, 175)],
  ['Sandwich', 12, 26, n(725, 40, 75, 29, 4, 6, 1650)],
  ["Cookies 'n Cream Protein Bar", 15, 6, n(150, 17, 14, 3, 1, 1, 180)],
  ['Chicken & Jasmine Rice', 17, 40, n(577, 52, 86, 1, 1, 0, 1100)],
  ['Greek Yogurt Bowl', 19, 10, n(517, 40, 68, 9, 4, 22, 120)],
  ['Honey', 19, 12, n(64, 0, 17, 0, 0, 17, 1)],
];

// Previous five days: logged, but under goal (red rings in the week strip).
// Real USDA foods by FoodData Central id (src/data/usda-foods.json).
const pastSeed: [string, number, number, string][] = [
  ['Oatmeal', 8, 10, 'usda:2708383'],
  ['Banana', 8, 15, 'usda:2709224'],
  ['Chicken Burrito', 13, 0, 'usda:2708546'],
  ['Brown Rice', 19, 5, 'usda:2708410'],
  ['Greek Yogurt (plain)', 21, 0, 'usda:330137'],
];

function seedEntries(): Entry[] {
  const out: Entry[] = todaySeed.map(([name, h, m, nutrients]) => ({
    id: makeId(), date: today, time: at(now, h, m), name, servings: 1, nutrients,
  }));
  for (let back = 1; back <= 5; back++) {
    const d = addDays(now, -back);
    for (const [name, h, m, foodId] of pastSeed) {
      const food = foodById.get(foodId);
      if (!food) continue; // a later USDA release may drop or renumber a food
      out.push({ id: makeId(), date: dayKey(d), time: at(d, h, m), name, servings: back % 2 ? 1.5 : 1.25, nutrients: food.nutrients, foodId });
    }
  }
  return out;
}

const goalsSeed: Goals[] = [
  {
    id: 'goals',
    // 3027 + 200 rollover + 202 burned = the reference budget of 3429.
    calories: 3027, protein: 182, carbs: 433, fat: 94, fiber: 38, sugar: 113, sodium: 2300,
    waterCups: 8, steps: 10000, goal: 'gain',
  },
];

const dayLogSeed: DayLog[] = [
  { id: today, steps: 5782, waterCups: 0, rollover: 200 },
  ...[1, 2, 3, 4, 5].map((b) => ({ id: dayKey(addDays(now, -b)), steps: 4000 + b * 950, waterCups: 4 + (b % 3), rollover: 0 })),
];

// Streak is display-only (reference shows 16 days).
export const STREAK_DAYS = 16;

// ── Hooks ────────────────────────────────────────────────────────────────────
const entriesSeed = seedEntries();
export const useEntries = () => useCollection<Entry>('entries', entriesSeed);
export const useDayLogs = () => useCollection<DayLog>('dayLogs', dayLogSeed);
const savedSeed: SavedFood[] = ['usda:2708118', 'usda:330137', 'usda:169640'] // Clif Bar, Greek yogurt, honey
  .map((id) => foodById.get(id))
  .filter((f): f is Food => !!f)
  .map((food) => ({ id: food.id, food }));
export const useSavedFoods = () => useCollection<SavedFood>('savedFoods', savedSeed);

export function useGoals() {
  const { items } = useCollection<Goals>('goals', goalsSeed);
  return { goals: items[0] ?? goalsSeed[0] };
}

/** Everything Home shows for one day, derived from the logs. */
export function useDay(date: string) {
  const { goals } = useGoals();
  const entries = useEntries().items.filter((e) => e.date === date).sort((a, b) => b.time.localeCompare(a.time));
  const dayLogs = useDayLogs();
  const log = dayLogs.items.find((d) => d.id === date) ?? { id: date, steps: 0, waterCups: 0, rollover: 0 };

  const totals = sum(entries);
  const burned = stepsToCalories(log.steps);
  const budget = dayBudget(goals.calories, log);

  const setWater = (cups: number) => {
    const waterCups = Math.max(0, cups);
    if (dayLogs.items.some((d) => d.id === date)) dayLogs.update(date, { waterCups });
    else dayLogs.add({ ...log, waterCups });
  };

  return {
    goals, entries, log, totals, burned, budget, setWater,
    score: dailyScore(totals, budget, goals),
    health: healthScore(totals, budget, goals),
  };
}

/** ISO timestamp for "now" moved onto `date` (logging to a selected day). */
export function nowOn(date: string): string {
  const t = new Date();
  const [y, m, d] = date.split('-').map(Number);
  t.setFullYear(y, m - 1, d);
  return t.toISOString();
}

/** Log a database food for a day (time = now on that day). */
export function newEntry(food: Food, servings: number, date: string): Entry {
  return { id: makeId(), date, time: nowOn(date), name: food.name, servings, nutrients: food.nutrients, foodId: food.id };
}

/** The calorie budget for a day: goal + rollover + calories burned from steps. */
export function dayBudget(goalCalories: number, log: DayLog | undefined) {
  return goalCalories + (log?.rollover ?? 0) + stepsToCalories(log?.steps ?? 0);
}


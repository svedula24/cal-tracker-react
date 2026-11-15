// Test data for the e2e checks: the app starts empty, so a check that needs food on Home brings
// its own. `referenceDay` writes a full set of data into the browser's storage before the app
// loads (Playwright's addInitScript): today matches the reference screenshots (2543 kcal of 3429,
// Daily Score 89, 5,782 steps, +200 rollover), the five days before have a few logged foods each
// (under goal: red rings), and three foods are saved. Every entry is the user's (`seed: false`).
//
//   import { referenceDay } from './fixture.mjs';
//   await referenceDay(page); // before the first page.goto

// Real USDA rows ([fdcId, name, per100g[calories,protein,carbs,fat,fiber,sugar,sodium], portions]).
const OATMEAL = [2708383, 'Oatmeal, regular or quick, made with milk, no added fat', [116, 5.56, 16.2, 3.25, 1.7, 5.08, 105], [['1 oz, dry, yields', 170], ['1 cup, cooked', 240], ['1 cup, dry, yields', 485]]];
const BANANA = [2709224, 'Banana, raw', [97, 0.74, 22.7, 0.28, 1.7, 15.8, 0], [['1 banana', 126], ['1 slice', 6], ['1 cup', 150], ['1 cup, mashed', 225], ['1 linear inch', 15]]];
const BURRITO = [2708546, 'Burrito, chicken, with beans and rice, cheese', [209, 11.1, 26, 6.45, 2, 1.61, 466], [['1 cup', 120], ['1 miniature', 110], ['1 small/regular', 220], ['1 large', 330]]];
const BROWN_RICE = [2708410, 'Rice, brown, cooked, fat added, made with oil', [141, 2.38, 25.2, 3.41, 1, 0.22, 196], [['1 cup, cooked', 196]]];
const YOGURT = [170894, 'Yogurt, Greek, plain, nonfat', [59, 10.2, 3.6, 0.39, 0, 3.24, 36], [['1 container', 170]]];
const CLIF_BAR = [2708118, 'Nutrition bar (Clif Bar)', [346, 14.7, 65.4, 5.88, 7.4, 31.6, 195], [['1 bar', 68], ['1 miniature bar', 28]]];
const HONEY = [169640, 'Honey', [304, 0.3, 82.4, 0, 0.2, 82.1, 4], [['1 tbsp', 21], ['1 cup', 339], ['1 packet (0.5 oz)', 14]]];

/** The saved foods' FoodData Central ids, in the order they are stored. */
export const SAVED_FDC_IDS = [CLIF_BAR[0], YOGURT[0], HONEY[0]];

/**
 * The app's default goal: a copy of DEFAULT_GOAL in src/lib/nutrition.ts (what a new install starts
 * with). tests/fixture.test.mjs checks the two match.
 */
export const DEFAULT_GOAL = {
  id: '2020-01-01', effectiveDate: '2020-01-01', source: 'manual',
  calories: 3027, protein: 182, carbs: 382.5, fat: 94, fiber: 38, sugar: 113, sodium: 2300,
  steps: 10000, goal: 'gain', workoutKcal: 0, activeRestKcal: 0,
};

/** How many days before today the test data has entries on (so its streak is PAST_DAYS + 1). */
export const PAST_DAYS = 5;

/** Runs in the browser: the storage keys and values of the reference data, dated from today there. */
function build({ rows, savedIds, goal, pastDays }) {
  const pad = (x) => String(x).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const back = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  };
  const at = (d, h, m) => {
    const t = new Date(d);
    t.setHours(h, m, 0, 0);
    return t.toISOString();
  };
  const keys = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];
  const n = (...v) => Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  const food = ([fdcId, name, per, portions]) => ({ id: `usda:${fdcId}`, name, per100g: n(...per), portions: portions.map(([label, grams]) => ({ label, grams })) });
  const byId = new Map(rows.map((r) => [r[0], food(r)]));
  const now = new Date();

  // Today's entries sum exactly to the reference: 2543 kcal, 174/322/59 g, fiber 13 g, sugar 54 g, sodium 3791 mg.
  const today = [
    ['Whole Milk Latte', 8, 40, n(190, 10, 15, 10, 0, 7, 165)],
    ['Three Seed Sourdough', 9, 1, n(240, 8, 46, 2, 3, 1, 400)],
    ['Sliced Part-Skim Mozzarella', 9, 3, n(80, 7, 1, 5, 0, 0, 175)],
    ['Sandwich', 12, 26, n(725, 40, 75, 29, 4, 6, 1650)],
    ["Cookies 'n Cream Protein Bar", 15, 6, n(150, 17, 14, 3, 1, 1, 180)],
    ['Chicken & Jasmine Rice', 17, 40, n(577, 52, 86, 1, 1, 0, 1100)],
    ['Greek Yogurt Bowl', 19, 10, n(517, 40, 68, 9, 4, 22, 120)],
    ['Honey', 19, 12, n(64, 0, 17, 0, 0, 17, 1)],
  ];
  const entries = today.map(([name, h, m, nutrients]) => ({
    id: crypto.randomUUID(), date: dayKey(now), time: at(now, h, m), name, servings: 1, nutrients, seed: false,
  }));
  const pastFoods = [['Oatmeal', 8, 10, 2708383], ['Banana', 8, 15, 2709224], ['Chicken Burrito', 13, 0, 2708546], ['Brown Rice', 19, 5, 2708410], ['Greek Yogurt (plain)', 21, 0, 170894]];
  for (let b = 1; b <= pastDays; b++) {
    const d = back(b);
    for (const [name, h, m, fdcId] of pastFoods) {
      const f = byId.get(fdcId);
      const measure = f.portions[0];
      entries.push({
        id: crypto.randomUUID(), date: dayKey(d), time: at(d, h, m), name, servings: b % 2 ? 1.5 : 1.25,
        nutrients: Object.fromEntries(keys.map((k) => [k, (f.per100g[k] * measure.grams) / 100])),
        per100g: f.per100g, portions: f.portions, measure, foodId: f.id, foodName: f.name, seed: false,
      });
    }
  }
  const dayLogs = [
    { id: dayKey(now), steps: 5782, rollover: 200, dayType: null, workoutKcal: null },
    ...Array.from({ length: pastDays }, (_, i) => i + 1).map((b) => ({ id: dayKey(back(b)), steps: 4000 + b * 950, rollover: 0, dayType: null, workoutKcal: null })),
  ];
  const savedFoods = savedIds.map((id) => ({ id: `usda:${id}`, food: byId.get(id) }));
  return { entries, savedFoods, goals: [goal], dayLogs };
}

/** The arguments `build` runs with (plain data, so it crosses into the browser). */
const ARGS = { rows: [OATMEAL, BANANA, BURRITO, BROWN_RICE, YOGURT, CLIF_BAR, HONEY], savedIds: SAVED_FDC_IDS, goal: DEFAULT_GOAL, pastDays: PAST_DAYS };

/**
 * Writes the reference data into storage before the app's scripts run, once per browser profile:
 * a page that already has data (a reload after the app saved, a later navigation) keeps its own.
 * Works on a page or a browser context.
 */
export async function referenceDay(target) {
  await target.addInitScript(
    ({ src, args }) => {
      try {
        if (localStorage.getItem('e2e:fixture') !== null) return;
        const data = new Function(`return (${src})`)()(args);
        for (const [key, value] of Object.entries(data)) localStorage.setItem(key, JSON.stringify(value));
        // The test data copies what older versions seeded (the same day logs), but stands for the
        // user's own: mark the one-time demo clean-up (src/lib/data.ts removeDemoDataOnce) as done.
        localStorage.setItem('kalo.demo.cleaned.v2', '1');
        localStorage.setItem('e2e:fixture', '1');
      } catch {} // a page without storage (about:blank) has nothing to fill
    },
    { src: build.toString(), args: ARGS },
  );
}

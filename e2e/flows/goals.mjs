// Goals and day-activity flows (Goals screen, Home's activity page). Shape matches e2e/flows.mjs.
// They run after every other flow: they change today's goal, which the others' numbers assume.

export const routes = ['/goals'];

const go = async (page, url, wait) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByText('Recently uploaded').waitFor({ timeout: 8000 }).catch(() => {});
  await wait(500);
};
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return { key: keyOf(d), label: `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}` };
};
// Half away from zero, as the app and the server round.
const round = (x) => Math.sign(x) * Math.round(Math.abs(x));

/** The calorie budget on Home's first card ("/3429"), for the day Home shows. */
const budget = async (page) => {
  const text = await page.getByText(/^\/\d+$/).first().textContent({ timeout: 3000 });
  return Number(text.slice(1));
};
/** Waits until the budget is `want` (writes re-render on the next frame). */
const expectBudget = async (page, want, why) => {
  let got;
  for (let i = 0; i < 30; i++) {
    got = await budget(page).catch(() => undefined);
    if (got === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${why}: the budget is ${got}, expected ${want}`);
};
/** The stored goal row with the latest effective date (today's, once a goal is saved today). */
const todayGoal = (page) =>
  page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('goals') ?? '[]');
    return rows.find((g) => g.effectiveDate === rows.map((r) => r.effectiveDate).sort().at(-1));
  });
const GOOD = '#28a96c'; // tokens.colors.good: a past day's ring when it was on budget
const ringStroke = (page, label) => btn(page, label).locator('circle').first().getAttribute('stroke');

/** Opens Goals from the Daily Score sheet (the screen's entry point), sets fields, saves. */
const editGoals = async (page, base, wait, values) => {
  await go(page, base + '/', wait);
  await page.getByRole('button', { name: /^Daily score \d+$/ }).click();
  await wait(500);
  await btn(page, 'Edit goals').click();
  await field(page, 'Calories').waitFor({ timeout: 5000 });
  for (const [label, value] of Object.entries(values)) await field(page, label).fill(String(value));
  await btn(page, 'Save goals').click();
  await wait(500);
};

export const flows = [
  {
    name: 'goals: suggest fills the four targets and marks them suggested; typing one makes it manual; inputs are not saved',
    run: async (page, base, { wait }) => {
      await go(page, base + '/goals', wait);
      await field(page, 'Calories').waitFor({ timeout: 5000 });
      if ((await page.getByLabel('Goal source: manual').count()) === 0) throw new Error('the seeded goal is not shown as manual');
      // Values the server would reject (and sync would drop) can't be saved: steps a whole number up
      // to 2^31 - 1, every amount up to 1e9. "82,5" is 82.5, not 825.
      const saveDisabled = async () => (await btn(page, 'Save goals').getAttribute('aria-disabled')) === 'true';
      for (const [label, bad] of [['Steps', '10000.5'], ['Steps', '3000000000'], ['Carbs', '1000000001'], ['Fat', 'abc']]) {
        await field(page, label).fill(bad);
        if (!(await saveDisabled())) throw new Error(`Save is enabled with ${label} "${bad}"`);
        await page.reload({ waitUntil: 'networkidle' });
        await field(page, 'Calories').waitFor({ timeout: 5000 });
      }
      await field(page, 'Steps').fill('10,000');
      await field(page, 'Fat').fill('82,5');
      if (await saveDisabled()) throw new Error('Save is disabled with Steps "10,000" and Fat "82,5"');
      await page.reload({ waitUntil: 'networkidle' });
      await field(page, 'Calories').waitFor({ timeout: 5000 });
      await btn(page, 'Male').click();
      await btn(page, 'Maintain weight').click();
      await field(page, 'Age').fill('30');
      await field(page, 'Height').fill('180');
      await field(page, 'Weight').fill('80');
      await btn(page, 'Fill from suggestion').click();
      await wait(200);
      const got = {};
      for (const k of ['Calories', 'Protein', 'Carbs', 'Fat']) got[k] = await field(page, k).inputValue();
      const want = { Calories: '2136', Protein: '144', Carbs: '257', Fat: '59' }; // shared/targets-fixtures.json "male, maintain"
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`suggestion filled ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      await page.getByLabel('Goal source: suggested').waitFor({ timeout: 2000 });
      // Typing over a suggested target and saving stores a manual goal with the typed value.
      await field(page, 'Fat').fill('60');
      await page.getByLabel('Goal source: manual').waitFor({ timeout: 2000 });
      await btn(page, 'Save goals').click();
      await wait(500);
      let row = await todayGoal(page);
      if (!row || row.source !== 'manual' || row.fat !== 60 || row.calories !== 2136 || row.goal !== 'maintain') throw new Error(`saved after typing Fat: ${JSON.stringify(row)}`);

      // Filling again, then editing a target the suggestion does not fill, keeps it suggested.
      // Distinctive inputs, so the storage scan below would find them in any key.
      const INPUTS = /177\.37|81\.43/g;
      const inputHits = () =>
        page.evaluate((src) => Object.keys(localStorage).reduce((n, k) => n + ((localStorage.getItem(k) ?? '').match(new RegExp(src, 'g'))?.length ?? 0), 0), INPUTS.source);
      const hitsBefore = await inputHits();
      await go(page, base + '/goals', wait);
      await field(page, 'Calories').waitFor({ timeout: 5000 });
      await field(page, 'Age').fill('37');
      await field(page, 'Height').fill('177.37');
      await field(page, 'Weight').fill('81.43');
      await btn(page, 'Fill from suggestion').click();
      await page.getByLabel('Goal source: suggested').waitFor({ timeout: 2000 });
      // A suggestion made for other inputs is no longer one: changing sex or goal type makes it manual.
      await btn(page, 'Male').click(); // the form starts at Female
      await page.getByLabel('Goal source: manual').waitFor({ timeout: 2000 });
      await btn(page, 'Fill from suggestion').click();
      await page.getByLabel('Goal source: suggested').waitFor({ timeout: 2000 });
      await btn(page, 'Gain weight').click();
      await page.getByLabel('Goal source: manual').waitFor({ timeout: 2000 });
      await btn(page, 'Maintain weight').click();
      await btn(page, 'Fill from suggestion').click();
      await page.getByLabel('Goal source: suggested').waitFor({ timeout: 2000 });
      await field(page, 'Fiber').fill('41');
      await btn(page, 'Save goals').click();
      await wait(500);
      row = await todayGoal(page);
      if (!row || row.source !== 'computed' || row.fiber !== 41) throw new Error(`saved after editing Fiber: ${JSON.stringify(row)}`);

      // The suggestion's inputs are nowhere in storage: no key or field for them, and no new copy of the typed values.
      const all = await page.evaluate(() => Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? '']));
      for (const [k, v] of all) {
        if (/suggest|height|weight/i.test(k)) throw new Error(`storage key "${k}" looks like a suggestion input`);
        if (/"(sex|age|height\w*|weight\w*)"\s*:/i.test(v)) throw new Error(`a suggestion input field was saved under "${k}": ${v.slice(0, 300)}`);
      }
      if ((await inputHits()) !== hitsBefore) throw new Error('a typed suggestion input value (177.37 / 81.43) was saved');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('goals') ?? '[]'));
      if (!stored.some((g) => g.effectiveDate === '2020-01-01' && g.calories === 3027)) throw new Error('the earlier goal row is gone');
    },
  },
  {
    name: "goals: a change today leaves yesterday's budget and week-strip ring as they were",
    run: async (page, base, { wait }) => {
      const y = yesterday();
      await go(page, base + '/', wait);
      await btn(page, y.label).click();
      await wait(400);
      const yBudget = await budget(page);
      const yRing = await ringStroke(page, y.label);
      // The new goal would turn yesterday green; that only shows something if it isn't green already.
      if ((yRing ?? '').toLowerCase() === GOOD) throw new Error("yesterday's ring is already green: this check would prove nothing");
      // A calorie goal that would put yesterday exactly on target (a green ring) if it applied to it.
      const { eaten, steps } = await page.evaluate((key) => {
        const entries = JSON.parse(localStorage.getItem('entries') ?? '[]').filter((e) => e.date === key);
        const log = JSON.parse(localStorage.getItem('dayLogs') ?? '[]').find((d) => d.id === key);
        return { eaten: Math.round(entries.reduce((s, e) => s + e.nutrients.calories * e.servings, 0)), steps: log?.steps ?? 0 };
      }, y.key);
      if (eaten === 0) throw new Error('yesterday has no demo entries: this check would prove nothing');
      const calories = eaten - round(steps * 0.035);
      await editGoals(page, base, wait, { Calories: calories });

      await go(page, base + '/', wait);
      const today = await page.evaluate(() => JSON.parse(localStorage.getItem('dayLogs') ?? '[]'));
      const t = today.find((d) => d.id === today.map((r) => r.id).sort().at(-1));
      await expectBudget(page, calories + round(t.steps * 0.035) + t.rollover, "today's budget under the new goal");
      if ((await ringStroke(page, y.label)) !== yRing) throw new Error(`yesterday's ring changed from ${yRing}`);
      await btn(page, y.label).click();
      await wait(400);
      await expectBudget(page, yBudget, "yesterday's budget");
    },
  },
  {
    name: 'activity: a workout or active rest day with steps raises the budget by its calories + round(steps × 0.035); a typed day value replaces the goal amount; Rest clears it',
    run: async (page, base, { wait }) => {
      const WORKOUT = 300;
      const ACTIVE = 150;
      await editGoals(page, base, wait, { 'Workout day calories': WORKOUT, 'Active rest day calories': ACTIVE });
      await go(page, base + '/', wait);
      await btn(page, 'Page 3').click();
      await wait(500);

      const setSteps = async (n) => {
        await btn(page, 'Edit steps').click();
        await field(page, 'Steps').fill(String(n));
        await field(page, 'Steps').press('Enter');
        await wait(300);
      };
      await setSteps(0);
      await btn(page, 'Rest day').click();
      await wait(300);
      const rest = await budget(page);

      const STEPS = 10000;
      const stepKcal = round(STEPS * 0.035);
      await setSteps(STEPS);
      await btn(page, 'Workout day').click();
      await expectBudget(page, rest + WORKOUT + stepKcal, 'workout day with steps');
      if ((await page.getByText(STEPS.toLocaleString('en-US'), { exact: true }).count()) === 0) throw new Error('typed steps not shown');

      const DAY = 520;
      await field(page, 'Workout calories').fill(String(DAY));
      await field(page, 'Workout calories').press('Enter');
      await expectBudget(page, rest + DAY + stepKcal, "the day's own workout calories");

      // Rest clears the day's own workout calories: back on Workout, the goal's amount applies.
      await btn(page, 'Rest day').click();
      await expectBudget(page, rest + stepKcal, 'a rest day adds only the steps');
      if ((await field(page, 'Workout calories').inputValue()) !== '') throw new Error("Rest kept the day's workout calories");
      await btn(page, 'Workout day').click();
      await expectBudget(page, rest + WORKOUT + stepKcal, "back on Workout after Rest: the goal's amount");

      await field(page, 'Workout calories').fill(String(DAY));
      await field(page, 'Workout calories').press('Enter');
      await expectBudget(page, rest + DAY + stepKcal, "the day's own workout calories again");
      await field(page, 'Workout calories').fill('');
      await field(page, 'Workout calories').press('Enter');
      await expectBudget(page, rest + WORKOUT + stepKcal, "an emptied day value goes back to the goal's");

      await btn(page, 'Active rest day').click();
      await expectBudget(page, rest + ACTIVE + stepKcal, 'active rest day with steps');

      // It persists.
      await go(page, base + '/', wait);
      await expectBudget(page, rest + ACTIVE + stepKcal, 'after a reload');
    },
  },
];

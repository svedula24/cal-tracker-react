// Logging-screen flows (Food Database, Saved foods, Entry detail).
// Shape matches e2e/flows.mjs. Flows share one page, so state carries over;
// each flow guards its own preconditions.

export const routes = ['/food-database', '/saved-foods', '/scan-food'];

const settle = async (page, wait, ms = 600) => {
  await page.waitForLoadState('networkidle');
  await wait(ms);
};
const go = async (page, url, wait) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await wait(600);
};
const visible = (page, text) => page.getByText(text, { exact: true }).count();
const btn = (page, name) => page.getByRole('button', { name, exact: true });

// The food database is its own chunk, fetched when Food Database opens, so the
// screen's loading and failed states can be driven from the network. Matches the
// exported chunk (usda-foods-<hash>.js) and the dev server's (usda-foods.bundle?…).
const FOOD_CHUNK = '**/usda-foods*';

// The Calories card on the Nutrition screen shows a bare number (macros carry units).
const expectCalories = (page, value) =>
  page
    .getByText(value, { exact: true })
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {
      throw new Error(`expected the Calories card to show ${value}`);
    });

export const flows = [
  {
    name: 'food database: loading state until the data arrives, then the empty-search prompt',
    run: async (page, base) => {
      let release;
      const held = new Promise((r) => (release = r));
      let handled = Promise.resolve();
      // continue() may run after the page moved on; swallow that so a failed
      // assertion in this flow can't surface as an unrelated error later.
      await page.route(FOOD_CHUNK, (route) => (handled = held.then(() => route.continue().catch(() => {}))));
      try {
        await page.goto(base + '/food-database', { waitUntil: 'domcontentloaded' });
        await page.getByLabel('Loading foods').waitFor({ timeout: 5000 });
        if ((await page.getByText(/Works offline/).count()) > 0) throw new Error('empty-search prompt shown before the data loaded');
        release();
        await page.getByText(/^Search [\d,]+ foods from USDA FoodData Central\. Works offline\.$/).waitFor({ timeout: 5000 });
        if ((await page.getByLabel('Loading foods').count()) > 0) throw new Error('spinner still shown after loading');
        if ((await page.getByRole('button', { name: /^Save .+/ }).count()) > 0) throw new Error('rows shown with an empty search');
      } finally {
        release();
        await handled;
        await page.unroute(FOOD_CHUNK);
      }
    },
  },
  {
    name: 'food database: a failed data load shows Retry, and Retry recovers',
    // The blocked chunk is logged by the browser itself; it is the point of this flow.
    allowErrors: /Failed to load resource: net::ERR_FAILED \([^)]*usda-foods/,
    run: async (page, base, { wait }) => {
      // Watch the chunk's own errors, so a failure of the real fetch after Retry
      // is reported with its URL instead of being hidden by allowErrors.
      const chunkErrors = [];
      const onConsole = (m) => m.type() === 'error' && /usda-foods/.test(m.location().url) && chunkErrors.push(`${m.text()} (${m.location().url})`);
      page.on('console', onConsole);
      await page.route(FOOD_CHUNK, (route) => route.abort());
      try {
        await go(page, base + '/food-database', wait);
        await page.getByText("Couldn't load the food database.", { exact: true }).waitFor({ timeout: 5000 });
        if ((await page.getByLabel('Loading foods').count()) > 0) throw new Error('spinner still shown after the failure');
        if (chunkErrors.length !== 1) throw new Error(`expected the one blocked chunk request, saw: ${chunkErrors.join(' | ') || 'none'}`);
        await page.unroute(FOOD_CHUNK);
        await btn(page, 'Retry').click();
        await page.getByText(/Works offline/).waitFor({ timeout: 5000 }).catch(() => {
          throw new Error(`Retry did not recover; chunk errors after Retry: ${chunkErrors.slice(1).join(' | ') || 'none'}`);
        });
        await page.getByLabel('Search foods').fill('honey');
        await page.getByText('Honey', { exact: true }).waitFor({ timeout: 3000 });
      } finally {
        page.off('console', onConsole);
        await page.unroute(FOOD_CHUNK);
      }
    },
  },
  {
    name: 'food database: offline USDA search ranks the plain food first',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await page.getByText('1 banana (126 g) · 122 cal').waitFor({ timeout: 3000 });
      const first = page.getByRole('button', { name: /./ }).filter({ hasText: 'cal' }).first();
      if ((await first.innerText()).split('\n')[0] !== 'Banana, raw') throw new Error(`first result was ${(await first.innerText()).split('\n')[0]}`);
      await page.getByLabel('Search foods').fill('greek yog');
      await page.getByText('Yogurt, Greek, plain, nonfat', { exact: true }).waitFor({ timeout: 3000 });
    },
  },
  {
    name: 'nutrition: the amount is typed in grams; the default is the food\'s serving',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await btn(page, 'Banana, raw').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      // USDA Banana, raw: 97 kcal per 100 g; the field starts at its serving, 1 banana = 126 g.
      const grams = page.getByLabel('Grams');
      if ((await grams.inputValue()) !== '126') throw new Error(`grams field starts at ${await grams.inputValue()}, not 126`);
      await page.getByText('1 banana = 126 g').waitFor({ timeout: 2000 });
      await expectCalories(page, '122');
      await grams.fill('100');
      await expectCalories(page, '97');
      await grams.fill('50');
      await expectCalories(page, '49'); // 48.5, shown whole (values ≥ 10 round)
      await grams.fill('1417.5'); // 50 oz
      await expectCalories(page, '1375');
      // An invalid amount disables Done and keeps the last valid amount on the cards.
      await grams.fill('abc');
      if ((await btn(page, 'Done').getAttribute('aria-disabled')) !== 'true') throw new Error('Done enabled with an invalid amount');
      await grams.fill('252');
      await expectCalories(page, '244');
      if ((await btn(page, 'Done').getAttribute('aria-disabled')) === 'true') throw new Error('Done still disabled with a valid amount');
      await btn(page, 'Done').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await page.getByText(/244 Calories/).waitFor({ timeout: 3000 });
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await page.getByText(/244 Calories/).count()) === 0) throw new Error('252 g of banana did not persist on Home');
      // Editing it reopens with the grams it was logged at.
      await page.getByText('Banana, raw', { exact: true }).first().click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      if ((await page.getByLabel('Grams').inputValue()) !== '252') throw new Error('edit did not reopen at 252 g');
      await page.getByLabel('Grams').fill('126');
      await expectCalories(page, '122');
      await btn(page, 'Done').click();
      await page.getByText(/122 Calories/).waitFor({ timeout: 5000 });
    },
  },
  {
    name: 'nutrition (edit): a bookmark saves the food under its database name, not the renamed label',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await page.getByText('Banana, raw', { exact: true }).first().click(); // logged by the previous flow
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await page.getByLabel('Food name').fill('Breakfast');
      await btn(page, 'Save Banana, raw').click();
      await btn(page, 'Unsave Banana, raw').waitFor({ timeout: 3000 });
      await btn(page, 'Done').click();
      await page.getByText('Breakfast', { exact: true }).waitFor({ timeout: 5000 });
      await go(page, base + '/saved-foods', wait);
      if ((await visible(page, 'Banana, raw')) === 0) throw new Error('saved food is not under its database name');
      if ((await visible(page, 'Breakfast')) > 0) throw new Error('saved food took the renamed label');
    },
  },
  {
    name: 'nutrition: other nutrition facts expand; bookmark saves the food',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('honey');
      await btn(page, 'Honey').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await btn(page, 'Other nutrition facts').click();
      await page.getByText('Sodium', { exact: true }).nth(1).waitFor({ timeout: 3000 }); // the expanded list, below the card
      if ((await page.getByLabel('Grams').inputValue()) !== '21') throw new Error('honey should start at its serving, 1 tbsp = 21 g');
      if ((await btn(page, 'Unsave Honey').count()) === 0) {
        await btn(page, 'Save Honey').click();
        await btn(page, 'Unsave Honey').waitFor({ timeout: 3000 });
      }
      await go(page, base + '/saved-foods', wait);
      if ((await visible(page, 'Honey')) === 0) throw new Error('Honey not in saved foods');
    },
  },
  {
    name: 'food database: no-results message',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('zzqx');
      await page.getByText('No foods match "zzqx"').waitFor({ timeout: 3000 });
    },
  },
  {
    name: 'bookmark a food -> appears in Saved foods',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('avocado raw');
      await page.getByText('Avocado, raw', { exact: true }).waitFor({ timeout: 3000 });
      if ((await btn(page, 'Save Avocado, raw').count()) > 0) await btn(page, 'Save Avocado, raw').click();
      if ((await btn(page, 'Unsave Avocado, raw').count()) === 0) throw new Error('bookmark did not toggle on');
      await go(page, base + '/saved-foods', wait);
      if ((await visible(page, 'Avocado, raw')) === 0) throw new Error('Avocado not in saved foods');
    },
  },
  {
    name: 'remove a saved food -> gone after reload',
    run: async (page, base, { wait }) => {
      await go(page, base + '/saved-foods', wait);
      if ((await btn(page, 'Remove Avocado, raw').count()) === 0) throw new Error('no remove button for Avocado');
      await btn(page, 'Remove Avocado, raw').click();
      await wait(300);
      if ((await visible(page, 'Avocado, raw')) > 0) throw new Error('Avocado still listed after remove');
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Avocado, raw')) > 0) throw new Error('Avocado came back after reload');
    },
  },
  {
    name: 'saved foods: stored entries are cleaned once at load',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      // An older build's storage: a pre-USDA id, a broken snapshot, a duplicate, and a valid entry.
      const banana = {
        id: 'usda:2709224',
        name: 'Banana (saved)',
        per100g: { calories: 97, protein: 0.74, carbs: 22.7, fat: 0.28, fiber: 1.7, sugar: 15.8, sodium: 0 },
        portions: [{ label: '1 banana', grams: 126 }],
      };
      await page.evaluate(
        (b) => localStorage.setItem('savedFoods', JSON.stringify([{ id: 'protein-bar' }, { id: 'x', food: {} }, { id: b.id, food: b }, { id: b.id, food: b }])),
        banana,
      );
      await go(page, base + '/saved-foods', wait);
      await page.getByText('Banana (saved)', { exact: true }).waitFor({ timeout: 3000 });
      const rows = await page.getByRole('button', { name: /^Remove .+/ }).count();
      if (rows !== 1) throw new Error(`expected 1 saved food, saw ${rows}`);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('savedFoods')));
      const summary = stored.map((s) => `${s.id}=${s.food?.name}`).join(', ');
      if (summary !== 'usda:2709224=Banana (saved)') throw new Error(`storage not cleaned: ${summary}`);
    },
  },
  {
    name: 'nutrition (edit): rename Honey -> "Raw Honey" persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await page.getByText('Honey', { exact: true }).first().click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      // Opened by URL: the form must wait for storage, not start from empty defaults.
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await expectCalories(page, '64'); // the seeded entry's calories
      const title = await page.getByLabel('Food name').inputValue();
      if (title !== 'Honey') throw new Error(`form not seeded from the stored entry: "${title}"`);
      await page.getByLabel('Food name').fill('Raw Honey');
      await btn(page, 'Done').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Raw Honey')) === 0) throw new Error('"Raw Honey" not shown after reload');
    },
  },
  {
    name: 'nutrition (edit): servings change updates Home; delete removes the entry',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await page.getByText('Raw Honey', { exact: true }).first().click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await page.getByLabel('Number of servings').fill('3');
      await expectCalories(page, '192');
      await btn(page, 'Done').click();
      await page.getByText(/192 Calories/).waitFor({ timeout: 5000 });
      await page.getByText('Raw Honey', { exact: true }).first().click();
      await btn(page, 'More options').click();
      await btn(page, 'Delete entry').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Raw Honey')) > 0) throw new Error('"Raw Honey" still on Home after delete');
    },
  },
];

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
    name: 'food database: add "Banana, raw" -> shows on Home and persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await btn(page, 'Banana, raw').click();
      await btn(page, 'Add Banana, raw to log').click();
      await settle(page, wait);
      await go(page, base + '/', wait);
      if ((await visible(page, 'Banana, raw')) === 0) throw new Error('Banana, raw not on Home after adding');
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Banana, raw')) === 0) throw new Error('Banana, raw did not persist on Home');
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
      const banana = { id: 'usda:2709224', name: 'Banana (saved)', serving: '1 banana (126 g)', nutrients: { calories: 122, protein: 1, carbs: 29, fat: 0, fiber: 2, sugar: 20, sodium: 0 } };
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
    name: 'entry detail: rename Honey -> "Raw Honey" persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await page.getByText('Honey', { exact: true }).first().click();
      await settle(page, wait);
      const input = page.getByLabel('Food name');
      await input.fill('Raw Honey');
      await input.blur();
      await wait(200);
      await btn(page, 'Back').click();
      await settle(page, wait);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Raw Honey')) === 0) throw new Error('"Raw Honey" not shown after reload');
    },
  },
  {
    name: 'entry detail: delete entry -> gone after reload',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await page.getByText('Raw Honey', { exact: true }).first().click();
      await settle(page, wait);
      await btn(page, 'Delete entry').click();
      await settle(page, wait);
      await go(page, base + '/', wait);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Raw Honey')) > 0) throw new Error('"Raw Honey" still on Home after delete');
    },
  },
];

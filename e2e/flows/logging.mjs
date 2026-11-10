// Logging-screen flows (Food Database, Saved foods, Entry detail).
// Shape matches e2e/flows.mjs. Flows share one page, so state carries over;
// each flow guards its own preconditions.

export const routes = ['/food-database', '/saved-foods', '/scan-food'];

const settle = async (page, wait, ms = 600) => {
  await page.waitForLoadState('networkidle');
  await wait(ms);
};
const go = async (page, url, wait) => {
  await mockOnlineFoods(page); // never hit the live APIs from tests
  await page.goto(url, { waitUntil: 'networkidle' });
  await wait(600);
};
const visible = (page, text) => page.getByText(text, { exact: true }).count();
const btn = (page, name) => page.getByRole('button', { name, exact: true });

// Deterministic stand-ins for the two online food databases (shapes match the
// live APIs; see src/lib/foodSearch.ts). `failOnline` simulates an outage.
let failOnline = false;
const USDA_FIXTURE = {
  foods: [
    {
      fdcId: 173944,
      description: 'Bananas, raw',
      foodNutrients: [
        { nutrientId: 1008, value: 89 },
        { nutrientId: 1003, value: 1.09 },
        { nutrientId: 1005, value: 22.8 },
        { nutrientId: 1004, value: 0.33 },
        { nutrientId: 1079, value: 2.6 },
        { nutrientId: 2000, value: 12.2 },
        { nutrientId: 1093, value: 1 },
      ],
    },
  ],
};
const OFF_FIXTURE = {
  hits: [
    { code: '3017620422003', product_name: 'Nutella', brands: ['Ferrero'], nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, sodium_100g: 0.043 } },
    { code: '0000000000001', product_name: 'No calories listed', brands: ['Skip'], nutriments: {} },
  ],
};
const mocked = new WeakSet();
export async function mockOnlineFoods(page) {
  if (mocked.has(page)) return;
  mocked.add(page);
  // Like the real APIs, only return items whose name contains the search term.
  const reply = (param, key, fixture, name) => (route) => {
    if (failOnline) return route.fulfill({ status: 503, body: 'down' });
    const q = (new URL(route.request().url()).searchParams.get(param) || '').toLowerCase();
    const body = { [key]: fixture[key].filter((x) => name(x).toLowerCase().includes(q)) };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  };
  await page.route('https://api.nal.usda.gov/**', reply('query', 'foods', USDA_FIXTURE, (f) => f.description));
  await page.route('https://search.openfoodfacts.org/**', reply('q', 'hits', OFF_FIXTURE, (h) => h.product_name));
}

export const flows = [
  {
    name: 'online search: USDA + Open Food Facts results are mapped and listed',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('nutella');
      await page.getByText('USDA & Open Food Facts').waitFor({ timeout: 5000 });
      if ((await page.getByText('Ferrero · 100 g · 539 cal · Open Food Facts').count()) === 0) throw new Error('OFF row not mapped');
      if ((await page.getByText('No calories listed').count()) > 0) throw new Error('product without calories was not skipped');
      await page.getByLabel('Search foods').fill('banana');
      await page.getByText('100 g · 89 cal · USDA').waitFor({ timeout: 5000 });
      if ((await visible(page, 'Bananas, raw')) === 0) throw new Error('USDA food missing');
    },
  },
  {
    name: 'online search: add a USDA food -> shows on Home',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await page.getByText('100 g · 89 cal · USDA').waitFor({ timeout: 5000 });
      await btn(page, 'Bananas, raw').click();
      await btn(page, 'Add Bananas, raw to log').click();
      await settle(page, wait);
      await go(page, base + '/', wait);
      if ((await visible(page, 'Bananas, raw')) === 0) throw new Error('USDA food not on Home');
    },
  },
  {
    name: 'online search: saved Open Food Facts product survives reload (snapshot)',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('nutella');
      await page.getByText('Ferrero · 100 g · 539 cal · Open Food Facts').waitFor({ timeout: 5000 });
      await btn(page, 'Save Nutella').click();
      await go(page, base + '/saved-foods', wait);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(600);
      if ((await visible(page, 'Nutella')) === 0) throw new Error('saved OFF product missing');
      if ((await page.getByText('Sodium').count()) > 0) throw new Error('unexpected detail view');
    },
  },
  {
    name: 'online search: outage shows a message and keeps Kalo foods',
    // The simulated 503s are logged by the browser itself; they are the point of this flow.
    allowErrors: /Failed to load resource: the server responded with a status of 503/,
    run: async (page, base, { wait }) => {
      failOnline = true;
      try {
        await go(page, base + '/food-database', wait);
        await page.getByLabel('Search foods').fill('apple');
        await page.getByText(/Couldn't reach/).waitFor({ timeout: 5000 });
        if ((await visible(page, 'Apple')) === 0) throw new Error('local Apple missing during outage');
        // No local match either: the outage line explains it, not "No foods match".
        await page.getByLabel('Search foods').fill('zzqx');
        await page.getByText(/Couldn't reach/).waitFor({ timeout: 5000 });
        if ((await page.getByText(/No foods match/).count()) > 0) throw new Error('"No foods match" shown during an outage');
      } finally {
        failOnline = false;
      }
    },
  },
  {
    name: 'food database: search "banana" -> add to log -> shows on Home',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await wait(200);
      await btn(page, 'Banana').click();
      await btn(page, 'Add Banana to log').click();
      await settle(page, wait);
      await go(page, base + '/', wait);
      if ((await visible(page, 'Banana')) === 0) throw new Error('Banana not on Home after adding');
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Banana')) === 0) throw new Error('Banana did not persist on Home');
    },
  },
  {
    name: 'food database: no-results message',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('zzqx');
      // Not while the online search is still running (no one-frame flash)...
      if ((await page.getByText('No foods match "zzqx"').count()) > 0) throw new Error('no-results shown before online search finished');
      // ...only once the (mocked) online search has also come back empty.
      await page.getByText('No foods match "zzqx"').waitFor({ timeout: 5000 });
    },
  },
  {
    name: 'bookmark a food -> appears in Saved foods',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('avocado');
      await wait(200);
      if ((await btn(page, 'Save Avocado').count()) > 0) await btn(page, 'Save Avocado').click();
      if ((await btn(page, 'Unsave Avocado').count()) === 0) throw new Error('bookmark did not toggle on');
      await go(page, base + '/saved-foods', wait);
      if ((await visible(page, 'Avocado')) === 0) throw new Error('Avocado not in saved foods');
    },
  },
  {
    name: 'remove a saved food -> gone after reload',
    run: async (page, base, { wait }) => {
      await go(page, base + '/saved-foods', wait);
      if ((await btn(page, 'Remove Avocado').count()) === 0) throw new Error('no remove button for Avocado');
      await btn(page, 'Remove Avocado').click();
      await wait(300);
      if ((await visible(page, 'Avocado')) > 0) throw new Error('Avocado still listed after remove');
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await visible(page, 'Avocado')) > 0) throw new Error('Avocado came back after reload');
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

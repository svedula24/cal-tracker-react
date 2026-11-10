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

export const flows = [
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
      await wait(200);
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

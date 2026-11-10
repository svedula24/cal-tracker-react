// Logging-screen flows (Food Database, Saved foods, Log exercise, Entry detail).
// Shape matches e2e/flows.mjs. Flows share one page, so state carries over;
// each flow guards its own preconditions.

export const routes = ['/food-database', '/saved-foods', '/log-exercise', '/scan-food'];

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
      await wait(200);
      if ((await page.getByText('No foods match "zzqx"').count()) === 0) throw new Error('no-results text missing');
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
    name: 'log exercise (Run 30 min) -> listed and persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/log-exercise', wait);
      const before = await btn(page, 'Delete Run').count();
      await btn(page, 'Run').click();
      await btn(page, '30 minutes').click();
      await btn(page, 'Log exercise').click();
      await settle(page, wait);
      await go(page, base + '/log-exercise', wait);
      if ((await page.getByText("Today's exercise").count()) === 0) throw new Error("no Today's exercise list");
      if ((await btn(page, 'Delete Run').count()) !== before + 1) throw new Error('Run not added to list');
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      if ((await btn(page, 'Delete Run').count()) !== before + 1) throw new Error('Run did not persist');
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

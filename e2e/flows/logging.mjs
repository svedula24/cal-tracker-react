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

// Time from setting the search text to its results (or the no-results line) being painted.
const timeQuery = (page, q) =>
  page.evaluate(async (q) => {
    const input = document.querySelector('[aria-label="Search foods"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const first = q.toLowerCase().split(' ')[0];
    const shown = () => {
      if (!q) return !document.querySelector('[role="button"][aria-label]') || document.body.innerText.includes('Works offline');
      if (document.body.innerText.includes(`No foods match "${q}"`)) return true;
      const row = [...document.querySelectorAll('[role="button"]')].find((e) => / cal$/m.test(e.innerText || ''));
      return !!row && row.innerText.toLowerCase().split('\n')[0].split(/[^a-z0-9]+/).some((w) => w.startsWith(first));
    };
    const t0 = performance.now();
    setValue.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise((resolve) => {
      const check = () => (shown() ? requestAnimationFrame(() => resolve(performance.now() - t0)) : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
  }, q);

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
    // Hard requirement: results within 200 ms of a keystroke on a low-end phone,
    // simulated with a 6x CPU slowdown. Timed inside the page (keystroke to the
    // results painted); median of 3 runs per query to absorb machine noise.
    name: 'food database: search speed is under 200 ms per keystroke (6x CPU slowdown)',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.waitForFunction(() => /Search [\d,]+ foods/.test(document.querySelector('[aria-label="Search foods"]')?.placeholder || ''));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      try {
        const slow = [];
        for (const q of ['b', 'ban', 'banana', 'c', 's', 'chicken breast', 'greek yog', 'raw', 'apple', 'zzqx']) {
          const runs = [];
          for (let i = 0; i < 3; i++) runs.push(await timeQuery(page, q), await timeQuery(page, ''));
          const ms = runs.filter((_, j) => j % 2 === 0).sort((a, b) => a - b)[1];
          if (ms > 200) slow.push(`${q}=${Math.round(ms)}ms`);
        }
        if (slow.length) throw new Error(`over the 200 ms budget: ${slow.join(', ')}`);
      } finally {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await cdp.detach();
      }
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

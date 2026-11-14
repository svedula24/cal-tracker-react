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

// A nutrient card on the Nutrition screen ("Calories", "Protein", …) is a field: wait for its value.
const expectValue = async (page, label, value) => {
  const field = page.getByLabel(label, { exact: true });
  let got;
  for (let i = 0; i < 30; i++) {
    got = await field.inputValue().catch(() => undefined);
    if (got === value) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`expected the ${label} card to show ${value}, it shows ${got}`);
};
const expectCalories = (page, value) => expectValue(page, 'Calories', value);

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
      // The Home card, not any "Breakfast" text: the name field is still mounted while the screen closes.
      await page.getByLabel('Edit Breakfast').waitFor({ timeout: 5000 });
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
  {
    name: 'nutrition: a typed nutrient value is kept, scales with the amount, and persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await btn(page, 'Banana, raw').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await page.getByLabel('Food name').fill('Edited banana');
      await page.getByLabel('Grams').fill('100');
      await expectValue(page, 'Protein', '0.7'); // USDA: 0.74 g per 100 g
      // An invalid draft changes nothing and is dropped when the field is left.
      await page.getByLabel('Protein', { exact: true }).fill('abc');
      await page.getByLabel('Grams').click();
      await expectValue(page, 'Protein', '0.7');
      // Retyping the shown value is not an edit: the exact 0.74 stays, so 1000 g still shows 7.4.
      await page.getByLabel('Protein', { exact: true }).fill('0.7');
      await page.getByLabel('Grams').fill('1000');
      await expectValue(page, 'Protein', '7.4');
      await page.getByLabel('Grams').fill('100');
      // A value that rounds to the same display is still an edit: 0.72 also shows "0.7".
      await page.getByLabel('Protein', { exact: true }).fill('0.72');
      await page.getByLabel('Grams').fill('1000');
      await expectValue(page, 'Protein', '7.2');
      await page.getByLabel('Grams').fill('100');
      await page.getByLabel('Protein', { exact: true }).fill('5');
      await page.getByLabel('Calories', { exact: true }).fill('150');
      await page.getByLabel('Grams').fill('200');
      await expectValue(page, 'Protein', '10');
      await expectCalories(page, '300');
      await expectValue(page, 'Carbs', '45'); // untouched: 22.7 g per 100 g
      await btn(page, 'Done').click();
      await page.getByText(/300 Calories/).waitFor({ timeout: 5000 });
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      await page.getByText('Edited banana', { exact: true }).first().click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      if ((await page.getByLabel('Grams').inputValue()) !== '200') throw new Error('the edited entry did not reopen at 200 g');
      await expectValue(page, 'Protein', '10');
      await expectCalories(page, '300');
      // Editing a logged entry: a 0 is a value, and it persists too.
      await page.getByLabel('Fats', { exact: true }).fill('0');
      await btn(page, 'Done').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await page.getByText('Edited banana', { exact: true }).first().click();
      await expectValue(page, 'Fats', '0');
      // A bookmark from the edited entry saves the database food, not the typed values.
      if ((await btn(page, 'Unsave Banana, raw').count()) > 0) await btn(page, 'Unsave Banana, raw').click();
      await btn(page, 'Save Banana, raw').click();
      await btn(page, 'Unsave Banana, raw').waitFor({ timeout: 3000 });
      await go(page, base + '/saved-foods', wait);
      await page.getByText('1 banana (126 g) · 122 cal').waitFor({ timeout: 3000 }); // USDA's 97 kcal per 100 g, not the typed 150
      await go(page, base + '/', wait);
      await page.getByText('Edited banana', { exact: true }).first().click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await btn(page, 'More options').click();
      await btn(page, 'Delete entry').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
    },
  },
  {
    // Self-contained: logs its own food and deletes the two entries it creates.
    name: 'quick add: a recent food on the + menu opens Nutrition at its last amount; Done logs a new entry',
    run: async (page, base, { wait }) => {
      const recent = (grams) => btn(page, `Log Avocado, raw again, ${grams} g`);
      const openMenu = async () => {
        await btn(page, 'Add').click();
        await btn(page, 'Scan food').waitFor({ timeout: 3000 });
        await wait(400); // the tiles spring in
      };
      const openEntry = async (name) => {
        await btn(page, `Edit ${name}`).first().click();
        await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      };
      const deleteEntry = async (name) => {
        await openEntry(name);
        await btn(page, 'More options').click();
        await btn(page, 'Delete entry').click();
        await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
        await wait(400);
      };

      // Log 80 g of avocado (its serving is 150 g) under another name.
      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('avocado raw');
      await btn(page, 'Avocado, raw').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      if ((await page.getByLabel('Grams').inputValue()) !== '150') throw new Error('avocado should start at its serving, 150 g');
      await page.getByLabel('Grams').fill('80');
      await page.getByLabel('Food name').fill('Quick add test');
      await btn(page, 'Done').click();
      await btn(page, 'Edit Quick add test').waitFor({ timeout: 5000 });
      await wait(400);

      // The + menu offers the database food (not the renamed label) at that amount.
      await openMenu();
      await page.getByText('Recent', { exact: true }).waitFor({ timeout: 3000 });
      await recent(80).waitFor({ timeout: 3000 });
      if ((await recent(80).innerText()) !== 'Avocado, raw\n80 g · 128 cal') throw new Error(`recent row reads "${await recent(80).innerText()}"`);
      const rows = await page.getByRole('button', { name: /^Log .+ again/ }).count();
      if (rows > 3) throw new Error(`${rows} recent foods offered, at most 3 expected`);
      // The card must not push the tiles or the close button away.
      for (const name of ['Saved foods', 'Food Database', 'Scan food']) {
        const box = await btn(page, name).boundingBox();
        if (!box || box.y < 0 || box.y + box.height > page.viewportSize().height) throw new Error(`${name} tile is off screen with Recent shown`);
      }
      // It is a card like the tiles: on screen, as wide as the full-width tile, with the same background.
      const card = page.getByLabel('Recent foods', { exact: true });
      const [cardBox, scanBox] = [await card.boundingBox(), await btn(page, 'Scan food').boundingBox()];
      if (cardBox.y < 0) throw new Error('the Recent card runs off the top of the screen');
      if (Math.abs(cardBox.width - scanBox.width) > 1 || Math.abs(cardBox.x - scanBox.x) > 1) throw new Error(`the Recent card is ${cardBox.width}px wide at x ${cardBox.x}, the tiles ${scanBox.width}px at ${scanBox.x}`);
      const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
      if ((await bg(card)) !== (await bg(btn(page, 'Scan food')))) throw new Error(`the Recent card's background is ${await bg(card)}: className lost`);
      if (cardBox.y + cardBox.height > (await btn(page, 'Saved foods').boundingBox()).y) throw new Error('the Recent card overlaps the tiles');

      // Tapping it opens Nutrition prefilled; nothing is logged until Done.
      await recent(80).click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      if (!/\/nutrition\?/.test(page.url())) throw new Error(`expected /nutrition, got ${page.url()}`);
      if ((await page.getByLabel('Grams').inputValue()) !== '80') throw new Error(`Grams starts at ${await page.getByLabel('Grams').inputValue()}, not 80`);
      if ((await page.getByLabel('Food name').inputValue()) !== 'Avocado, raw') throw new Error('the name is not the database name');
      await expectCalories(page, '128');
      await page.getByText('1 fruit = 150 g').waitFor({ timeout: 2000 }); // the serving hint is unchanged
      if ((await btn(page, 'More options').count()) > 0) throw new Error('opened an existing entry instead of a new food');
      const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('entries')).filter((e) => e.foodId === 'usda:2709223').length);
      if ((await stored()) !== 1) throw new Error(`tapping a recent food logged it: ${await stored()} avocado entries before Done`);
      await page.getByLabel('Grams').fill('90');
      await expectCalories(page, '144');
      await btn(page, 'Done').click();
      await btn(page, 'Edit Avocado, raw').waitFor({ timeout: 5000 });
      await wait(400);

      // A new entry beside the first: nothing merged, the first one untouched.
      if ((await btn(page, 'Edit Avocado, raw').count()) !== 1 || (await btn(page, 'Edit Quick add test').count()) !== 1) throw new Error('expected the first entry and one new entry on Home');
      if ((await stored()) !== 2) throw new Error(`expected 2 avocado entries, found ${await stored()}`);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      await openEntry('Quick add test');
      if ((await page.getByLabel('Grams').inputValue()) !== '80') throw new Error('the first entry changed');
      await btn(page, 'Back').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await wait(400);

      // One row per food, now at the newer amount; opening it again starts from that amount.
      await openMenu();
      await recent(90).waitFor({ timeout: 3000 });
      if ((await recent(80).count()) > 0) throw new Error('the food is listed twice, or at its older amount');
      await recent(90).click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      if ((await page.getByLabel('Grams').inputValue()) !== '90') throw new Error(`reopened at ${await page.getByLabel('Grams').inputValue()} g, not 90`);
      await btn(page, 'Back').click(); // leaves without logging
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await wait(400);
      if ((await stored()) !== 2) throw new Error('Back from a recent food logged an entry');

      // Clean up, so later flows and Home's totals are unaffected; a deleted entry is no longer recent.
      await go(page, base + '/', wait);
      await deleteEntry('Avocado, raw');
      await openMenu();
      await recent(80).waitFor({ timeout: 3000 }); // back to the remaining entry's amount
      await btn(page, 'Close menu').last().click();
      await wait(300);
      await deleteEntry('Quick add test');
      if ((await stored()) !== 0) throw new Error('clean-up left an avocado entry');
      await openMenu();
      if ((await page.getByRole('button', { name: /^Log Avocado, raw again/ }).count()) > 0) throw new Error('a deleted food is still under Recent');
      await btn(page, 'Close menu').last().click();
      await wait(300);
    },
  },
  {
    // Self-contained: logs one banana under its own name and deletes it.
    name: 'nutrition: the amount can be typed in g, oz or a portion; the entry reopens in its unit',
    run: async (page, base, { wait }) => {
      const NAME = 'Unit test banana';
      const chips = () => page.getByRole('button', { name: /^Measure in / });
      const chip = (label) => btn(page, `Measure in ${label}`);
      // The selected chip is filled (bg-foreground), the others are cards. Read from the paint, not
      // aria-selected: react-native-web 0.21 drops accessibilityState, so it never reaches the DOM.
      const selected = () =>
        chips().evaluateAll((els) => {
          const bg = els.map((el) => getComputedStyle(el).backgroundColor);
          const count = (c) => bg.filter((x) => x === c).length;
          return els.filter((_, i) => count(bg[i]) === 1).map((el) => el.getAttribute('aria-label').replace('Measure in ', '')).join(', ');
        });
      const expectSelected = async (label) => {
        const on = await selected();
        if (on !== label) throw new Error(`expected the ${label} chip selected, selected: ${on || 'none'}`);
      };
      const expectField = async (label, value) => {
        const field = page.getByLabel(label, { exact: true });
        await field.waitFor({ timeout: 3000 }).catch(() => {
          throw new Error(`no amount field labelled "${label}"`);
        });
        if ((await field.inputValue()) !== value) throw new Error(`${label} shows ${await field.inputValue()}, not ${value}`);
      };
      const stored = () => page.evaluate((n) => JSON.parse(localStorage.getItem('entries') ?? '[]').filter((e) => e.name === n), NAME);
      const openEntry = async () => {
        await btn(page, `Edit ${NAME}`).first().click();
        await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      };

      await go(page, base + '/food-database', wait);
      await page.getByLabel('Search foods').fill('banana');
      await btn(page, 'Banana, raw').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await page.getByLabel('Food name').fill(NAME);

      // One chip per unit: grams, ounces, then the banana's USDA portions; grams selected.
      const labels = await chips().evaluateAll((els) => els.map((el) => el.getAttribute('aria-label').replace('Measure in ', '')));
      const want = ['g', 'oz', '1 banana', '1 slice', '1 cup', '1 cup, mashed', '1 linear inch'];
      if (labels.join(' | ') !== want.join(' | ')) throw new Error(`unit chips: ${labels.join(' | ')}`);
      await expectSelected('g');
      await page.getByText('1 banana = 126 g', { exact: true }).waitFor({ timeout: 2000 });

      // Switching units converts what the field shows; the amount and the cards stay.
      await page.getByLabel('Grams').fill('252');
      await expectCalories(page, '244');
      await chip('oz').click();
      await expectSelected('oz');
      await expectField('Ounces', '8.89'); // 252 / 28.3495
      if ((await page.getByLabel('Grams').count()) > 0) throw new Error('the field is still labelled Grams in ounces');
      await expectCalories(page, '244');
      await page.getByText('252 g', { exact: true }).waitFor({ timeout: 2000 });

      // Typed in ounces: 4 oz = 113.4 g × 0.97 kcal/g.
      await page.getByLabel('Ounces', { exact: true }).fill('4');
      await expectCalories(page, '110');
      await page.getByText('113 g', { exact: true }).waitFor({ timeout: 2000 });

      // In a portion: the field shows bananas, the hint the portion and the total.
      await chip('1 banana').click();
      await expectSelected('1 banana');
      await expectField('Amount in 1 banana', '0.9'); // 113.4 / 126
      await expectCalories(page, '110');
      await page.getByText('1 banana = 126 g · 113 g in all', { exact: true }).waitFor({ timeout: 2000 });
      await page.getByLabel('Amount in 1 banana', { exact: true }).fill('2');
      await expectCalories(page, '244');
      await page.getByText('1 banana = 126 g · 252 g in all', { exact: true }).waitFor({ timeout: 2000 });
      await btn(page, 'Done').click();

      // Logged as 2 bananas; marked the user's, so the load-time guess cannot take it for demo data.
      await btn(page, `Edit ${NAME}`).waitFor({ timeout: 5000 });
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      const card = btn(page, `Edit ${NAME}`);
      if (!/244 Calories/.test(await card.innerText())) throw new Error(`Home card reads "${(await card.innerText()).replace(/\n/g, ' / ')}"`);
      const check = async (when) => {
        const rows = await stored();
        if (rows.length !== 1) throw new Error(`${when}: ${rows.length} stored entries named ${NAME}`);
        const [e] = rows;
        if (e.seed !== false) throw new Error(`${when}: a logged entry measured in a portion is stored with seed ${e.seed}`);
        if (e.measure?.label !== '1 banana' || e.measure?.grams !== 126 || e.servings !== 2) throw new Error(`${when}: stored as ${e.servings} × ${JSON.stringify(e.measure)}`);
        if (Math.abs(e.nutrients.calories - 122.22) > 1e-6) throw new Error(`${when}: nutrients per banana are ${e.nutrients.calories} kcal, not 122.22`);
      };
      await check('after Done');

      await openEntry();
      await expectSelected('1 banana');
      await expectField('Amount in 1 banana', '2');
      await expectCalories(page, '244');
      await btn(page, 'Back').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });

      // After a reload (stored entries are migrated at load) it still opens in bananas.
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      await check('after a reload');
      await openEntry();
      await expectSelected('1 banana');
      await expectField('Amount in 1 banana', '2');
      await expectCalories(page, '244');

      // Clean up, so later flows and Home's totals are unaffected.
      await btn(page, 'More options').click();
      await btn(page, 'Delete entry').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      await wait(400);
      if ((await stored()).length !== 0) throw new Error('clean-up left the entry in storage');
      if ((await btn(page, `Edit ${NAME}`).count()) > 0) throw new Error('clean-up left the entry on Home');
    },
  },
];

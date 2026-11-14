// Kalo verification spec, consumed by e2e/verify.mjs (`npm run verify`).
// Flows share one browser page and run in order: Home's seed checks first (the
// first launch must match the reference screenshots), then the logging screens.
import * as goals from './flows/goals.mjs';
import * as logging from './flows/logging.mjs';

const go = async (page, url, wait) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByText('Recently uploaded').waitFor({ timeout: 8000 }).catch(() => {});
  await wait(500);
};
const must = async (page, text, why) => {
  if ((await page.getByText(text, { exact: true }).count()) === 0) throw new Error(`${why}: "${text}" not visible`);
};
const btn = (page, name) => page.getByRole('button', { name, exact: true });

const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
};

const home = [
  {
    name: 'home: first launch matches the reference numbers',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      for (const t of ['2543', '/3429', '+200', '+202', '174', '322', '/433g', '59', 'Honey']) await must(page, t, 'seed');
      await btn(page, 'Daily score 89').waitFor({ timeout: 3000 });
    },
  },
  {
    // Press animates on the UI thread and routes className through NativeWind
    // itself; this fails if either stops reaching the button.
    name: 'home: the + button keeps its classes and springs down while pressed',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      const fab = btn(page, 'Add');
      const css = () => fab.evaluate((el) => ({ w: getComputedStyle(el).width, t: getComputedStyle(el).transform }));
      const idle = await css();
      if (idle.w !== '53px') throw new Error(`+ button is ${idle.w} wide, not 53px: className lost`);
      const box = await fab.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await wait(150);
      const held = await css();
      await page.mouse.up();
      const scale = Number(held.t.match(/matrix\(([^,]+)/)?.[1] ?? 1);
      if (!(scale < 0.95)) throw new Error(`+ button did not shrink while pressed (transform ${held.t})`);
      await wait(400); // let the spring settle before the next flow
    },
  },
  {
    name: 'home: calories eaten <-> left toggle',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Show calories left').click();
      await must(page, 'Calories left', 'toggle');
      await must(page, '886', 'calories left value');
      await btn(page, 'Show calories eaten').click();
      await must(page, 'Calories eaten', 'toggle back');
    },
  },
  {
    name: 'home: carousel pages 2 and 3',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Page 2').click();
      await wait(500);
      await must(page, '7/10', 'health score');
      await btn(page, 'Page 3').click();
      await wait(500);
      await must(page, '5,782', 'steps');
    },
  },
  {
    name: 'home: daily score sheet opens and links to score info',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Daily score 89').click();
      await wait(500);
      await must(page, 'Great balance', 'sheet');
      await must(page, 'Adjust', 'fat row');
      await btn(page, 'How Daily Score Works').click();
      await wait(600);
      if (!page.url().endsWith('/score-info')) throw new Error(`expected /score-info, got ${page.url()}`);
    },
  },
  {
    name: 'home: selecting a past day shows that day',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, yesterday()).click();
      await wait(400);
      await must(page, 'Oatmeal', 'past day entries');
      if ((await page.getByText('Honey', { exact: true }).count()) > 0) throw new Error("today's Honey still shown");
    },
  },
  {
    // Must stay ahead of every flow that logs a food: storage is shared, and this is the fresh install.
    name: 'home: a fresh install (demo data only) has no Recent foods on the + menu',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      // The demo data includes real database foods (the past days): they must not be offered.
      const demoFoods = await page.evaluate(() => JSON.parse(localStorage.getItem('entries') ?? '[]').filter((e) => e.seed && e.foodId).length);
      if (demoFoods === 0) throw new Error('no demo entries of database foods in storage: this check would prove nothing');
      await btn(page, 'Add').click();
      await btn(page, 'Scan food').waitFor({ timeout: 3000 });
      await wait(400);
      if ((await page.getByText('Recent', { exact: true }).count()) > 0) throw new Error('Recent card shown with demo data only');
      const rows = await page.getByRole('button', { name: /^Log .+ again/ }).count();
      if (rows > 0) throw new Error(`${rows} recent food(s) offered with demo data only`);
      await btn(page, 'Close menu').last().click();
      await wait(300);
      if ((await btn(page, 'Scan food').count()) > 0) throw new Error('the + menu did not close');
    },
  },
  {
    name: 'home: + menu opens Food Database',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Add').click();
      await btn(page, 'Food Database').click();
      await wait(600);
      if (!page.url().endsWith('/food-database')) throw new Error(`expected /food-database, got ${page.url()}`);
    },
  },
  {
    name: 'home: swipe an entry left -> Delete removes it, persists',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      const card = page.getByRole('button', { name: 'Edit Sandwich', exact: true });
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (!box) throw new Error('Sandwich card not rendered');
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width - 20, y);
      await page.mouse.down();
      // Delete sits behind the card: pressing (the card shrinks and dims) must not show it, only a swipe.
      const slot = (prop) => btn(page, 'Delete Sandwich').evaluate((el, p) => getComputedStyle(el.parentElement)[p], prop);
      const deleteOpacity = () => slot('opacity');
      await wait(250);
      if ((await deleteOpacity()) !== '0') throw new Error('Delete is visible behind a pressed card');
      if ((await slot('pointerEvents')) !== 'none') throw new Error('hidden Delete still takes touches');
      for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width - 20 - i * 15, y);
      await page.mouse.up();
      await wait(500);
      if ((await deleteOpacity()) !== '1') throw new Error('Delete is not visible after the swipe');
      if ((await slot('pointerEvents')) === 'none') throw new Error('Delete takes no touches after the swipe');
      await btn(page, 'Delete Sandwich').click();
      await wait(300);
      await go(page, base + '/', wait);
      if ((await page.getByText('Sandwich', { exact: true }).count()) > 0) throw new Error('Sandwich still listed');
    },
  },
];

export const routes = ['/', ...logging.routes, '/daily-score', '/score-info', '/nutrition', ...goals.routes];
export const flows = [...home, ...logging.flows, ...goals.flows];

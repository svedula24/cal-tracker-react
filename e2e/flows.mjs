// Kalo verification spec, consumed by e2e/verify.mjs (`npm run verify`).
// Flows share one browser page and run in order: Home's seed checks first (the
// first launch must match the reference screenshots), then the logging screens.
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
      for (const t of ['2543', '/3429', '+200', '+202', '174', '322', '59', 'Honey']) await must(page, t, 'seed');
      await btn(page, 'Daily score 89').waitFor({ timeout: 3000 });
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
    name: 'home: Log Water adds cups and persists across reload',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Page 3').click();
      await btn(page, 'Log Water').click();
      await btn(page, 'Log Water').click();
      await must(page, '16 fl oz (2 cups)', 'after logging');
      await go(page, base + '/', wait);
      await must(page, '16 fl oz (2 cups)', 'after reload');
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
      for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width - 20 - i * 15, y);
      await page.mouse.up();
      await wait(500);
      await btn(page, 'Delete Sandwich').click();
      await wait(300);
      await go(page, base + '/', wait);
      if ((await page.getByText('Sandwich', { exact: true }).count()) > 0) throw new Error('Sandwich still listed');
    },
  },
];

export const routes = ['/', ...logging.routes, '/daily-score', '/score-info'];
export const flows = [...home, ...logging.flows];

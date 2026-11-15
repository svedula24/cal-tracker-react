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
    name: 'home: the day strip scrolls back a week; a past day shows; Today returns',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      const day = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
      };
      // react-native-web drops aria-selected on buttons; the active day is the one with the card.
      const selected = async (name) => /(^| )bg-card( |$)/.test((await btn(page, name).getAttribute('class')) ?? '');
      const visible = async (name) => {
        const box = await btn(page, name).boundingBox().catch(() => null);
        return !!box && box.x >= 0 && box.x + box.width <= 402;
      };
      if (await btn(page, 'Today').count()) throw new Error('Today control shown before scrolling away');
      // Page 0 fills the width: its first and last cells sit at the 22px margins.
      const first = await btn(page, day(-5)).boundingBox();
      const last = await btn(page, day(1)).boundingBox();
      if (Math.round(first.x) !== 22 || Math.round(402 - last.x - last.width) !== 22)
        throw new Error(`page 0 cells at ${first.x}..${last.x + last.width}, not 22px from each edge`);
      // Scroll the strip one page back (a horizontal trackpad swipe towards the past).
      const strip = await btn(page, day(0)).boundingBox();
      await page.mouse.move(201, strip.y + strip.height / 2);
      await page.mouse.wheel(-402, 0);
      await wait(900);
      if (!(await visible(day(-6))) || !(await visible(day(-12)))) throw new Error('strip did not show the previous week');
      if (await visible(day(0))) throw new Error('today still on screen after scrolling back');
      await btn(page, 'Today').waitFor({ timeout: 2000 });
      // Select a day on that page: Home shows it (selected, and it has no meals logged).
      await btn(page, day(-10)).click();
      await wait(400);
      if (!(await selected(day(-10)))) throw new Error(`${day(-10)} not selected`);
      await must(page, 'Tap + to log your first meal of the day.', 'empty past day');
      if ((await page.getByText('Honey', { exact: true }).count()) > 0) throw new Error("today's Honey still shown");
      await page.screenshot({ path: 'e2e/shots/index_previous-week.png' });
      // Today: back to the first page with today selected, and the control goes away.
      await btn(page, 'Today').click();
      await wait(900);
      if (!(await visible(day(0))) || !(await selected(day(0)))) throw new Error('Today did not bring back today');
      await must(page, 'Honey', "today's entries");
      if (await btn(page, 'Today').count()) throw new Error('Today control still shown on today');
    },
  },
  {
    name: 'home: the + menu has its three tiles and no Recent card, and closes',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      await btn(page, 'Add').click();
      await btn(page, 'Scan barcode').waitFor({ timeout: 3000 });
      for (const tile of ['Saved foods', 'Food Database']) if ((await btn(page, tile).count()) === 0) throw new Error(`no ${tile} tile`);
      if ((await page.getByText('Recent', { exact: true }).count()) > 0) throw new Error('a Recent card is shown');
      await btn(page, 'Close menu').last().click();
      await wait(300);
      if ((await btn(page, 'Scan barcode').count()) > 0) throw new Error('the + menu did not close');
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

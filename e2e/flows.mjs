// Kalo verification spec, consumed by e2e/verify.mjs (`npm run verify`).
// Flows share one browser page and run in order, on test data (e2e/fixture.mjs, written before
// the app loads: `setup`): Home's checks first (the test data's day matches the reference
// screenshots), then the logging screens. The app itself starts empty: the first flow checks that
// on a page of its own, without the test data.
import { DEFAULT_GOAL, PAST_DAYS, referenceDay } from './fixture.mjs';
import * as goals from './flows/goals.mjs';
import * as logging from './flows/logging.mjs';

/** Called by e2e/verify.mjs once, before the shared page loads anything. */
export const setup = (page) => referenceDay(page);

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

const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

const home = [
  {
    name: 'a new install starts empty: no entries, saved foods or day logs, only the default goal',
    run: async (page, base, { wait }) => {
      const fresh = await page.context().browser().newPage({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block' });
      try {
        await go(fresh, base + '/', wait);
        await must(fresh, 'Tap + to log your first meal of the day.', 'empty today');
        await must(fresh, '/3027', "the default goal's budget");
        await fresh.getByLabel('0 day streak', { exact: true }).waitFor({ timeout: 3000 });
        await go(fresh, base + '/saved-foods', wait); // loads the saved foods too (Home does not)
        if ((await fresh.getByRole('button', { name: /^Remove .+/ }).count()) > 0) throw new Error('a new install has saved foods');
        for (const key of ['entries', 'savedFoods', 'dayLogs']) {
          const items = await stored(fresh, key);
          if (!Array.isArray(items) || items.length) throw new Error(`stored ${key} is ${JSON.stringify(items)?.slice(0, 200)}, not []`);
        }
        const rows = await stored(fresh, 'goals');
        if (JSON.stringify(rows) !== JSON.stringify([DEFAULT_GOAL])) throw new Error(`stored goals are ${JSON.stringify(rows)}`);
      } finally {
        await fresh.close();
      }
    },
  },
  {
    name: "an older version's demo entries are dropped at load (guessed ones while they still look like the demo); the user's are kept",
    run: async (page, base, { wait }) => {
      const old = await page.context().browser().newPage({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block' });
      try {
        await go(old, base + '/', wait);
        const mine = await old.evaluate(() => {
          const now = new Date();
          const p = (n) => String(n).padStart(2, '0');
          const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
          const at = (h) => new Date(`${date}T${p(h)}:00:00`).toISOString();
          const nutrients = { calories: 100, protein: 1, carbs: 1, fat: 1, fiber: 0, sugar: 0, sodium: 0 };
          const entry = (name, h, flags) => ({ id: crypto.randomUUID(), date, time: at(h), name, servings: 1, nutrients, ...flags });
          const mine = [
            entry('My soup', 12, { seed: false }),
            // Guessed demo at an earlier load, but renamed since: it may be the user's, so it is kept.
            entry('Grandma soup', 13, { seed: true, seedGuessed: true }),
          ];
          const demo = [
            entry('Honey', 8, { seed: true }), // seeded by an older version
            entry('Sandwich', 9, { seed: true, seedGuessed: true }), // tagged by the guess at an earlier load
            entry('Whole Milk Latte', 10, {}), // from before the flag: no food, so guessed demo now
          ];
          localStorage.setItem('entries', JSON.stringify([...demo, ...mine]));
          return mine;
        });
        await go(old, base + '/', wait);
        await btn(old, 'Edit My soup').waitFor({ timeout: 5000 });
        await btn(old, 'Edit Grandma soup').waitFor({ timeout: 5000 });
        await old.getByLabel('1 day streak', { exact: true }).waitFor({ timeout: 3000 }); // the demo entries do not count
        for (const name of ['Honey', 'Sandwich', 'Whole Milk Latte']) if ((await btn(old, `Edit ${name}`).count()) > 0) throw new Error(`demo entry ${name} still shown`);
        const left = await stored(old, 'entries');
        if (JSON.stringify(left) !== JSON.stringify(mine)) throw new Error(`stored entries are ${JSON.stringify(left).slice(0, 300)}`);
        // Editing the kept guessed entry makes it the user's: no longer flagged, so it syncs, and it is
        // never taken for demo again, even when renamed to a demo name with one serving.
        await btn(old, 'Edit Grandma soup').click();
        await old.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
        await old.getByLabel('Food name').fill('Honey');
        await btn(old, 'Done').click();
        await old.getByText('Recently uploaded').waitFor({ timeout: 5000 });
        await old.reload({ waitUntil: 'networkidle' });
        await wait(800);
        await btn(old, 'Edit Honey').waitFor({ timeout: 5000 });
        const edited = (await stored(old, 'entries')).find((e) => e.name === 'Honey');
        if (!edited || edited.seed !== false || 'seedGuessed' in edited) throw new Error(`the edited entry is still flagged: ${JSON.stringify(edited)}`);
      } finally {
        await old.close();
      }
    },
  },
  {
    name: "home: the test data's day matches the reference numbers",
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      for (const t of ['2543', '/3429', '+200', '+202', '174', '322', '/433g', '59', 'Honey']) await must(page, t, 'reference day');
      await btn(page, 'Daily score 89').waitFor({ timeout: 3000 });
      // The streak is computed from the entries: the test data logs today and the PAST_DAYS before it.
      await page.getByLabel(`${PAST_DAYS + 1} day streak`, { exact: true }).waitFor({ timeout: 3000 });
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
      // Two weeks only: a further swipe stays on this page, and day -13 is the oldest that exists.
      await page.mouse.wheel(-402, 0);
      await wait(900);
      if (!(await visible(day(-12)))) throw new Error('the strip went past the second week');
      if (await btn(page, day(-13)).count()) throw new Error('a day 13 days back is in the strip');
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
    // On web the paging ScrollView wraps each direct child in its own snap page: pages 2 and 3 must be
    // separate children, or they stack in one page and every page takes that page's height.
    name: 'home: the card pager has three pages side by side, each a screen wide',
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      const pages = await page.evaluate(() => {
        const pagers = [...document.querySelectorAll('div')].filter((d) => getComputedStyle(d).scrollSnapType.startsWith('x'));
        const pager = pagers.find((d) => (d.innerText || '').includes('Calories eaten'));
        if (!pager) return null;
        return [...pager.firstElementChild.children].map((k) => {
          const r = k.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), text: k.innerText || '' };
        });
      });
      if (!pages) throw new Error('no card pager with "Calories eaten" found');
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      if (pages.length !== 3) throw new Error(`the pager has ${pages.length} pages, expected 3: ${pages.map((p) => p.text.slice(0, 20)).join(' / ')}`);
      if (pages.some((p) => Math.abs(p.w - vw) > 1)) throw new Error(`pages are not a screen wide: ${pages.map((p) => p.w).join(', ')} vs ${vw}`);
      const [one, two, three] = pages.map((p) => p.text);
      if (!one.includes('Calories eaten') || !two.includes('Fiber') || two.includes('Steps') || !three.includes('Steps'))
        throw new Error('pages hold the wrong cards (2 and 3 combined?)');
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
    name: "home: switching days shows each day's entries; a food logged on a past day appears there",
    run: async (page, base, { wait }) => {
      await go(page, base + '/', wait);
      const now = new Date();
      const today = btn(page, `${now.toLocaleDateString('en-US', { weekday: 'short' })} ${now.getDate()}`);
      const past = btn(page, yesterday());
      const count = (text) => page.getByText(text, { exact: true }).count();
      // Listed and fully drawn (not left at the start of an animation).
      const opaque = (name) =>
        btn(page, `Edit ${name}`).first().evaluate((el) => {
          for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 0.99) return false;
          return true;
        });
      const expectDay = async (shown, hidden, why) => {
        await page.getByText(shown, { exact: true }).first().waitFor({ timeout: 3000 });
        if (!(await opaque(shown))) throw new Error(`${why}: ${shown} not fully shown`);
        if ((await count(hidden)) > 0) throw new Error(`${why}: ${hidden} still shown`);
      };
      // Quick switches back and forth settle on the last day tapped.
      await past.click();
      await today.click();
      await past.click();
      await wait(500);
      await expectDay('Oatmeal', 'Honey', 'yesterday after quick switches');
      await today.click();
      await wait(500);
      await expectDay('Honey', 'Oatmeal', 'today');
      // Log a food on yesterday: it shows there, not on today, and is still there on coming back.
      await past.click();
      await wait(400);
      if ((await count('Banana, raw')) > 0) throw new Error('Banana, raw already logged yesterday: this check would prove nothing');
      await btn(page, 'Add').click();
      await btn(page, 'Food Database').click();
      await page.getByLabel('Search foods').fill('banana');
      await btn(page, 'Banana, raw').click();
      await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
      await btn(page, 'Done').click();
      await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
      try {
        await wait(600);
        await expectDay('Banana, raw', 'Honey', 'yesterday after logging');
        await must(page, 'Oatmeal', 'yesterday after logging');
        await today.click();
        await wait(500);
        await expectDay('Honey', 'Banana, raw', 'today after logging yesterday');
        await past.click();
        await wait(500);
        await expectDay('Banana, raw', 'Honey', 'back on yesterday');
      } finally {
        // Delete it again, also after a failed check, so the later flows see the test data as it was.
        await past.click();
        await wait(400);
        if ((await count('Banana, raw')) > 0) {
          await btn(page, 'Edit Banana, raw').click();
          await page.getByText('Nutrition', { exact: true }).waitFor({ timeout: 5000 });
          await btn(page, 'More options').click();
          await btn(page, 'Delete entry').click();
          await page.getByText('Recently uploaded').waitFor({ timeout: 5000 });
          await wait(400);
        }
      }
      if ((await count('Banana, raw')) > 0) throw new Error('Banana, raw still listed after deleting it');
      await today.click();
      await wait(400);
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

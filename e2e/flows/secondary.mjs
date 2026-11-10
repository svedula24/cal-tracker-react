// Secondary screens: Progress, Groups, Profile, How Daily Score Works.
export const routes = ['/progress', '/groups', '/profile', '/score-info'];

const goto = async (page, url, wait) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await wait(600); // let AsyncStorage hydrate
};

export const flows = [
  {
    name: 'profile: calories goal edit persists across reload',
    run: async (page, base, { wait }) => {
      await goto(page, base + '/profile', wait);
      const input = page.getByLabel('Calories goal');
      await input.fill('2800');
      await wait(300);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      const v = await page.getByLabel('Calories goal').inputValue();
      if (v !== '2800') throw new Error(`Calories goal after reload = ${v}, expected 2800`);
    },
  },
  {
    name: 'profile: goal segment "Lose" persists across reload',
    run: async (page, base, { wait }) => {
      await goto(page, base + '/profile', wait);
      await page.getByRole('tab', { name: 'Lose' }).click();
      await wait(300);
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
      const sel = await page.getByRole('tab', { name: 'Lose' }).getAttribute('aria-selected');
      if (sel !== 'true') throw new Error(`Lose aria-selected after reload = ${sel}`);
    },
  },
  {
    name: 'progress: renders "Calories, last 7 days" card',
    run: async (page, base, { wait }) => {
      await goto(page, base + '/progress', wait);
      if ((await page.getByText('Calories, last 7 days').count()) === 0) throw new Error('7-day calories card missing');
    },
  },
];

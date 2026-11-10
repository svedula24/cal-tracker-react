#!/usr/bin/env node
// Renders the Kalo mark (src/components/KaloMark.tsx paths) to the app icon,
// Android adaptive icons, splash image and favicon. Uses Playwright (already a
// dev dependency). Run after changing the mark: node scripts/render-icons.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const src = readFileSync('src/components/KaloMark.tsx', 'utf8');
const leg = src.match(/leg: '([^']+)'/)[1];
const flame = src.match(/flame:\s*'([^']+)' \+\s*'([^']+)'/).slice(1).join('');

// pad = share of the canvas left empty around the mark
const mark = (fill, pad) => {
  const s = 100 / (1 - 2 * pad);
  const o = -pad * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${o} ${o} ${s} ${s}" width="100%" height="100%">
    <g fill="${fill}"><rect x="14" y="10" width="20" height="80" rx="5"/><path d="${leg}"/><path d="${flame}" fill-rule="evenodd"/></g></svg>`;
};

const targets = [
  { file: 'icon.png', size: 1024, bg: '#FFFFFF', fill: '#111111', pad: 0.2 },
  { file: 'android-icon-foreground.png', size: 512, bg: 'transparent', fill: '#111111', pad: 0.3 },
  { file: 'android-icon-monochrome.png', size: 432, bg: 'transparent', fill: '#000000', pad: 0.3 },
  { file: 'android-icon-background.png', size: 512, bg: '#FFFFFF', fill: 'none', pad: 0.3 },
  { file: 'splash-icon.png', size: 1024, bg: 'transparent', fill: '#111111', pad: 0.15 },
  { file: 'favicon.png', size: 96, bg: '#FFFFFF', fill: '#111111', pad: 0.1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<body style="margin:0;background:${t.bg}">${t.fill === 'none' ? '' : mark(t.fill, t.pad)}</body>`);
  await page.screenshot({ path: `assets/images/${t.file}`, omitBackground: t.bg === 'transparent' });
  console.log(`  ✓ assets/images/${t.file}`);
}
await browser.close();

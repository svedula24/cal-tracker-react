#!/usr/bin/env node
// Builds src/data/usda-foods.json: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), trimmed to what Kalo uses.
// USDA data is public domain. Rerun when USDA publishes a new release:
//   node scripts/build-usda-foods.mjs
// Needs `curl`, `unzip` and Node 22.18+. Downloads go to a temp folder that is removed after.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SEED_FDC_IDS } from '../src/lib/seedIds.ts';
import { buildRows, FIELDS } from './usda/map.mjs';

const BASE = 'https://fdc.nal.usda.gov/fdc-datasets/';
// Latest release of each generic dataset (see https://fdc.nal.usda.gov/download-datasets/).
const DATASETS = [
  { file: 'FoodData_Central_foundation_food_json_2026-10-29', key: 'FoundationFoods' },
  { file: 'FoodData_Central_sr_legacy_food_json_2018-04', key: 'SRLegacyFoods' }, // final release
  { file: 'FoodData_Central_survey_food_json_2024-10-31', key: 'SurveyFoods' },
];
const OUT = 'src/data/usda-foods.json';
const SEED_OUT = 'src/data/seed-foods.json'; // the demo seed's few foods (see src/lib/seedIds.ts)

const work = mkdtempSync(join(tmpdir(), 'kalo-usda-'));
try {
  const foods = [];
  for (const { file, key } of DATASETS) {
    const zip = join(work, `${file}.zip`);
    const dir = join(work, file);
    console.log(`↓ ${file}`);
    execFileSync('curl', ['-sfL', '-o', zip, BASE + file + '.zip'], { stdio: 'inherit' });
    execFileSync('unzip', ['-oq', zip, '-d', dir]);
    const json = readdirSync(dir).find((f) => f.endsWith('.json'));
    const records = JSON.parse(readFileSync(join(dir, json), 'utf8'))[key];
    if (!Array.isArray(records)) throw new Error(`${file}: no "${key}" array`);
    console.log(`  ${records.length} foods`);
    foods.push(...records);
    rmSync(dir, { recursive: true, force: true });
  }

  const rows = buildRows(foods);
  // A schema change in a new USDA release shows up as a collapse in usable rows;
  // refuse to overwrite the bundled data with that. (13,394 foods as of 2026-10.)
  const MIN_ROWS = 12000;
  if (rows.length < MIN_ROWS) throw new Error(`only ${rows.length} usable foods (expected ≥ ${MIN_ROWS}); not writing ${OUT}`);
  const out = {
    source: 'USDA FoodData Central (public domain)',
    releases: DATASETS.map((d) => d.file.replace('FoodData_Central_', '')),
    columns: ['fdcId', 'name', `per100g[${FIELDS.join(',')}]`, 'portions[[label,grams]]'],
    rows,
  };
  const byId = new Map(rows.map((r) => [r[0], r]));
  const missing = SEED_FDC_IDS.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`seed foods ${missing.join(', ')} are not in this release; update src/lib/seedIds.ts`);
  writeFileSync(OUT, JSON.stringify(out));
  writeFileSync(SEED_OUT, JSON.stringify({ columns: out.columns, rows: SEED_FDC_IDS.map((id) => byId.get(id)) }) + '\n');
  console.log(`✓ ${OUT}: ${rows.length} foods, ${(JSON.stringify(out).length / 1e6).toFixed(1)} MB`);
  console.log(`✓ ${SEED_OUT}: ${SEED_FDC_IDS.length} seed foods`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

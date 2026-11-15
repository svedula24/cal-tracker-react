#!/usr/bin/env node
// Builds src/data/usda-foods.json: every generic food in USDA FoodData Central
// (Foundation Foods, SR Legacy, FNDDS), trimmed to what Kalo uses.
// USDA data is public domain. Rerun when USDA publishes a new release:
//   node scripts/build-usda-foods.mjs
// Needs `curl`, `unzip` and Node 22.18+. Downloads go to a temp folder that is removed after.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SEED_FDC_IDS } from '../src/lib/seedIds.ts';
import { buildRows, FIELDS } from './usda/map.mjs';

const BASE = 'https://fdc.nal.usda.gov/fdc-datasets/';
// Latest release of each generic dataset (see https://fdc.nal.usda.gov/download-datasets/), with the
// SHA-256 of its zip: the same releases and pins as backend/kalo/usda/datasets.py. A zip that does not
// match is refused before it is unzipped. Bumping a release means updating its pin in both places.
const DATASETS = [
  {
    file: 'FoodData_Central_foundation_food_json_2026-10-29',
    key: 'FoundationFoods',
    sha256: 'dd414cc9f1a132626bad354ef6655972c78b44aff14f16114dc899708663c579',
  },
  {
    file: 'FoodData_Central_sr_legacy_food_json_2018-04', // final release
    key: 'SRLegacyFoods',
    sha256: '0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef',
  },
  {
    file: 'FoodData_Central_survey_food_json_2024-10-31',
    key: 'SurveyFoods',
    sha256: 'dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb',
  },
];
const OUT = 'src/data/usda-foods.json';
const SEED_OUT = 'src/data/seed-foods.json'; // the demo seed's few foods (see src/lib/seedIds.ts)

const work = mkdtempSync(join(tmpdir(), 'kalo-usda-'));
try {
  const foods = [];
  for (const { file, key, sha256 } of DATASETS) {
    const zip = join(work, `${file}.zip`);
    const dir = join(work, file);
    console.log(`↓ ${file}`);
    execFileSync('curl', ['-sfL', '-o', zip, BASE + file + '.zip'], { stdio: 'inherit' });
    const actual = createHash('sha256').update(readFileSync(zip)).digest('hex');
    if (actual !== sha256) throw new Error(`${file}.zip: sha256 mismatch; expected ${sha256}, got ${actual}`);
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

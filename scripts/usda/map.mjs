// Pure mapping from USDA FoodData Central download records to Kalo's compact
// food rows. Used by scripts/build-usda-foods.mjs; unit-tested in tests/.

// USDA nutrient ids → Kalo fields (values in the download are per 100 g).
// Energy falls back to the Atwater factors some Foundation foods report instead
// of 1008; sugar falls back to 1063 (Foundation uses it instead of 2000).
export const NUTRIENT_IDS = {
  calories: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005],
  fat: [1004],
  fiber: [1079],
  sugar: [2000, 1063],
  sodium: [1093], // mg
};
export const FIELDS = Object.keys(NUTRIENT_IDS);

// Earlier datasets win when two foods share a name.
export const DATASET_RANK = { Foundation: 0, 'SR Legacy': 1, 'Survey (FNDDS)': 2 };

export const round = (v, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/**
 * Per-100 g nutrients, or null when the food has no energy value. Values are
 * clamped at 0: USDA's "carbohydrate by difference" can be slightly negative.
 * `reported` counts how many of Kalo's nutrients the record actually has.
 */
export function per100g(food) {
  const values = new Map();
  for (const n of food.foodNutrients ?? []) {
    if (typeof n.amount === 'number' && n.nutrient?.id != null) values.set(n.nutrient.id, n.amount);
  }
  const pick = (ids) => ids.map((id) => values.get(id)).find((v) => typeof v === 'number');
  if (pick(NUTRIENT_IDS.calories) === undefined) return null;
  const out = Object.fromEntries(FIELDS.map((k) => [k, Math.max(0, pick(NUTRIENT_IDS[k]) ?? 0)]));
  Object.defineProperty(out, 'reported', { value: FIELDS.filter((k) => pick(NUTRIENT_IDS[k]) !== undefined).length });
  return out;
}

const SKIP_UNITS = new Set(['RACC', 'undetermined']);
// Portions that are real but make poor defaults; used only when nothing else exists.
const AVOID = /guideline amount|\bfl oz\b|as ingredient|\bspray\b|miniature|\bnlea\b|\bpackage\b|\bcontainer \(.*lb/i;

/**
 * The food's default serving as { label, grams }: of its named portions, the one
 * closest to 100 g (honey → 1 tbsp, not 1 cup; banana → 1 banana), skipping
 * poor defaults like "1 fl oz" or "Guideline amount…" when a better portion
 * exists (milk → 1 cup), else 100 g.
 */
export function defaultServing(food) {
  const portions = [...(food.foodPortions ?? [])]
    .filter((p) => typeof p.gramWeight === 'number' && p.gramWeight > 0)
    .sort((a, b) => (a.sequenceNumber ?? 99) - (b.sequenceNumber ?? 99));
  const candidates = [];
  for (const p of portions) {
    let label = '';
    if (p.portionDescription) {
      // FNDDS: "1 banana split"; skip the catch-all "Quantity not specified".
      if (/quantity not specified/i.test(p.portionDescription)) continue;
      label = p.portionDescription;
    } else {
      // Foundation: value + unit + modifier; SR Legacy: amount + modifier ("cup, sliced").
      const unit = p.measureUnit?.name && !SKIP_UNITS.has(p.measureUnit.name) ? p.measureUnit.name.toLowerCase() : '';
      if (!unit && p.measureUnit?.name === 'RACC') continue;
      const modifier = (p.modifier ?? '').replace(/\s+From \d+$/i, '').trim(); // drop internal "From 19191" refs
      const qty = p.value ?? p.amount ?? 1;
      label = [qty, unit, modifier && unit ? `(${modifier})` : modifier].filter(Boolean).join(' ');
    }
    label = label.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    if (label && !/^\d+$/.test(label)) candidates.push({ label, grams: p.gramWeight });
  }
  if (!candidates.length) return { label: '100 g', grams: 100 };
  const good = candidates.filter((c) => !AVOID.test(c.label));
  // Stable sort keeps USDA's own order between equally close portions.
  return (good.length ? good : candidates).sort((a, b) => Math.abs(a.grams - 100) - Math.abs(b.grams - 100))[0];
}

/** USDA names minus internal program notes. */
export const cleanName = (s) =>
  s
    .replace(/\s*\(Includes foods for USDA's Food Distribution Program\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * One compact row ([id, name, serving, calories, protein, carbs, fat, fiber, sugar,
 * sodium], nutrients scaled to the default serving) plus a completeness score
 * used to pick between same-named records. Null when the food can't be logged.
 */
export function analyze(food) {
  const n = per100g(food);
  if (!n || !food.description) return null;
  const { label, grams } = defaultServing(food);
  const hasPortion = label !== '100 g';
  const serving = hasPortion ? `${label} (${round(grams, grams < 10 ? 1 : 0)} g)` : label;
  // score = how complete the record is: nutrients reported, then a real portion.
  return { row: makeRow(food, n, serving, grams), score: n.reported * 2 + (hasPortion ? 1 : 0) };
}

function makeRow(food, n, serving, grams) {
  const f = grams / 100;
  return [
    food.fdcId,
    cleanName(food.description),
    serving,
    round(n.calories * f),
    round(n.protein * f, 1),
    round(n.carbs * f, 1),
    round(n.fat * f, 1),
    round(n.fiber * f, 1),
    round(n.sugar * f, 1),
    round(n.sodium * f),
  ];
}

/**
 * All datasets → rows, de-duplicated by name: the most complete record wins,
 * then the earlier dataset (Foundation, SR Legacy, FNDDS). Sorted by name.
 */
export function buildRows(foods) {
  const ranked = foods
    .map((food) => ({ a: analyze(food), rank: DATASET_RANK[food.dataType] ?? 9 }))
    .filter((x) => x.a)
    .sort((x, y) => y.a.score - x.a.score || x.rank - y.rank);
  const byName = new Map();
  for (const { a } of ranked) {
    const key = a.row[1].toLowerCase();
    if (!byName.has(key)) byName.set(key, a.row);
  }
  return [...byName.values()].sort((a, b) => a[1].localeCompare(b[1]));
}

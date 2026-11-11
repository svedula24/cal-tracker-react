// The foods API (backend/, GET /api/v1/foods/search) as the app sees it: a
// search returns complete `Food`s. Pure except for `fetch`, which tests inject.
// Unit-tested in tests/foodsApi.test.mjs.
import type { Food } from '@/data/foods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { orderPortions } from './portions.ts';

export type ApiPortion = { id: number; description: string; gram_weight: number };

/** One search result. Nutrients are per 100 g; null means USDA does not report it. */
export type ApiFood = {
  fdc_id: number;
  description: string;
  data_type: string;
  brand_name: string | null;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number | null;
  sugar_per_100g: number | null;
  sodium_mg_per_100g: number | null;
  /** Ordered by gram weight; empty when the food has none. */
  portions: ApiPortion[];
};

/** The API could not answer (unreachable, an error status, an unexpected body): use the bundled list. */
export class ApiUnavailable extends Error {
  constructor(message = 'The foods API is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiUnavailable';
  }
}

const MAX_LIMIT = 50; // the API rejects more
const MAX_QUERY = 100; // characters; the API rejects a longer q with a 422

/**
 * An API search result as the app's Food: the same id as the bundled list
 * (`usda:<fdc_id>`), so saved foods and logged entries match; a nutrient USDA
 * does not report counts as 0; the default serving first (orderPortions).
 */
export function foodFromApi(item: ApiFood): Food {
  return {
    id: `usda:${item.fdc_id}`,
    name: item.description,
    per100g: {
      calories: item.calories_per_100g,
      protein: item.protein_per_100g,
      carbs: item.carbs_per_100g,
      fat: item.fat_per_100g,
      fiber: item.fiber_per_100g ?? 0,
      sugar: item.sugar_per_100g ?? 0,
      sodium: item.sodium_mg_per_100g ?? 0,
    },
    portions: orderPortions(item.portions.map((p) => ({ label: p.description, grams: p.gram_weight }))),
  };
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isOptionalNumber = (x: unknown): boolean => x == null || isNumber(x);

const isApiPortion = (x: unknown): x is ApiPortion => {
  const p = x as ApiPortion | null;
  return !!p && typeof p.description === 'string' && isNumber(p.gram_weight);
};

/** Enough of the shape for foodFromApi to give a valid Food (isFood in savedFoods.ts). */
const isApiFood = (x: unknown): x is ApiFood => {
  const f = x as ApiFood | null;
  return (
    !!f &&
    Number.isInteger(f.fdc_id) &&
    typeof f.description === 'string' &&
    f.description !== '' &&
    isNumber(f.calories_per_100g) &&
    isNumber(f.protein_per_100g) &&
    isNumber(f.carbs_per_100g) &&
    isNumber(f.fat_per_100g) &&
    isOptionalNumber(f.fiber_per_100g) &&
    isOptionalNumber(f.sugar_per_100g) &&
    isOptionalNumber(f.sodium_mg_per_100g) &&
    Array.isArray(f.portions) &&
    f.portions.every(isApiPortion)
  );
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/**
 * Searches the API: GET `${baseUrl}/api/v1/foods/search?q=…&limit=…`, results in
 * the API's ranking. Rejects with ApiUnavailable when the API cannot answer
 * (network error, any non-2xx status, a body that is not the expected shape),
 * or with the abort error when `signal` aborts; nothing else.
 */
export async function searchFoodsApi(
  baseUrl: string,
  q: string,
  opts: { signal?: AbortSignal; limit?: number; fetch?: typeof fetch } = {},
): Promise<Food[]> {
  const { signal } = opts;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? MAX_LIMIT) || MAX_LIMIT));
  let body: unknown;
  try {
    // A longer query is cut, not sent: a 422 would read as "API unavailable" and drop the screen to
    // the bundled list. Cut by code point (as the API counts), so an emoji is never split in half,
    // which encodeURIComponent would throw on.
    const query = Array.from(q).slice(0, MAX_QUERY).join('');
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/foods/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    // Looked up at call time, so a missing global fetch is ApiUnavailable too.
    const res = await (opts.fetch ?? fetch)(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ApiUnavailable(`The foods API answered ${res.status}`);
    body = await res.json();
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw e instanceof ApiUnavailable ? e : new ApiUnavailable(undefined, { cause: e });
  }
  // An abort that the injected fetch did not notice still counts as one.
  if (signal?.aborted) throw abortError(signal);
  const foods = (body as { foods?: unknown } | null)?.foods;
  if (!Array.isArray(foods) || !foods.every(isApiFood)) throw new ApiUnavailable('The foods API sent an unexpected response');
  return foods.map(foodFromApi);
}

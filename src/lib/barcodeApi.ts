// The barcode lookup (backend/, GET /api/v1/foods/barcode/{code}) as the app sees it: a packaged
// product from Open Food Facts as a `Food`. Pure except for `fetch`, which tests inject.
// Unit-tested in tests/barcodeApi.test.mjs.
import type { Food } from '@/data/foods';

// Relative with the .ts extension so Node's test runner can import it as well.
import { ApiUnavailable } from './foodsApi.ts';

/** A found product as the API returns it. Nutrients are per 100 g; null means not reported. */
export type ApiBarcodeProduct = {
  code: string;
  name: string;
  brand: string | null;
  nutrients_per_100g: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number | null;
    sugar_g: number | null;
    sodium_mg: number | null;
  };
  serving: { label: string; grams: number } | null;
  source: string;
};

export type BarcodeResult =
  | { kind: 'found'; food: Food }
  /** No product with this barcode. */
  | { kind: 'not_found' }
  /** The product exists but without calories, protein, carbs and fat; `name` when it has one. */
  | { kind: 'incomplete'; name: string | null }
  /** Not a valid barcode (422): a misread scan or a typo in a typed code. */
  | { kind: 'invalid' };

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isOptionalNumber = (x: unknown): boolean => x == null || isNumber(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';

/** Enough of the shape for foodFromBarcode to give a valid Food (isFood in savedFoods.ts). */
const isProduct = (x: unknown): x is ApiBarcodeProduct => {
  const p = x as ApiBarcodeProduct | null;
  const n = p?.nutrients_per_100g;
  const s = p?.serving;
  return (
    !!p &&
    typeof p.code === 'string' &&
    /^[0-9]{8,14}$/.test(p.code) &&
    isText(p.name) &&
    (p.brand == null || typeof p.brand === 'string') &&
    !!n &&
    isNumber(n.calories) &&
    isNumber(n.protein_g) &&
    isNumber(n.carbs_g) &&
    isNumber(n.fat_g) &&
    isOptionalNumber(n.fiber_g) &&
    isOptionalNumber(n.sugar_g) &&
    isOptionalNumber(n.sodium_mg) &&
    (s == null || (typeof s.label === 'string' && isNumber(s.grams) && s.grams > 0))
  );
};

/**
 * A found product as the app's Food: id `off:<code>` (not a USDA food, so it syncs as a custom
 * entry in grams); the brand before the name unless the name already has it; a nutrient not
 * reported counts as 0; the product's serving as the one portion, else none (100 g default).
 */
export function foodFromBarcode(p: ApiBarcodeProduct): Food {
  const name = p.name.trim();
  const brand = p.brand?.trim() ?? '';
  const n = p.nutrients_per_100g;
  return {
    id: `off:${p.code}`,
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name,
    per100g: {
      calories: n.calories,
      protein: n.protein_g,
      carbs: n.carbs_g,
      fat: n.fat_g,
      fiber: n.fiber_g ?? 0,
      sugar: n.sugar_g ?? 0,
      sodium: n.sodium_mg ?? 0,
    },
    portions: p.serving ? [{ label: p.serving.label.trim() || '1 serving', grams: p.serving.grams }] : [],
  };
}

/** Whether a scanner's barcode type is UPC-E ('upc_e', 'upce', 'org.gs1.UPC-E', … by platform). */
export const isUpcE = (type: string): boolean => /upce$/.test(type.toLowerCase().replace(/[^a-z0-9]/g, ''));

/**
 * A scanned UPC-E (8 digits: number system 0 or 1, six digits, check digit) as the 12-digit UPC-A
 * it stands for, by the GS1 rules; the check digit is kept. The server does not expand UPC-E, and
 * 8 digits alone read as an EAN-8. Anything else is returned unchanged.
 */
export function upcEToUpcA(code: string): string {
  const m = /^([01])(\d)(\d)(\d)(\d)(\d)(\d)(\d)$/.exec(code);
  if (!m) return code;
  const [, ns, a, b, c, d, e, last, check] = m;
  const body =
    last <= '2' ? `${a}${b}${last}0000${c}${d}${e}` : last === '3' ? `${a}${b}${c}00000${d}${e}` : last === '4' ? `${a}${b}${c}${d}00000${e}` : `${a}${b}${c}${d}${e}0000${last}`;
  return `${ns}${body}${check}`;
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/**
 * Looks a barcode up: GET `${baseUrl}/api/v1/foods/barcode/{code}` with the install's token.
 * A 404 says whether the product is missing or has no usable nutrition; a 422 that the code is
 * not a valid barcode. Rejects with ApiUnavailable when the API cannot answer (network error,
 * 401, 429, 5xx, any other status, a body that is not the expected shape), or with the abort
 * error when `signal` aborts; nothing else.
 */
export async function lookupBarcode(
  baseUrl: string,
  code: string,
  opts: { token: string; signal?: AbortSignal; fetch?: typeof fetch },
): Promise<BarcodeResult> {
  const { signal } = opts;
  let status: number;
  let body: unknown;
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/foods/barcode/${encodeURIComponent(code)}`;
    // Looked up at call time, so a missing global fetch is ApiUnavailable too.
    const res = await (opts.fetch ?? fetch)(url, {
      signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${opts.token}` },
    });
    status = res.status;
    if (status !== 200 && status !== 404 && status !== 422) throw new ApiUnavailable(`The barcode lookup answered ${status}`);
    body = status === 422 ? null : await res.json();
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw e instanceof ApiUnavailable ? e : new ApiUnavailable(undefined, { cause: e });
  }
  // An abort that the injected fetch did not notice still counts as one.
  if (signal?.aborted) throw abortError(signal);
  if (status === 422) return { kind: 'invalid' };
  if (status === 404) {
    // Anything else (a plain {"detail": "Not Found"}) is a server without this endpoint.
    const detail = (body as { detail?: { reason?: unknown; name?: unknown } } | null)?.detail;
    if (detail?.reason === 'not_found') return { kind: 'not_found' };
    if (detail?.reason === 'incomplete') return { kind: 'incomplete', name: isText(detail.name) ? detail.name.trim() : null };
    throw new ApiUnavailable('The barcode lookup sent an unexpected 404');
  }
  if (!isProduct(body)) throw new ApiUnavailable('The barcode lookup sent an unexpected response');
  return { kind: 'found', food: foodFromBarcode(body) };
}

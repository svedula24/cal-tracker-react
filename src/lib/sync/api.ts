// The sync API (backend/, POST /api/v1/devices and POST /api/v1/sync) as the app sees it.
// Pure except for `fetch`, which tests inject. Unit-tested in tests/syncApi.test.mjs.
// The bearer token goes in the Authorization header and nowhere else: never in a URL, a log
// line or an error message.

// Relative with the .ts extension so Node's test runner can import it as well.
import { ApiUnavailable } from '../foodsApi.ts';
import { SyncUnauthorized } from './types.ts';
import type { DailyStepsRow, FoodLogRow, GoalRow, NutrientValues, SavedFoodRow, SyncChanges, SyncRequest, SyncResponse, Table } from './types.ts';

type FetchOpts = { fetch?: typeof fetch; signal?: AbortSignal };

const TABLES: readonly Table[] = ['food_logs', 'saved_foods', 'goals', 'daily_steps'];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
const isTimestamp = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const isDate = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isNullOr = (x: unknown, is: (v: unknown) => boolean): boolean => x === null || is(x);

const isValues = (x: unknown): x is NutrientValues =>
  isObject(x) &&
  isNumber(x.calories) &&
  isNumber(x.protein_g) &&
  isNumber(x.carbs_g) &&
  isNumber(x.fat_g) &&
  isNullOr(x.fiber_g, isNumber) &&
  isNullOr(x.sugar_g, isNumber) &&
  isNullOr(x.sodium_mg, isNumber);

/**
 * A pulled row: its key, `updated_at` and `deleted_at` always; the data too unless it is deleted
 * (a deleted row is only ever removed by its key, so its data is not checked).
 */
const isRow = (x: unknown, key: (r: Record<string, unknown>) => boolean, data: (r: Record<string, unknown>) => boolean): boolean =>
  isObject(x) && key(x) && isTimestamp(x.updated_at) && isNullOr(x.deleted_at, isTimestamp) && (x.deleted_at !== null || data(x));

const isFoodLog = (x: unknown): x is FoodLogRow =>
  isRow(
    x,
    (r) => isText(r.id),
    (r) =>
      isNullOr(r.fdc_id, Number.isSafeInteger) &&
      isDate(r.log_date) &&
      isTimestamp(r.logged_at) &&
      isText(r.name) &&
      isNullOr(r.food_name, (v) => typeof v === 'string') &&
      (r.unit === 'g' || r.unit === 'serving') &&
      isNumber(r.quantity) &&
      isValues(r.values) &&
      isNullOr(r.food_values, isValues),
  );

const isSavedFood = (x: unknown): x is SavedFoodRow =>
  isRow(x, (r) => Number.isSafeInteger(r.fdc_id), (r) => isTimestamp(r.saved_at));

const GOAL_NUMBERS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'steps'] as const;
const isGoal = (x: unknown): x is GoalRow =>
  isRow(
    x,
    (r) => isDate(r.effective_date),
    (r) => GOAL_NUMBERS.every((k) => isNumber(r[k])) && (r.goal === 'lose' || r.goal === 'maintain' || r.goal === 'gain'),
  );

const isDailySteps = (x: unknown): x is DailyStepsRow => isRow(x, (r) => isDate(r.log_date), (r) => isNumber(r.steps));

const ROW_CHECKS: Record<Table, (x: unknown) => boolean> = {
  food_logs: isFoodLog,
  saved_foods: isSavedFood,
  goals: isGoal,
  daily_steps: isDailySteps,
};

const isChanges = (x: unknown): x is SyncChanges =>
  isObject(x) && TABLES.every((t) => Array.isArray(x[t]) && (x[t] as unknown[]).every(ROW_CHECKS[t]));

/** Everything the engine and the mapping read, so neither ever sees a malformed row. */
const isSyncResponse = (x: unknown): x is SyncResponse =>
  isObject(x) &&
  Number.isSafeInteger(x.cursor) &&
  (x.cursor as number) >= 0 &&
  typeof x.has_more === 'boolean' &&
  isChanges(x.changes) &&
  Array.isArray(x.rejected) &&
  x.rejected.every((r) => isObject(r) && TABLES.includes(r.table as Table) && typeof r.key === 'string' && typeof r.reason === 'string');

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/**
 * POSTs JSON and returns the parsed body of a 2xx answer. Rejects with SyncUnauthorized on a 401,
 * with the abort error when `signal` aborts, and with ApiUnavailable for everything else (network
 * error, any other status, a body that is not JSON). The messages name the status only.
 */
async function postJson(url: string, headers: Record<string, string>, payload: unknown, opts: FetchOpts): Promise<unknown> {
  const { signal } = opts;
  let body: unknown;
  try {
    // `fetch` is looked up at call time, so a missing global fetch is ApiUnavailable too.
    const res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) throw new SyncUnauthorized();
    if (!res.ok) throw new ApiUnavailable(`The sync API answered ${res.status}`);
    body = await res.json();
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw e instanceof ApiUnavailable || e instanceof SyncUnauthorized ? e : new ApiUnavailable('The sync API is unavailable', { cause: e });
  }
  // An abort that the injected fetch did not notice still counts as one.
  if (signal?.aborted) throw abortError(signal);
  return body;
}

const endpoint = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}${path}`;

/**
 * Registers this install as an anonymous user: POST `${baseUrl}/api/v1/devices`. The token is
 * shown once, here; store it (the server keeps only its hash). Rejects with ApiUnavailable when
 * the server cannot answer (including 429, the registration limit), or with the abort error.
 */
export async function registerDevice(
  baseUrl: string,
  info: { platform: 'ios' | 'android' | 'web'; appVersion?: string },
  opts: FetchOpts = {},
): Promise<{ userId: string; token: string }> {
  let body: unknown;
  try {
    body = await postJson(endpoint(baseUrl, '/api/v1/devices'), {}, { platform: info.platform, app_version: info.appVersion ?? null }, opts);
  } catch (e) {
    // This endpoint takes no token, so a 401 from it is not "register again": it is unavailable.
    throw e instanceof SyncUnauthorized ? new ApiUnavailable('The sync API answered 401') : e;
  }
  if (!isObject(body) || !isText(body.user_id) || !isText(body.token)) throw new ApiUnavailable('The sync API sent an unexpected response');
  return { userId: body.user_id, token: body.token };
}

/**
 * One sync round trip: POST `${baseUrl}/api/v1/sync` with the bearer token. Rejects with
 * SyncUnauthorized on a 401 (the token is no longer accepted), with ApiUnavailable when the server
 * cannot answer (network error, any other non-2xx status such as 413, 422, 429 or 5xx, a body that
 * is not a SyncResponse), or with the abort error when `signal` aborts; nothing else.
 */
export async function postSync(baseUrl: string, token: string, body: SyncRequest, opts: FetchOpts = {}): Promise<SyncResponse> {
  const answer = await postJson(endpoint(baseUrl, '/api/v1/sync'), { Authorization: `Bearer ${token}` }, body, opts);
  if (!isSyncResponse(answer)) throw new ApiUnavailable('The sync API sent an unexpected response');
  return answer;
}

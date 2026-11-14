// The account endpoints the Connect ChatGPT screen and the timezone update use (backend/README.md):
// POST /api/v1/pairing-codes, GET /api/v1/connections, DELETE /api/v1/connections/{id} and
// PATCH /api/v1/me. Pure except for `fetch`, which tests inject. Unit-tested in
// tests/connectionsApi.test.mjs.
//
// Errors are the sync API's: SyncUnauthorized on a 401 (the token is no longer accepted: sync
// registers again), ApiUnavailable for everything else, the abort error when the caller's signal
// aborts. The bearer token goes in the Authorization header and nowhere else: never in a URL, a
// log line or an error message.

// Relative with the .ts extension so Node's test runner can import it as well.
import { ApiUnavailable } from './foodsApi.ts';
import { SyncUnauthorized } from './sync/types.ts';

export type Opts = { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };

/** A one-time code to type into Kalo's sign-in page in ChatGPT. */
export type PairingCode = { code: string; expiresAt: string };

/** A client (ChatGPT) the user let into their data. */
export type Connection = {
  id: string;
  clientName: string;
  /** "nutrition:read", and "nutrition:write" when it may also log and change things. */
  scopes: string[];
  createdAt: string;
  /** null = never used yet. */
  lastUsedAt: string | null;
};

/** 429: too many pairing codes this hour. An ApiUnavailable, so a caller that does not care need not know. */
export class TooManyRequests extends ApiUnavailable {
  constructor() {
    super('The server answered 429');
    this.name = 'TooManyRequests';
  }
}

/** 422: the server refused the request's content (for patchMe, a timezone it does not know). */
export class Unprocessable extends ApiUnavailable {
  constructor() {
    super('The server answered 422');
    this.name = 'Unprocessable';
  }
}

const TIMEOUT_MS = 15_000;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
const isTimestamp = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/**
 * One request with the bearer token; the parsed JSON body of a 2xx answer (null for a 204 or when
 * `allow404` lets a 404 through). A request still running after `timeoutMs` is ApiUnavailable.
 */
async function call(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload: unknown,
  opts: Opts,
  allow404 = false,
): Promise<unknown> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError(signal);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const stop = () => timeout.abort();
  signal?.addEventListener('abort', stop);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    // `fetch` is looked up at call time, so a missing global fetch is ApiUnavailable too.
    const res = await (opts.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      signal: timeout.signal,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (res.status === 401) throw new SyncUnauthorized();
    if (res.status === 429) throw new TooManyRequests();
    if (res.status === 422) throw new Unprocessable();
    if (res.status === 204 || (allow404 && res.status === 404)) return null;
    if (!res.ok) throw new ApiUnavailable(`The server answered ${res.status}`);
    const body: unknown = await res.json();
    if (timeout.signal.aborted) throw new Error('timed out'); // an abort the injected fetch did not notice
    return body;
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    if (e instanceof ApiUnavailable || e instanceof SyncUnauthorized) throw e;
    throw new ApiUnavailable(timeout.signal.aborted ? 'The server did not answer in time' : 'The server is unavailable', { cause: e });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

const unexpected = () => new ApiUnavailable('The server sent an unexpected response');

/** POST /api/v1/pairing-codes: a new code (valid about ten minutes). TooManyRequests over the hourly limit. */
export async function createPairingCode(baseUrl: string, token: string, opts: Opts = {}): Promise<PairingCode> {
  const body = await call(baseUrl, token, 'POST', '/api/v1/pairing-codes', undefined, opts);
  if (!isObject(body) || !isText(body.code) || !isTimestamp(body.expires_at)) throw unexpected();
  return { code: body.code, expiresAt: body.expires_at };
}

const toConnection = (x: unknown): Connection | null =>
  isObject(x) &&
  isText(x.id) &&
  typeof x.client_name === 'string' &&
  Array.isArray(x.scopes) &&
  x.scopes.every((s) => typeof s === 'string') &&
  isTimestamp(x.created_at) &&
  (x.last_used_at === null || x.last_used_at === undefined || isTimestamp(x.last_used_at))
    ? { id: x.id, clientName: x.client_name, scopes: x.scopes as string[], createdAt: x.created_at, lastUsedAt: (x.last_used_at as string | null | undefined) ?? null }
    : null;

/** GET /api/v1/connections: the clients that can reach this user's data, as the server orders them. */
export async function listConnections(baseUrl: string, token: string, opts: Opts = {}): Promise<Connection[]> {
  const body = await call(baseUrl, token, 'GET', '/api/v1/connections', undefined, opts);
  if (!isObject(body) || !Array.isArray(body.connections)) throw unexpected();
  const list = body.connections.map(toConnection);
  if (list.some((c) => c === null)) throw unexpected();
  return list as Connection[];
}

/** DELETE /api/v1/connections/{id}. A 404 (already gone) counts as done. */
export async function disconnect(baseUrl: string, token: string, connectionId: string, opts: Opts = {}): Promise<void> {
  await call(baseUrl, token, 'DELETE', `/api/v1/connections/${encodeURIComponent(connectionId)}`, undefined, opts, true);
}

/** PATCH /api/v1/me {timezone}: the zone the server now has. Unprocessable (an ApiUnavailable) for one it does not know. */
export async function patchMe(baseUrl: string, token: string, patch: { timezone: string }, opts: Opts = {}): Promise<{ timezone: string }> {
  const body = await call(baseUrl, token, 'PATCH', '/api/v1/me', { timezone: patch.timezone }, opts);
  if (!isObject(body) || !isText(body.timezone)) throw unexpected();
  return { timezone: body.timezone };
}

// ── For the screen: pure, so they are unit-tested ────────────────────────────

/** The longest a code lives (the server's 10 minutes). */
export const CODE_LIFETIME_MS = 10 * 60_000;

/**
 * When the code expires, on this device's clock. From the server's `expires_at`, unless that says
 * the code is already gone or would live longer than it can: then this device's clock is off, and
 * the full lifetime from `receivedAt` is the better guess.
 */
export function codeDeadline(expiresAt: string, receivedAt: number): number {
  const left = Date.parse(expiresAt) - receivedAt;
  return Number.isFinite(left) && left > 0 && left <= CODE_LIFETIME_MS ? receivedAt + left : receivedAt + CODE_LIFETIME_MS;
}

/** "9:41" for a time left, rounded up to the second; "0:00" once it is gone. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The integration-token endpoints the Apple Health steps screen uses (backend/app/api/v1/integrations.py):
// POST /api/v1/integration-tokens, GET /api/v1/integration-tokens, DELETE /api/v1/integration-tokens/{id}.
// An integration token is what the Apple Shortcut sends with PUT /api/v1/daily-activity/{date}/steps;
// the server accepts it on that route only. Pure except for `fetch`, which tests inject. Unit-tested
// in tests/integrationsApi.test.mjs.
//
// Errors are connectionsApi's (the same `call`): SyncUnauthorized on a 401, TooManyRequests on a 429,
// Conflict on a 409 (from create: too many live tokens), ApiUnavailable for everything else. The device token goes
// in the Authorization header only; the new integration token is returned to the caller and is never
// logged or put in an error.

// Relative with the .ts extension so Node's test runner can import it as well.
import { call, Conflict, type Opts, unexpected } from './connectionsApi.ts';
import { SyncUnauthorized } from './sync/types.ts';

/** A token the Shortcut uses, as listed (the token itself is never listed). */
export type IntegrationToken = {
  id: string;
  label: string;
  createdAt: string;
  /** null = never used yet. */
  lastUsedAt: string | null;
};

/** What creating one returns: the only time the token itself is seen. */
export type CreatedToken = { id: string; token: string; label: string; createdAt: string };

export const HEALTH_LABEL = 'Apple Health';

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
const isTimestamp = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));

/** POST /api/v1/integration-tokens {label}: a new token, shown once. Conflict at the server's limit (10 live). */
export async function createIntegrationToken(baseUrl: string, token: string, label = HEALTH_LABEL, opts: Opts = {}): Promise<CreatedToken> {
  const body = await call(baseUrl, token, 'POST', '/api/v1/integration-tokens', { label }, opts);
  if (!isObject(body) || !isText(body.id) || !isText(body.token) || typeof body.label !== 'string' || !isTimestamp(body.created_at)) throw unexpected();
  return { id: body.id, token: body.token, label: body.label, createdAt: body.created_at };
}

const toToken = (x: unknown): IntegrationToken | null =>
  isObject(x) &&
  isText(x.id) &&
  typeof x.label === 'string' &&
  isTimestamp(x.created_at) &&
  (x.last_used_at === null || x.last_used_at === undefined || isTimestamp(x.last_used_at))
    ? { id: x.id, label: x.label, createdAt: x.created_at, lastUsedAt: (x.last_used_at as string | null | undefined) ?? null }
    : null;

/** GET /api/v1/integration-tokens: the live tokens, as the server orders them (newest first). */
export async function listIntegrationTokens(baseUrl: string, token: string, opts: Opts = {}): Promise<IntegrationToken[]> {
  const body = await call(baseUrl, token, 'GET', '/api/v1/integration-tokens', undefined, opts);
  if (!isObject(body) || !Array.isArray(body.tokens)) throw unexpected();
  const list = body.tokens.map(toToken);
  if (list.some((t) => t === null)) throw unexpected();
  return list as IntegrationToken[];
}

/** DELETE /api/v1/integration-tokens/{id}. A 404 (already gone) counts as done. */
export async function revokeIntegrationToken(baseUrl: string, token: string, tokenId: string, opts: Opts = {}): Promise<void> {
  await call(baseUrl, token, 'DELETE', `/api/v1/integration-tokens/${encodeURIComponent(tokenId)}`, undefined, opts, true);
}

// ── For the screen: pure, so they are unit-tested ────────────────────────────

/** The date placeholder in the URL the Shortcut calls; the Shortcut puts a Format Date (yyyy-MM-dd) there. */
export const DATE_PLACEHOLDER = '{date}';

/** The URL the Shortcut sends today's steps to, with DATE_PLACEHOLDER for the day: `<api>/api/v1/daily-activity/{date}/steps`. */
export const stepsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/api/v1/daily-activity/${DATE_PLACEHOLDER}/steps`;

/** What a failed request was for: Create token, loading the list, or Revoke. */
export type ProblemContext = 'create' | 'list' | 'revoke';

/** What to tell the user about a failed request. Never the error itself. On SyncUnauthorized the caller kicks sync to register again. */
export function problemMessage(e: unknown, context: ProblemContext): string {
  if (e instanceof Conflict) return 'You already have 10 Health tokens. Revoke one you no longer use, then try again.';
  if (e instanceof SyncUnauthorized) return "Kalo's server didn't recognise this phone. It is reconnecting: try again in a moment.";
  if (context === 'revoke') return "Couldn't revoke the token. Check your connection and try again.";
  return "Can't reach Kalo's server. Check your connection and try again.";
}

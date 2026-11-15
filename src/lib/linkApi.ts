// Linking another device to this user (backend/README.md, "Link another device"):
// POST /api/v1/link-codes (this install's token) gives a one-time code; another install sends it to
// POST /api/v1/devices/link (no token) and gets its own token for the same user. Pure except for
// `fetch`, which tests inject. Unit-tested in tests/linkApi.test.mjs.
//
// Errors are connectionsApi's: SyncUnauthorized (401), TooManyRequests (429), BadRequest (400: for
// linking, a wrong, expired or used code), ApiUnavailable for everything else. Neither the code nor
// the token goes anywhere but the request: never in a URL, a log line or an error message.

// Relative with the .ts extension so Node's test runner can import it as well.
import { BadRequest, call, type Opts, TooManyRequests } from './connectionsApi.ts';
import { ApiUnavailable } from './foodsApi.ts';
import { SyncUnauthorized } from './sync/types.ts';

export type LinkCode = { code: string; expiresAt: string };
export type Linked = { userId: string; token: string; timezone: string | null };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
const unexpected = () => new ApiUnavailable('The server sent an unexpected response');

/** POST /api/v1/link-codes: a code for another device (about ten minutes, once). TooManyRequests over the hourly limit. */
export async function createLinkCode(baseUrl: string, token: string, opts: Opts = {}): Promise<LinkCode> {
  const body = await call(baseUrl, token, 'POST', '/api/v1/link-codes', undefined, opts);
  if (!isObject(body) || !isText(body.code) || !isText(body.expires_at) || Number.isNaN(Date.parse(body.expires_at))) throw unexpected();
  return { code: body.code, expiresAt: body.expires_at };
}

/**
 * POST /api/v1/devices/link: a token of this install's own for the user whose code it is. BadRequest
 * for a wrong, expired or used code; TooManyRequests when there were too many tries.
 */
export async function linkDevice(
  baseUrl: string,
  info: { code: string; platform: 'ios' | 'android' | 'web'; appVersion?: string; timezone?: string | null },
  opts: Opts = {},
): Promise<Linked> {
  const payload = { code: info.code, platform: info.platform, app_version: info.appVersion ?? null, timezone: info.timezone ?? null };
  let body: unknown;
  try {
    body = await call(baseUrl, null, 'POST', '/api/v1/devices/link', payload, opts);
  } catch (e) {
    // No token was sent, so a 401 is not "this device is unknown": the server is just unavailable.
    throw e instanceof SyncUnauthorized ? new ApiUnavailable('The server answered 401') : e;
  }
  if (!isObject(body) || !isText(body.user_id) || !isText(body.token)) throw unexpected();
  return { userId: body.user_id, token: body.token, timezone: isText(body.timezone) ? body.timezone : null };
}

// ── For the screens: pure, so they are unit-tested ───────────────────────────

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // the server's (Crockford base32)
const CONFUSABLE: Record<string, string> = { O: '0', I: '1', L: '1' };

/**
 * What was typed as the server reads it: 8 characters, case, spaces and dashes ignored, O read as 0
 * and I or L as 1. Null when it cannot be a code (the Link button stays off).
 */
export function normaliseCode(typed: string): string | null {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OIL]/g, (ch) => CONFUSABLE[ch]);
  return code.length === 8 && [...code].every((ch) => ALPHABET.includes(ch)) ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

/**
 * Whether a new install should offer "Already use Kalo on another device?" at its first launch:
 * it has no token (has not registered), has never synced (`primed`), has no data of its own (entries,
 * saved foods, day logs, or goals other than the default), and the offer was not answered. While
 * offered, sync holds off registering (src/lib/sync/index.ts), and linking wipes without asking.
 */
export function shouldOfferLink(state: { hasToken: boolean; primed: boolean; ownData: boolean; answered: boolean }): boolean {
  return !state.hasToken && !state.primed && !state.ownData && !state.answered;
}

/** What to tell the user about a failed request: getting a code, or linking this device. Never the error itself. */
export function linkProblem(e: unknown, context: 'code' | 'link'): string {
  if (e instanceof BadRequest && context === 'link') return "That code didn't work: it may be mistyped, expired or already used. Get a new code on your other device.";
  if (e instanceof TooManyRequests) return context === 'code' ? 'Too many codes this hour. Try again later.' : 'Too many tries. Wait a few minutes and try again.';
  if (e instanceof SyncUnauthorized) return "Kalo's server didn't recognise this device. It is reconnecting: try again in a moment.";
  return "Can't reach Kalo's server. Check your connection and try again.";
}

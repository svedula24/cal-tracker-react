// Starts the background sync with the server (the engine in ./engine.ts) and connects it to the
// app: the collections, the stored token, the network, AppState. The only file of the sync code
// with React Native in it; the logic lives in ./engine.ts, ./local.ts, ./mapping.ts and ./api.ts.
//
// The phone comes first: nothing here is awaited by a screen, nothing throws or rejects, and
// without EXPO_PUBLIC_API_URL nothing is created or stored. (deviceToken() is the exception a screen
// may await: the Connect ChatGPT screen, which needs the server anyway.)
//
// Linking (the Link another device screen): `linkThisDevice` swaps this install onto another
// device's account through the engine's `relink`. On a new install the first-run offer to link
// (`useLinkOffer`) holds sync back, so no account is registered for an install about to be linked;
// any local write, a screen asking for the token, or "Not now" ends it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { loadFoods } from '@/data/foods';
import { API_URL } from '@/lib/config';
import { patchMe, Unprocessable } from '@/lib/connectionsApi';
import { clearLocalData, markDemoCleaned, ownData, removeDemoDataOnce, syncStores } from '@/lib/data';
import { ApiUnavailable } from '@/lib/foodsApi';
import { loadPreviousToken, loadToken, savePreviousToken, saveToken } from '@/lib/identity';
import { linkDevice, shouldOfferLink } from '@/lib/linkApi';
import { createZoneSender, currentTimezone, zoneToRecord } from '@/lib/timezone';

import { postSync, registerDevice } from './api';
import { attachEngine } from './dirty';
import { createSync } from './engine';
import { createLocal } from './local';
import { SyncUnauthorized } from './types';

export { markDirty } from './dirty';

// The engine has no timeout of its own: a request that never settles would stop sync for good.
const REQUEST_TIMEOUT_MS = 15_000;

async function withTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';

// The timezone the server was last given (at registration or by PATCH /api/v1/me), so it is sent
// again only when the device's zone changes.
const TZ_SENT = 'kalo.tz.sent';

// One registration at a time: sync and the Connect ChatGPT screen may both need a token at once,
// and two registrations would make two accounts.
let registering: Promise<void> | null = null;

/**
 * Keeps a token for another account than the one before (a registration, or a link). The zone is
 * recorded only when that account has it (`stored`, its zone); otherwise cleared, since what is
 * recorded was sent to the account before this one. (The server stores UTC for a zone it does not
 * know: the zone sender then PATCHes it later, refused until the server knows it.) Done before the
 * token is usable, so the zone sender never pairs the new token with the old account's record.
 */
async function adoptToken(token: string, sent: string | null, stored: string | null): Promise<void> {
  zoneSender.forget(); // a zone the old account's server refused may be taken now
  const record = zoneToRecord(sent, stored);
  await (record ? AsyncStorage.setItem(TZ_SENT, record) : AsyncStorage.removeItem(TZ_SENT)).catch(() => {});
  await saveToken(token);
}

/** Registers this install (a new, empty account) with its timezone and keeps the token. Rejects when it cannot. */
function register(url: string): Promise<void> {
  registering ??= (async () => {
    const timezone = currentTimezone();
    const { token, timezone: stored } = await withTimeout((signal) =>
      registerDevice(url, { platform, appVersion: Constants.expoConfig?.version, timezone }, { signal }),
    );
    await adoptToken(token, timezone, stored);
  })().finally(() => {
    registering = null;
  });
  return registering;
}

/**
 * This install's token, registering first when it has none (the same registration sync uses).
 * Rejects with ApiUnavailable without an API URL or when the server cannot be reached.
 */
export async function deviceToken(): Promise<string> {
  if (!API_URL) throw new ApiUnavailable('No API URL');
  answerLinkOffer(); // a screen that needs an account: this install is not waiting to be linked
  // A registration under way (say, sync's after a 401) replaces the stored token: wait for it, so
  // the old, revoked one is not handed out. If it fails, whatever is stored is still the answer.
  if (registering) await registering.catch(() => {});
  const known = await loadToken();
  if (known) return known;
  await register(API_URL);
  const token = await loadToken();
  if (!token) throw new ApiUnavailable('No token');
  return token;
}

/** Sends the device's timezone when it is not the one the server was last given (see createZoneSender). */
const zoneSender = createZoneSender({
  zone: currentTimezone,
  recorded: () => AsyncStorage.getItem(TZ_SENT),
  record: (zone) => AsyncStorage.setItem(TZ_SENT, zone),
  token: loadToken,
  patch: async (token, zone) => {
    if (API_URL) await patchMe(API_URL, token, { timezone: zone }); // its own 15 s timeout
  },
  refused: (e) => e instanceof Unprocessable,
  registering: () => registering !== null,
});

let started = false;
let kick: (() => void) | null = null;

type Engine = ReturnType<typeof createSync>;
let engineCreated!: (engine: Engine) => void;
let engineFailed!: () => void;
/** The engine, once startSync has made it; rejects when sync could not start this session. */
const engineReady = new Promise<Engine>((resolve, reject) => {
  engineCreated = resolve;
  engineFailed = () => reject(new ApiUnavailable('Sync is not running'));
});
engineReady.catch(() => {}); // nobody may be waiting

// ── The first-run offer to link ("Already use Kalo on another device?") ──────
// Answered once (stored), by "Not now", by linking, by any local write or by a screen asking for
// the token. While it is open, sync does not run (`kick` below): no registration, no upload.
const OFFER_ANSWERED = 'kalo.link.offer';
let offer = false;
const offerListeners = new Set<() => void>();
const setOffer = (open: boolean) => {
  if (offer === open) return;
  offer = open;
  for (const listener of offerListeners) listener();
};

/** Whether Home shows the first-run offer to link this install to another device's account. */
export function useLinkOffer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      offerListeners.add(listener);
      return () => offerListeners.delete(listener);
    },
    () => offer,
    () => false,
  );
}

/** Closes the first-run offer for good ("Not now", or the install is being used on its own); sync starts. */
export function answerLinkOffer(): void {
  if (!offer) return;
  setOffer(false);
  void AsyncStorage.setItem(OFFER_ANSWERED, '1').catch(() => {});
  kick?.();
}

/**
 * Moves this install onto the account `token` opens. In this order, each step awaited: the engine
 * stores an empty outbox, no cursor and primed (relink); the local data is cleared (nothing is sent);
 * the current token is kept as the previous one (so its account can be opened again); the new token
 * is stored, LAST. A failure before that leaves the install on its own token, with nothing local,
 * pulling its account again. Then sync pulls the account from the start.
 */
async function switchAccount(token: string, sent: string | null, stored: string | null): Promise<void> {
  const engine = await engineReady;
  // A registration under way would store its token over this one.
  if (registering) await registering.catch(() => {});
  await engine.relink(async () => {
    await clearLocalData();
    const current = await loadToken();
    if (current && current !== token) await savePreviousToken(current);
    await adoptToken(token, sent, stored);
  });
  setOffer(false);
  void AsyncStorage.setItem(OFFER_ANSWERED, '1').catch(() => {});
  void zoneSender.send();
}

/**
 * Links this install to the account of the device that showed `code` (POST /api/v1/devices/link)
 * and switches to it (switchAccount: the data on this install is replaced by that account's).
 * Rejects with linkApi's errors (BadRequest for a wrong, expired or used code); nothing on the
 * install changes then.
 */
export async function linkThisDevice(code: string): Promise<void> {
  if (!API_URL) throw new ApiUnavailable('No API URL');
  await engineReady;
  const timezone = currentTimezone();
  const linked = await linkDevice(API_URL, { code, platform, appVersion: Constants.expoConfig?.version, timezone });
  await switchAccount(linked.token, timezone, linked.timezone);
}

/** Whether this install was linked away from an account it can switch back to. */
export async function hasPreviousAccount(): Promise<boolean> {
  return (await loadPreviousToken().catch(() => null)) !== null;
}

/**
 * Opens again the account this install had before its last link (its token was kept), replacing
 * the data on this install with that account's. The account being left becomes the previous one,
 * so this can be undone the same way. Rejects when there is none.
 */
export async function switchToPreviousAccount(): Promise<void> {
  if (!API_URL) throw new ApiUnavailable('No API URL');
  const previous = await loadPreviousToken();
  if (!previous) throw new ApiUnavailable('No previous account');
  await switchAccount(previous, null, null);
}

/** Syncs now (when sync is running): after a 401 elsewhere, this registers again the way sync does. */
export function syncNow(): void {
  kick?.();
}

/**
 * Call once at app start (the root layout). Removes an older version's demo data once (with or
 * without an API URL); syncs only with one.
 */
export function startSync(): void {
  if (started) return;
  started = true;
  if (!API_URL) {
    void removeDemoDataOnce().then((ran) => (ran ? markDemoCleaned() : undefined));
    return;
  }
  const url = API_URL;
  void (async () => {
    // Every collection loaded first: the first sync queues the rows that exist, once, and data
    // still being read from storage would be left out of that upload for good.
    const stores = syncStores();
    await Promise.all(Object.values(stores).map((store) => store.whenReady()));
    // Before the first sync: its tombstones are reported now, kept until the engine exists, and
    // go up with the first push (or stay in the stored outbox while offline).
    const cleaned = await removeDemoDataOnce();

    const local = createLocal({
      ...stores,
      // The bundled database is loaded only when a pulled bookmark needs its food.
      findFood: async (id) => (await loadFoods()).foods.find((food) => food.id === id) ?? null,
    });
    const [hasToken, primed, answered] = await Promise.all([
      loadToken().then((t) => t !== null, () => true), // unreadable: not a new install
      AsyncStorage.getItem('sync:primed').catch(() => '1'),
      AsyncStorage.getItem(OFFER_ANSWERED).catch(() => '1'),
    ]);
    const own = ownData();
    setOffer(shouldOfferLink({ hasToken, primed: primed === '1', ownData: own.entries > 0 || own.other, answered: answered !== null }));

    const engine = createSync({
      ...local,
      push: async (body) => {
        const token = await loadToken();
        if (!token) throw new SyncUnauthorized(); // gone since hasToken(): register again
        const res = await withTimeout((signal) => postSync(url, token, body, { signal }));
        // The engine drops rejected rows; the count is the only trace (no row, no token).
        if (res.rejected.length) console.warn(`Sync: the server rejected ${res.rejected.length} row(s)`);
        return res;
      },
      register: () => register(url),
      hasToken: async () => (await loadToken()) !== null,
      storage: { get: (key) => AsyncStorage.getItem(key), set: (key, value) => AsyncStorage.setItem(key, value) },
    });

    kick = () => {
      if (!offer) engine.kick();
    };
    // Replays what was written while the data was loading. A local write answers the offer to link.
    attachEngine((table, key, deleted) => {
      answerLinkOffer();
      engine.markDirty(table, key, deleted);
    });
    engineCreated(engine);
    if (cleaned) void markDemoCleaned(); // its tombstones are in the engine's outbox now
    kick();
    void zoneSender.send();
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      kick?.();
      void zoneSender.send(); // the phone may have changed zone while away
    });
  })().catch(() => engineFailed()); // sync is not running this session; the app is unaffected
}

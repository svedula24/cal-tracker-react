// Starts the background sync with the server (the engine in ./engine.ts) and connects it to the
// app: the collections, the stored token, the network, AppState. The only file of the sync code
// with React Native in it; the logic lives in ./engine.ts, ./local.ts, ./mapping.ts and ./api.ts.
//
// The phone comes first: nothing here is awaited by a screen, nothing throws or rejects, and
// without EXPO_PUBLIC_API_URL nothing is created or stored. (deviceToken() is the exception a screen
// may await: the Connect ChatGPT screen, which needs the server anyway.)
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { loadFoods } from '@/data/foods';
import { API_URL } from '@/lib/config';
import { patchMe, Unprocessable } from '@/lib/connectionsApi';
import { syncStores } from '@/lib/data';
import { ApiUnavailable } from '@/lib/foodsApi';
import { loadToken, saveToken } from '@/lib/identity';
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

/** Registers this install (a new, empty account) with its timezone and keeps the token. Rejects when it cannot. */
function register(url: string): Promise<void> {
  registering ??= (async () => {
    const timezone = currentTimezone();
    const { token, timezone: stored } = await withTimeout((signal) =>
      registerDevice(url, { platform, appVersion: Constants.expoConfig?.version, timezone }, { signal }),
    );
    // Recorded only when the server took it; otherwise cleared, since what is recorded was sent to the
    // account before this one. (The server stores UTC for a zone it does not know: the zone sender then
    // PATCHes it later, refused until the server knows it.) Done before the token is usable, so
    // the zone sender never pairs the new token with the old account's record.
    zoneSender.forget(); // a zone the old account's server refused may be taken now
    const record = zoneToRecord(timezone, stored);
    await (record ? AsyncStorage.setItem(TZ_SENT, record) : AsyncStorage.removeItem(TZ_SENT)).catch(() => {});
    await saveToken(token);
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

/** Syncs now (when sync is running): after a 401 elsewhere, this registers again the way sync does. */
export function syncNow(): void {
  kick?.();
}

/** Call once at app start (the root layout). Does nothing without an API URL. */
export function startSync(): void {
  if (!API_URL || started) return;
  started = true;
  const url = API_URL;
  void (async () => {
    // Every collection loaded first: the first sync queues the rows that exist, once, and data
    // still being read from storage would be left out of that upload for good.
    const stores = syncStores();
    await Promise.all(Object.values(stores).map((store) => store.whenReady()));

    const local = createLocal({
      ...stores,
      // The bundled database is loaded only when a pulled bookmark needs its food.
      findFood: async (id) => (await loadFoods()).foods.find((food) => food.id === id) ?? null,
    });
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

    attachEngine(engine.markDirty); // replays what was written while the data was loading
    kick = engine.kick;
    engine.kick();
    void zoneSender.send();
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      engine.kick();
      void zoneSender.send(); // the phone may have changed zone while away
    });
  })().catch(() => {}); // sync is not running this session; the app is unaffected
}

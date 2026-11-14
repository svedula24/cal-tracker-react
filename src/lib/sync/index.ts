// Starts the background sync with the server (the engine in ./engine.ts) and connects it to the
// app: the collections, the stored token, the network, AppState. The only file of the sync code
// with React Native in it; the logic lives in ./engine.ts, ./local.ts, ./mapping.ts and ./api.ts.
//
// The phone comes first: nothing here is awaited by a screen, nothing throws or rejects, and
// without EXPO_PUBLIC_API_URL nothing is created or stored.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { loadFoods } from '@/data/foods';
import { API_URL } from '@/lib/config';
import { syncStores } from '@/lib/data';
import { loadToken, saveToken } from '@/lib/identity';

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

let started = false;

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
      register: async () => {
        const { token } = await withTimeout((signal) =>
          registerDevice(url, { platform, appVersion: Constants.expoConfig?.version }, { signal }),
        );
        await saveToken(token);
      },
      hasToken: async () => (await loadToken()) !== null,
      storage: { get: (key) => AsyncStorage.getItem(key), set: (key, value) => AsyncStorage.setItem(key, value) },
    });

    attachEngine(engine.markDirty); // replays what was written while the data was loading
    engine.kick();
    AppState.addEventListener('change', (state) => {
      if (state === 'active') engine.kick();
    });
  })().catch(() => {}); // sync is not running this session; the app is unaffected
}

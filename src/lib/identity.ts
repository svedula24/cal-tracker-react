// This install's bearer token for the sync API (POST /api/v1/devices returns it once). Kept in
// the Keychain / Keystore through expo-secure-store; on web, where SecureStore does not exist,
// in AsyncStorage (localStorage). One key. The token is never logged.
//
// Not imported by any Node test: it loads React Native and a native module.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'kalo.token';
const web = Platform.OS === 'web';

// The token once it is known, so a request does not go to the Keychain each time. undefined =
// not read yet; null = there is none.
let known: string | null | undefined;

/**
 * The stored token, or null when this install has not registered. Rejects when the storage
 * cannot be read: that is not "no token" (registering again would start a new, empty account).
 */
export async function loadToken(): Promise<string | null> {
  if (known !== undefined) return known;
  const stored = (await (web ? AsyncStorage.getItem(KEY) : SecureStore.getItemAsync(KEY))) || null;
  // A token saved while the read was in flight wins.
  if (known === undefined) known = stored;
  return known;
}

/**
 * Keeps the token. It is usable from this call on; if the device refuses to store it, it lasts
 * until the app closes (rejecting instead would make the caller register yet another account).
 */
export async function saveToken(token: string): Promise<void> {
  known = token;
  try {
    await (web ? AsyncStorage.setItem(KEY, token) : SecureStore.setItemAsync(KEY, token));
  } catch {}
}

export async function clearToken(): Promise<void> {
  known = null;
  try {
    await (web ? AsyncStorage.removeItem(KEY) : SecureStore.deleteItemAsync(KEY));
  } catch {}
}

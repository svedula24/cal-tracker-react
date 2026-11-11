// Build-time configuration. Expo inlines `process.env.EXPO_PUBLIC_*` when it
// bundles, so the variable must be referenced exactly like this (no destructuring).

/**
 * Base URL of the foods API without a trailing slash, e.g. "http://192.168.1.20:8000".
 * Null when EXPO_PUBLIC_API_URL is unset or empty: the app then uses only the bundled food list.
 */
export const API_URL: string | null = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '') || null;

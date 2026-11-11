// UUID v4 ids for locally-created records: the server's log ids are UUIDs made
// by the client. Web and Node (tests, the static export) have crypto.randomUUID;
// Hermes may not, so native falls back to expo-crypto. The require is only
// reached there: Metro bundles it, Node never has to resolve the native module.
type WebCrypto = { randomUUID?: () => string };

export function uuid(): string {
  const web = (globalThis as { crypto?: WebCrypto }).crypto;
  if (typeof web?.randomUUID === 'function') return web.randomUUID();
  return (require('expo-crypto') as typeof import('expo-crypto')).randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

// UUID v4 ids for locally-created records: the server's log ids are UUIDs made
// by the client. Web and Node (tests, the static export) have crypto.randomUUID,
// but browsers only offer it in a secure context: a web build served over plain
// http from a LAN address has crypto.getRandomValues and nothing else, so the id
// is built from that. Hermes may have neither, so native falls back to
// expo-crypto. The require is only reached there: Metro bundles it, Node never
// has to resolve the native module.
type WebCrypto = { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array };

export function uuid(): string {
  const web = (globalThis as { crypto?: WebCrypto }).crypto;
  if (typeof web?.randomUUID === 'function') return web.randomUUID();
  if (typeof web?.getRandomValues === 'function') return fromBytes(web.getRandomValues(new Uint8Array(16)));
  return (require('expo-crypto') as typeof import('expo-crypto')).randomUUID();
}

/** 16 random bytes as a version 4 UUID (RFC 9562: the version and variant bits are set). */
function fromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

// ────────────────────────────────────────────────────────────────────────────
// On-device persistence for cloned apps.
//
// The `/clone-app` "data-op triage" step classifies each of the cloned app's
// data actions as BACKEND (server/auth/sync → mocked with a `// TODO`) or
// ON-DEVICE (local CRUD, drafts, settings → implemented FOR REAL here). This is
// what makes a clone actually work instead of being a dead shell.
//
// Backed by AsyncStorage (which is localStorage on web), so persistence works
// offline and survives reloads — including in the web build used for demos.
//
// Each `key` maps to ONE shared store, so adding on one screen instantly shows
// up on every other screen reading the same key. A per-component useState would
// give each screen its own private copy — the classic "add a task, it doesn't
// appear in the list" bug. We use useSyncExternalStore over a module-level store
// to get real cross-screen reactivity.
// ────────────────────────────────────────────────────────────────────────────

export async function readCollection<T>(key: string): Promise<T[]> {
  const raw = await AsyncStorage.getItem(key);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return []; // corrupt value
  }
}

export async function writeCollection<T>(key: string, items: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(items));
}

type WithId = { id: string };

export class Collection<T extends WithId> {
  items: T[];
  ready = false;
  private listeners = new Set<() => void>();
  // Writes made before hydration finishes: replayed onto the stored data, so an
  // early add neither vanishes nor overwrites what was saved.
  private pending: ((items: T[]) => T[])[] = [];

  constructor(
    private readonly key: string,
    seed: T[],
  ) {
    this.items = seed;
    // Hydrate once from storage without blocking render. On web, AsyncStorage is
    // localStorage; guard SSR/prerender where `window` is absent.
    if (typeof window !== 'undefined') {
      // Load whatever is stored under this key — including an empty array. A key
      // that EXISTS wins over the seed, so deleting every item persists as empty
      // instead of silently resurrecting the seed data on the next reload.
      void AsyncStorage.getItem(this.key)
        .catch(() => null)
        .then((raw) => {
          let base = seed;
          if (raw != null) {
            try {
              const parsed: unknown = JSON.parse(raw);
              if (Array.isArray(parsed)) base = parsed as T[];
            } catch {} // corrupt value: fall back to the seed
          }
          const queued = this.pending;
          this.pending = [];
          this.ready = true;
          if (queued.length) this.commit(queued.reduce((acc, op) => op(acc), base));
          else {
            this.items = base;
            this.emit();
          }
        });
    } else {
      this.ready = true;
    }
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): T[] => this.items;

  private emit() {
    for (const l of this.listeners) l();
  }

  // Functional updates read `this.items` at call time (not a captured closure),
  // so rapid successive writes never drop each other.
  private commit(next: T[]) {
    this.items = next;
    void writeCollection(this.key, next);
    this.emit();
  }

  private apply(op: (items: T[]) => T[]) {
    if (this.ready) return this.commit(op(this.items));
    this.pending.push(op); // shown now, persisted after hydration
    this.items = op(this.items);
    this.emit();
  }

  add = (item: T) => this.apply((items) => [...items, item]);
  update = (id: string, patch: Partial<T>) =>
    this.apply((items) => items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  remove = (id: string) => this.apply((items) => items.filter((i) => i.id !== id));
}

const collections = new Map<string, Collection<WithId>>();

/**
 * Access the module-level Collection instance for a key. Every screen shares this
 * one instance, so a write anywhere re-renders all of them. Reading/writing
 * storage directly would persist but not re-render.
 */
export function getCollection<T extends WithId>(key: string, seed: T[]): Collection<T> {
  let c = collections.get(key);
  if (!c) {
    c = new Collection<T>(key, seed) as unknown as Collection<WithId>;
    collections.set(key, c);
  }
  return c as unknown as Collection<T>;
}

/**
 * A persisted array with CRUD, shared across every screen that uses the same
 * `key`. Items must carry a string `id`. `seed` is used only the first time a
 * given key is initialized (nothing stored yet).
 *
 *   const { items, add, update, remove } = useCollection<Task>('tasks');
 *   add({ id: makeId(), title: 'Buy milk', done: false }); // saves + syncs everywhere
 */
export function useCollection<T extends { id: string }>(key: string, seed: T[] = []) {
  const store = getCollection<T>(key, seed);
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { items, ready: store.ready, add: store.add, update: store.update, remove: store.remove };
}

/** Small id helper for locally-created records (no crypto dependency). */
export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`;
}

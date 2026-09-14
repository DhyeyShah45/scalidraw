import { createStore, del, entries, get, set } from "idb-keyval";

/**
 * Minimal key/value seam over IndexedDB.
 *
 * The point is testability: the sync logic is where the interesting bugs live,
 * and it should be exercisable without a browser database. `createMemoryKV`
 * is a complete stand-in, so the tests below drive the real store code rather
 * than a mock of it.
 */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  entries<T>(): Promise<[string, T][]>;
}

export const createIdbKV = (dbName: string, storeName: string): KVStore => {
  const store = createStore(dbName, storeName);
  return {
    get: <T>(key: string) => get<T>(key, store),
    set: (key, value) => set(key, value, store),
    delete: (key) => del(key, store),
    entries: <T>() => entries<string, T>(store),
  };
};

export const createMemoryKV = (): KVStore => {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    entries: async <T>() => [...map.entries()] as [string, T][],
  };
};

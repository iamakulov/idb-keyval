import safariFix from 'safari-14-idb-fix';

export function promisifyRequest<T = undefined>(
  request: IDBRequest<T> | IDBTransaction,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // @ts-ignore - file size hacks
    request.oncomplete = request.onsuccess = () => resolve(request.result);
    // @ts-ignore - file size hacks
    request.onabort = request.onerror = () => reject(request.error);
  });
}

function createDbWithStore(
  dbName: string,
  storeName: string,
  version?: number,
) {
  const request = indexedDB.open(dbName, version);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName);
  return promisifyRequest(request);
}

export function createStore(dbName: string, storeName: string): UseStore {
  const dbp = safariFix()
    .then(() => createDbWithStore(dbName, storeName))
    .then((db) => {
      if (db.objectStoreNames.contains(storeName)) {
        return db;
      }

      // Sometimes, the DB gets into a weird state when the DB exists but the object store doesn’t.
      // (See eg https://github.com/jakearchibald/idb-keyval/issues/134.)
      // We’re handling this by upgrading the DB and creating the store.
      db.close();
      return createDbWithStore(dbName, storeName, db.version + 1);
    });

  return (txMode, callback) =>
    dbp.then((db) =>
      callback(db.transaction(storeName, txMode).objectStore(storeName)),
    );
}

export type UseStore = <T>(
  txMode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>,
) => Promise<T>;

let defaultGetStoreFunc: UseStore | undefined;

function defaultGetStore() {
  if (!defaultGetStoreFunc) {
    defaultGetStoreFunc = createStore('keyval-store', 'keyval');
  }
  return defaultGetStoreFunc;
}

/**
 * Get a value by its key.
 *
 * @param key
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function get<T = any>(
  key: IDBValidKey,
  customStore = defaultGetStore(),
): Promise<T | undefined> {
  return customStore('readonly', (store) => promisifyRequest(store.get(key)));
}

/**
 * Set a value with a key.
 *
 * @param key
 * @param value
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function set(
  key: IDBValidKey,
  value: any,
  customStore = defaultGetStore(),
): Promise<void> {
  return customStore('readwrite', (store) => {
    store.put(value, key);
    return promisifyRequest(store.transaction);
  });
}

/**
 * Set multiple values at once. This is faster than calling set() multiple times.
 * It's also atomic – if one of the pairs can't be added, none will be added.
 *
 * @param entries Array of entries, where each entry is an array of `[key, value]`.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function setMany(
  entries: [IDBValidKey, any][],
  customStore = defaultGetStore(),
): Promise<void> {
  return customStore('readwrite', (store) => {
    entries.forEach((entry) => store.put(entry[1], entry[0]));
    return promisifyRequest(store.transaction);
  });
}

/**
 * Get multiple values by their keys
 *
 * @param keys
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function getMany<T = any>(
  keys: IDBValidKey[],
  customStore = defaultGetStore(),
): Promise<T[]> {
  return customStore('readonly', (store) =>
    Promise.all(keys.map((key) => promisifyRequest(store.get(key)))),
  );
}

/**
 * Update a value. This lets you see the old value and update it as an atomic operation.
 *
 * @param key
 * @param updater A callback that takes the old value and returns a new value.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function update<T = any>(
  key: IDBValidKey,
  updater: (oldValue: T | undefined) => T,
  customStore = defaultGetStore(),
): Promise<void> {
  return customStore(
    'readwrite',
    (store) =>
      // Need to create the promise manually.
      // If I try to chain promises, the transaction closes in browsers
      // that use a promise polyfill (IE10/11).
      new Promise((resolve, reject) => {
        store.get(key).onsuccess = function () {
          try {
            store.put(updater(this.result), key);
            resolve(promisifyRequest(store.transaction));
          } catch (err) {
            reject(err);
          }
        };
      }),
  );
}

/**
 * Delete a particular key from the store.
 *
 * @param key
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function del(
  key: IDBValidKey,
  customStore = defaultGetStore(),
): Promise<void> {
  return customStore('readwrite', (store) => {
    store.delete(key);
    return promisifyRequest(store.transaction);
  });
}

/**
 * Delete multiple keys at once.
 *
 * @param keys List of keys to delete.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function delMany(
  keys: IDBValidKey[],
  customStore = defaultGetStore(),
): Promise<void> {
  return customStore('readwrite', (store: IDBObjectStore) => {
    keys.forEach((key: IDBValidKey) => store.delete(key));
    return promisifyRequest(store.transaction);
  });
}

/**
 * Clear all values in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function clear(customStore = defaultGetStore()): Promise<void> {
  return customStore('readwrite', (store) => {
    store.clear();
    return promisifyRequest(store.transaction);
  });
}

function eachCursor(
  customStore: UseStore,
  callback: (cursor: IDBCursorWithValue) => void,
): Promise<void> {
  return customStore('readonly', (store) => {
    // This would be store.getAllKeys(), but it isn't supported by Edge or Safari.
    // And openKeyCursor isn't supported by Safari.
    store.openCursor().onsuccess = function () {
      if (!this.result) return;
      callback(this.result);
      this.result.continue();
    };
    return promisifyRequest(store.transaction);
  });
}

/**
 * Get all keys in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function keys<KeyType extends IDBValidKey>(
  customStore = defaultGetStore(),
): Promise<KeyType[]> {
  const items: KeyType[] = [];

  return eachCursor(customStore, (cursor) =>
    items.push(cursor.key as KeyType),
  ).then(() => items);
}

/**
 * Get all values in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function values<T = any>(customStore = defaultGetStore()): Promise<T[]> {
  const items: T[] = [];

  return eachCursor(customStore, (cursor) => items.push(cursor.value)).then(
    () => items,
  );
}

/**
 * Get all entries in the store. Each entry is an array of `[key, value]`.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
export function entries<KeyType extends IDBValidKey, ValueType = any>(
  customStore = defaultGetStore(),
): Promise<[KeyType, ValueType][]> {
  const items: [KeyType, ValueType][] = [];

  return eachCursor(customStore, (cursor) =>
    items.push([cursor.key as KeyType, cursor.value]),
  ).then(() => items);
}

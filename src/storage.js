// Logged rows kept in IndexedDB, so a reload or a killed tab does not lose a session.
// Rows are appended in batches; the log stays until the user clears it.

const DB_NAME = 'drifthing-obd';
const STORE = 'row-batches';

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
  return done(request);
}

export class RowStore {
  constructor(db) {
    this.db = db;
  }

  /** Falls back to memory only (persistent === false) where IndexedDB is unavailable. */
  static async create() {
    try {
      return new RowStore(await openDatabase());
    } catch {
      return new RowStore(null);
    }
  }

  get persistent() {
    return this.db !== null;
  }

  #store(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async load() {
    if (!this.db) return [];
    const batches = await done(this.#store('readonly').getAll());
    return batches.flat();
  }

  async append(rows) {
    if (!this.db || !rows.length) return;
    await done(this.#store('readwrite').add(rows));
  }

  async clear() {
    if (!this.db) return;
    await done(this.#store('readwrite').clear());
  }
}

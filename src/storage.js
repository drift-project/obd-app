// The log kept in IndexedDB, so a reload or a killed tab does not lose a session.
// Car rows and phone samples are appended in batches about once a second and
// stay until the user clears the log.
//
// The two kinds live in separate databases. Adding a store to the database of
// an earlier version would need a version upgrade, which waits for as long as
// another tab still has the old database open.

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(name, store) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(store, { autoIncrement: true });
  return done(request);
}

/** Batches appended in order; where IndexedDB is unavailable it holds nothing (persistent === false). */
class BatchStore {
  constructor(db, store) {
    this.db = db;
    this.store = store;
  }

  get persistent() {
    return this.db !== null;
  }

  #open(mode) {
    return this.db.transaction(this.store, mode).objectStore(this.store);
  }

  async all() {
    if (!this.db) return [];
    return done(this.#open('readonly').getAll());
  }

  async add(batch) {
    if (!this.db) return;
    await done(this.#open('readwrite').add(batch));
  }

  async clear() {
    if (!this.db) return;
    await done(this.#open('readwrite').clear());
  }
}

async function batchStore(name, store) {
  try {
    return new BatchStore(await openDatabase(name, store), store);
  } catch {
    return new BatchStore(null, store);
  }
}

/** Rows from the car. */
export class RowStore {
  #batches;

  constructor(batches) {
    this.#batches = batches;
  }

  static async create() {
    return new RowStore(await batchStore('drifthing-obd', 'row-batches'));
  }

  get persistent() {
    return this.#batches.persistent;
  }

  async load() {
    return (await this.#batches.all()).flat();
  }

  async append(rows) {
    if (rows.length) await this.#batches.add(rows);
  }

  clear() {
    return this.#batches.clear();
  }
}

/** Phone sensor samples: one batch is `{ stream name: Float64Array }` as SampleLog.take() returns it. */
export class SampleStore {
  #batches;

  constructor(batches) {
    this.#batches = batches;
  }

  static async create() {
    return new SampleStore(await batchStore('drifthing-obd-samples', 'batches'));
  }

  get persistent() {
    return this.#batches.persistent;
  }

  load() {
    return this.#batches.all();
  }

  append(batch) {
    return this.#batches.add(batch);
  }

  clear() {
    return this.#batches.clear();
  }
}

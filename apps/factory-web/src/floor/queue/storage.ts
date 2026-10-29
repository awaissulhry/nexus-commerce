import { NO_NUMBERS, type Numbers, type QueueItem } from './model'

/**
 * Where the tablet keeps its queue (PLT-237, PLT-242): IndexedDB, so actions survive a reload, a sign-out, a dead
 * battery and a browser restart; a memory store where IndexedDB does not exist (tests, a private window — the screen
 * then says the data may not be kept). One database per browser profile; every item names its tablet.
 *
 *   events   one record per queued action (key: clientEventId)
 *   meta     `nextSeq` (the queue's next place), `numbers` (the tablet's label blocks and the numbers it took),
 *            `lastSentAt` (the last answer from the server)
 */

export interface Meta {
  readonly nextSeq: number
  readonly numbers: Numbers
  readonly lastSentAt: string | null
}

export const EMPTY_META: Meta = Object.freeze({ nextSeq: 1, numbers: NO_NUMBERS, lastSentAt: null })

export interface QueueStorage {
  load(): Promise<{ items: QueueItem[]; meta: Meta }>
  /** Writes these items (added or changed) and the meta, in one transaction. */
  save(items: readonly QueueItem[], meta: Meta): Promise<void>
  /** Removes items (pruned). */
  remove(clientEventIds: readonly string[]): Promise<void>
  /** IndexedDB: the data stays; memory: it goes with the page. */
  readonly durable: boolean
}

export const DB_NAME = 'nexus-floor-queue'
const VERSION = 1

export function memoryStorage(seed: { items?: QueueItem[]; meta?: Meta } = {}): QueueStorage {
  const items = new Map((seed.items ?? []).map((item) => [item.clientEventId, item]))
  let meta = seed.meta ?? EMPTY_META
  return {
    durable: false,
    async load() {
      return { items: [...items.values()], meta }
    },
    async save(changed, next) {
      for (const item of changed) items.set(item.clientEventId, item)
      meta = next
    },
    async remove(ids) {
      for (const id of ids) items.delete(id)
    },
  }
}

const done = (request: IDBRequest | IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    if ('oncomplete' in request) {
      request.oncomplete = () => resolve()
      request.onabort = () => reject(request.error)
      request.onerror = () => reject(request.error)
    } else {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }
  })

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'clientEventId' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function indexedDbStorage(factory: IDBFactory): QueueStorage {
  let db: Promise<IDBDatabase> | null = null
  const database = () => (db ??= open(factory))
  return {
    durable: true,
    async load() {
      const handle = await database()
      const tx = handle.transaction(['events', 'meta'], 'readonly')
      const all = tx.objectStore('events').getAll()
      const stored = tx.objectStore('meta').get('meta')
      await done(tx)
      return { items: (all.result as QueueItem[]) ?? [], meta: { ...EMPTY_META, ...((stored.result as Partial<Meta> | undefined) ?? {}) } }
    },
    async save(changed, meta) {
      const handle = await database()
      const tx = handle.transaction(['events', 'meta'], 'readwrite')
      const events = tx.objectStore('events')
      for (const item of changed) events.put(item)
      tx.objectStore('meta').put(meta, 'meta')
      await done(tx)
    },
    async remove(ids) {
      if (ids.length === 0) return
      const handle = await database()
      const tx = handle.transaction('events', 'readwrite')
      for (const id of ids) tx.objectStore('events').delete(id)
      await done(tx)
    },
  }
}

/** The browser's IndexedDB, else memory. */
export function browserStorage(): QueueStorage {
  try {
    if (typeof indexedDB !== 'undefined') return indexedDbStorage(indexedDB)
  } catch {
    // A browser that refuses IndexedDB (a private window): memory, and the screen says so.
  }
  return memoryStorage()
}

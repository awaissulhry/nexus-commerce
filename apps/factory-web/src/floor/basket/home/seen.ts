/**
 * owb-fl5 (lead settle 12; design § 5zf B "For you", § 5zg C "ONE list") — what THIS person already opened of "For you", kept on the
 * device only: no read record of a worker anywhere (Statuto dei Lavoratori art. 4). The server lists the items; the phone hides a news
 * line once it was opened here. A problem or an ask that waits is never hidden: it stays while the server lists it.
 *
 * Kept per worker in IndexedDB (a memory store where there is none: a private window, a test); a storage failure shows a line again,
 * never blocks the page. Pure helpers first, so the tests hold them. web B (fl8) imports these; there is no second store.
 */

/** The kinds that are news: hidden once opened on this device. PROBLEM and ASK are live, never hidden here. */
export const SEEN_KINDS: readonly string[] = ['CHANGED_DESIGN', 'ANSWER', 'SOLVED', 'HANDOVER']

/** How many keys one person keeps (the oldest fall off). */
export const SEEN_KEPT = 300

export interface SeenItem {
  readonly kind: string
  readonly bundleId: string | null
  readonly at: string
}

/** One line's key: its kind, its basket and when it happened (a new answer on the same basket is a new line). */
export const seenKeyOf = (item: SeenItem): string => `${item.kind}:${item.bundleId ?? '-'}:${item.at}`

/** The lines still to show: news not opened on this device, and every live problem or ask. */
export function unseenForYou<T extends SeenItem>(items: readonly T[], seen: readonly string[]): T[] {
  const opened = new Set(seen)
  return items.filter((item) => !SEEN_KINDS.includes(item.kind) || !opened.has(seenKeyOf(item)))
}

/** The keys with one more, newest last, at most SEEN_KEPT. */
export function withSeen(seen: readonly string[], key: string): string[] {
  return seen.includes(key) ? [...seen] : [...seen, key].slice(-SEEN_KEPT)
}

export interface SeenStore {
  read(workerId: string): Promise<string[]>
  mark(workerId: string, key: string): Promise<string[]>
}

export function memorySeenStore(): SeenStore {
  const kept = new Map<string, string[]>()
  return {
    async read(workerId) {
      return [...(kept.get(workerId) ?? [])]
    },
    async mark(workerId, key) {
      const next = withSeen(kept.get(workerId) ?? [], key)
      kept.set(workerId, next)
      return next
    },
  }
}

const DB_NAME = 'nexus-floor-seen'
const STORE = 'seen'

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(-SEEN_KEPT) : [])

/** IndexedDB, one record per worker (key: the worker's id; value: the keys). Any failure reads as nothing seen. */
export function indexedSeenStore(idb: IDBFactory): SeenStore {
  const get = async (workerId: string): Promise<string[]> => {
    const db = await open(idb)
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(workerId)
        request.onsuccess = () => resolve(keysOf(request.result))
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }
  return {
    async read(workerId) {
      try {
        return await get(workerId)
      } catch {
        return []
      }
    },
    async mark(workerId, key) {
      let next: string[] = [key]
      try {
        next = withSeen(await get(workerId), key)
        const db = await open(idb)
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite')
            tx.objectStore(STORE).put(next, workerId)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error)
          })
        } finally {
          db.close()
        }
      } catch {
        // Blocked or cleared storage: the line may show again after a reload, never zero times.
      }
      return next
    },
  }
}

let shared: SeenStore | null = null

/** The device's store (IndexedDB where it exists). */
export function seenStore(): SeenStore {
  if (!shared) shared = typeof indexedDB !== 'undefined' ? indexedSeenStore(indexedDB) : memorySeenStore()
  return shared
}

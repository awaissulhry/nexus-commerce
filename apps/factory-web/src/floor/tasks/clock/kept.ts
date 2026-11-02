import type { ClockAction } from '@nexus/factory-domain/people/clock/rules'

/**
 * Badges scanned on the clock while the tablet is offline (design floor.clock "Offline clocking"; MES-199; B-W2b-33's
 * note: "keep it only until sent"). The queue (B-W0-30) sends the signed-in person's actions; a kiosk has nobody signed in
 * and the route needs the badge, so the code waits here until the network is back: sealed with a key the browser will not
 * give out (AES-GCM, not extractable, kept in IndexedDB), and gone the moment the office answered. The tablet's own time
 * goes with it (`occurredAt`), and the tablet's clock at sending (`sentAt`), so a wrong clock is flagged.
 *
 * A code never reaches a snapshot, a log or a screen. A tablet that cannot seal (no Web Crypto, no IndexedDB) keeps
 * nothing: `available` is false and the screen says so. A final refusal drops the code and keeps one line without it, so
 * the next person at the tablet can tell the team leader; a line leaves after a day.
 */

export interface Sealed {
  readonly iv: Uint8Array
  readonly data: ArrayBuffer
}

export interface KeptClock {
  readonly clientEventId: string
  readonly action: ClockAction
  readonly occurredAt: string
  readonly sealed: Sealed
}

/** A kept clocking the office refused: no badge, no name. */
export interface KeptRefusal {
  readonly clientEventId: string
  readonly action: ClockAction
  readonly occurredAt: string
  readonly code: string | null
}

export interface KeptStorage {
  load(): Promise<{ items: KeptClock[]; refused: KeptRefusal[] }>
  put(item: KeptClock): Promise<void>
  /** The item leaves (with its sealed code); a refusal line takes its place when given. */
  remove(clientEventId: string, refusal?: KeptRefusal): Promise<void>
  dropRefused(clientEventIds: readonly string[]): Promise<void>
  seal(code: string): Promise<Sealed>
  open(sealed: Sealed): Promise<string>
}

/** The office's answer to one kept badge. */
export type SendAnswer = { readonly kind: 'done' } | { readonly kind: 'refused'; readonly code: string | null } | { readonly kind: 'later' }

export type SendKept = (kept: { readonly badgeCode: string; readonly clientEventId: string; readonly action: ClockAction; readonly occurredAt: string }, sentAt: string) => Promise<SendAnswer>

export interface KeptSnapshot {
  readonly ready: boolean
  /** A code can be kept here (sealed storage works). */
  readonly available: boolean
  /** Clockings waiting for the network. */
  readonly waiting: number
  readonly refused: readonly KeptRefusal[]
}

const DAY = 24 * 60 * 60_000
const DB = 'nexus-floor-clock'

async function sealWith(key: CryptoKey, code: string): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  return { iv, data: await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(code)) }
}

async function openWith(key: CryptoKey, sealed: Sealed): Promise<string> {
  return new TextDecoder().decode(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, key, sealed.data))
}

const newKey = () => globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

/** In memory (tests): a real key, gone with the page. */
export function memoryKeptStorage(): KeptStorage {
  const items = new Map<string, KeptClock>()
  const refused = new Map<string, KeptRefusal>()
  let key: Promise<CryptoKey> | null = null
  const keyOf = () => (key ??= newKey())
  return {
    async load() {
      return { items: [...items.values()], refused: [...refused.values()] }
    },
    async put(item) {
      items.set(item.clientEventId, item)
    },
    async remove(id, refusal) {
      items.delete(id)
      if (refusal) refused.set(id, refusal)
    },
    async dropRefused(ids) {
      for (const id of ids) refused.delete(id)
    },
    seal: async (code) => sealWith(await keyOf(), code),
    open: async (sealed) => openWith(await keyOf(), sealed),
  }
}

const finished = (request: IDBRequest | IDBTransaction) =>
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

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('items', { keyPath: 'clientEventId' })
      db.createObjectStore('refused', { keyPath: 'clientEventId' })
      db.createObjectStore('key')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function indexedKeptStorage(factory: IDBFactory): KeptStorage {
  let db: Promise<IDBDatabase> | null = null
  let key: Promise<CryptoKey> | null = null
  const database = () => (db ??= openDb(factory))
  const keyOf = () =>
    (key ??= (async () => {
      const store = await database()
      const read = store.transaction('key').objectStore('key').get('seal') as IDBRequest<CryptoKey | undefined>
      await finished(read)
      if (read.result) return read.result
      const fresh = await newKey()
      const tx = store.transaction('key', 'readwrite')
      tx.objectStore('key').put(fresh, 'seal')
      await finished(tx)
      return fresh
    })())
  return {
    async load() {
      const store = await database()
      const tx = store.transaction(['items', 'refused'])
      const items = tx.objectStore('items').getAll() as IDBRequest<KeptClock[]>
      const refused = tx.objectStore('refused').getAll() as IDBRequest<KeptRefusal[]>
      await finished(tx)
      return { items: items.result, refused: refused.result }
    },
    async put(item) {
      const tx = (await database()).transaction('items', 'readwrite')
      tx.objectStore('items').put(item)
      await finished(tx)
    },
    async remove(id, refusal) {
      const tx = (await database()).transaction(['items', 'refused'], 'readwrite')
      tx.objectStore('items').delete(id)
      if (refusal) tx.objectStore('refused').put(refusal)
      await finished(tx)
    },
    async dropRefused(ids) {
      const tx = (await database()).transaction('refused', 'readwrite')
      for (const id of ids) tx.objectStore('refused').delete(id)
      await finished(tx)
    },
    seal: async (code) => sealWith(await keyOf(), code),
    open: async (sealed) => openWith(await keyOf(), sealed),
  }
}

/** The tablet's sealed store, or null where a code cannot be kept safely. */
export function browserKeptStorage(): KeptStorage | null {
  if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return null
  return indexedKeptStorage(indexedDB)
}

export class KeptClocks {
  private snapshot: KeptSnapshot
  private readonly listeners = new Set<() => void>()
  private items: KeptClock[] = []
  private flight: Promise<void> | null = null
  private readonly now: () => Date

  constructor(
    private readonly storage: KeptStorage | null,
    private readonly send: SendKept,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.snapshot = { ready: false, available: storage !== null, waiting: 0, refused: [] }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): KeptSnapshot => this.snapshot

  private set(next: Partial<KeptSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, waiting: this.items.length }
    for (const listener of this.listeners) listener()
  }

  /** Reads what the tablet kept; refusal lines older than a day leave. A store that fails keeps nothing, and says so. */
  async start(): Promise<void> {
    if (!this.storage) return this.set({ ready: true })
    try {
      const { items, refused } = await this.storage.load()
      const limit = this.now().getTime() - DAY
      const kept = refused.filter((entry) => new Date(entry.occurredAt).getTime() >= limit)
      const old = refused.filter((entry) => !kept.includes(entry)).map((entry) => entry.clientEventId)
      if (old.length > 0) await this.storage.dropRefused(old)
      this.items = items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      this.set({ ready: true, refused: kept })
    } catch {
      this.set({ ready: true, available: false })
    }
  }

  /** Keeps a scanned badge with the tablet's time. False: this tablet cannot keep it (the screen says so). */
  async add(badgeCode: string, action: ClockAction, clientEventId: string): Promise<boolean> {
    if (!this.storage || !this.snapshot.available) return false
    try {
      const item: KeptClock = { clientEventId, action, occurredAt: this.now().toISOString(), sealed: await this.storage.seal(badgeCode) }
      await this.storage.put(item)
      this.items = [...this.items, item]
      this.set({})
      return true
    } catch {
      return false
    }
  }

  /** Sends what waits, oldest first, one at a time; stops at the first that must wait (no network, too many at once). */
  flush(): Promise<void> {
    this.flight ??= this.run().finally(() => {
      this.flight = null
    })
    return this.flight
  }

  private async run(): Promise<void> {
    const storage = this.storage
    if (!storage) return
    for (const item of [...this.items]) {
      let answer: SendAnswer
      try {
        answer = await this.send({ badgeCode: await storage.open(item.sealed), clientEventId: item.clientEventId, action: item.action, occurredAt: item.occurredAt }, this.now().toISOString())
      } catch {
        answer = { kind: 'later' }
      }
      if (answer.kind === 'later') return
      const refusal: KeptRefusal | undefined = answer.kind === 'refused' ? { clientEventId: item.clientEventId, action: item.action, occurredAt: item.occurredAt, code: answer.code } : undefined
      await storage.remove(item.clientEventId, refusal)
      this.items = this.items.filter((entry) => entry !== item)
      this.set(refusal ? { refused: [...this.snapshot.refused, refusal] } : {})
    }
  }

  /** The person told the team leader: the line leaves. */
  async dismiss(clientEventId: string): Promise<void> {
    await this.storage?.dropRefused([clientEventId])
    this.set({ refused: this.snapshot.refused.filter((entry) => entry.clientEventId !== clientEventId) })
  }
}

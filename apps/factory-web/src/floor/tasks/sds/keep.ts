import type { SdsPack } from './api'

/**
 * What the tablet keeps for the cabinet QR (B-W2b-143; model.ts says what and why): the site's pack and the PDF bytes of its
 * current sheets, in the browser's IndexedDB (database `nexus-floor-sds`: store `packs` by site id, store `files` by file id
 * with the SHA-256). Kept across reloads and power cuts, on this tablet only; nothing personal and no money is in it. Without
 * IndexedDB (a test, a private window) it keeps them in memory for this visit.
 */

export interface KeptFile {
  readonly fileId: string
  readonly sha256: string
  readonly bytes: Uint8Array
}

export interface SdsKeeper {
  pack(siteId: string): Promise<SdsPack | null>
  savePack(pack: SdsPack): Promise<void>
  /** The kept files' ids with their SHA-256 (no bytes). */
  files(): Promise<Map<string, string>>
  file(fileId: string): Promise<KeptFile | null>
  saveFile(file: KeptFile): Promise<void>
  dropFiles(fileIds: readonly string[]): Promise<void>
}

/** The keeper in memory (tests, and a browser without IndexedDB). */
export function memoryKeeper(): SdsKeeper {
  const packs = new Map<string, SdsPack>()
  const files = new Map<string, KeptFile>()
  return {
    pack: async (siteId) => packs.get(siteId) ?? null,
    savePack: async (pack) => void packs.set(pack.siteId, pack),
    files: async () => new Map([...files.values()].map((file) => [file.fileId, file.sha256])),
    file: async (fileId) => files.get(fileId) ?? null,
    saveFile: async (file) => void files.set(file.fileId, file),
    dropFiles: async (ids) => ids.forEach((id) => files.delete(id)),
  }
}

const DB = 'nexus-floor-sds'
const PACKS = 'packs'
const FILES = 'files'

function request<T>(work: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    work.onsuccess = () => resolve(work.result)
    work.onerror = () => reject(work.error)
  })
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DB, 1)
    opening.onupgradeneeded = () => {
      const db = opening.result
      if (!db.objectStoreNames.contains(PACKS)) db.createObjectStore(PACKS, { keyPath: 'siteId' })
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'fileId' })
    }
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
}

/** The keeper in IndexedDB. */
export function indexedDbKeeper(factory: IDBFactory): SdsKeeper {
  let db: Promise<IDBDatabase> | null = null
  const store = async (name: string, mode: IDBTransactionMode) => {
    db ??= openDb(factory)
    return (await db).transaction(name, mode).objectStore(name)
  }
  return {
    pack: async (siteId) => ((await request((await store(PACKS, 'readonly')).get(siteId))) as SdsPack | undefined) ?? null,
    savePack: async (pack) => void (await request((await store(PACKS, 'readwrite')).put(pack))),
    files: async () => {
      const rows = (await request((await store(FILES, 'readonly')).getAll())) as KeptFile[]
      return new Map(rows.map((row) => [row.fileId, row.sha256]))
    },
    file: async (fileId) => ((await request((await store(FILES, 'readonly')).get(fileId))) as KeptFile | undefined) ?? null,
    saveFile: async (file) => void (await request((await store(FILES, 'readwrite')).put(file))),
    dropFiles: async (ids) => {
      const files = await store(FILES, 'readwrite')
      await Promise.all(ids.map((id) => request(files.delete(id))))
    },
  }
}

let shared: SdsKeeper | null = null

/** This tablet's keeper: IndexedDB when the browser has it, else memory. */
export function tabletKeeper(): SdsKeeper {
  if (shared) return shared
  try {
    shared = typeof indexedDB !== 'undefined' ? indexedDbKeeper(indexedDB) : memoryKeeper()
  } catch {
    shared = memoryKeeper()
  }
  return shared
}

/** SHA-256 of the bytes, 64 lower-case hex digits. */
export async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

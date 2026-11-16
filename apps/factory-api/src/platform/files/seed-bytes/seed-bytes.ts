import { createHash } from 'node:crypto'
import { seedFileBytes, type SeedFileFacts } from '@nexus/factory-db/seed-files'
import { isStrippable, stripImageMetadata } from '@nexus/factory-domain/files/thumbs/strip'
import type { CommandCaller } from '../../../core/command'
import { GatewayRefusal } from '../../gateway/gateway'
import type { FilesRuntime } from '../service'

/**
 * The bytes of the seeded files in a seeded stack's store (B-W2b-F59). The seeds (packages/factory-db seed/*.ts) write the
 * StoredFile rows only, each with the SHA-256 of its bytes (factory-db seed-files.ts); this puts those bytes in the store,
 * through the files platform's own path: one gateway call `files.put` per object (store.ts), so a FAKE R2 account's
 * object lands in the local folder (FACTORY_LOCAL_FILES_DIR on a local test server, the harness's folder in a test) under
 * the row's own key, exactly where an upload's would.
 *
 *   which rows    the tenant's AVAILABLE files whose bytes seedFileBytes makes again from the row (the same SHA-256): the
 *                 seeded ones. A file someone uploaded has other bytes and is left alone (counted `notSeeded`). A copy
 *                 (sourceFileId) holds its source's bytes, as the database checks.
 *   thumbnails    a seeded picture that names its stripped copy (thumbnailKey) gets it too: the picture through
 *                 factory-domain's stripImageMetadata, as thumbs/strip-copy.ts makes it.
 *   again         a second run writes the same bytes under the same keys (files.put is idempotent).
 *   rate limit    the store account's limit (60 calls a minute by default) is waited out, never raised: a refused call
 *                 (rate_limited) is tried again after the wait the gateway names.
 *
 * Who runs it: `npm run seed:files -w @nexus/factory-api` (cli.ts) after a seed on a local test server, and the tests that
 * read a seeded file's bytes. Nothing else: the PostgreSQL tests that do not read bytes never call it, so a seed stays as
 * fast as before (only the hashes are computed, in memory).
 */

export interface SeedBytesOutcome {
  /** Objects put (a file each). */
  readonly written: number
  /** Stripped copies put. */
  readonly thumbnails: number
  /** AVAILABLE files whose bytes are not the seed's (an upload): left alone. */
  readonly notSeeded: number
}

export interface SeedBytesOptions {
  /** Waits out a rate limit (default: a timer). */
  readonly sleep?: (ms: number) => Promise<void>
  /** At most this many tries of one call refused by the rate limit (default 600: ten minutes at one a second). */
  readonly maxTries?: number
}

const SELECT = { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true, thumbnailKey: true, sourceFileId: true } as const

const sha256Of = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')

/** Puts the bytes of every seeded file of the caller's tenant (a tenant's system caller or an office session). */
export async function putSeedFileBytes(runtime: FilesRuntime, caller: CommandCaller, options: SeedBytesOptions = {}): Promise<SeedBytesOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxTries = options.maxTries ?? 600
  const rows = await caller.withClient((client) => client.storedFile.findMany({ where: { status: 'AVAILABLE' }, select: SELECT, orderBy: { id: 'asc' } }))
  const sources = new Map(rows.map((row) => [row.id, row]))
  /** The file whose bytes a row holds: its own, or (a copy) its source's, followed to the first one. */
  const bytesOf = (row: (typeof rows)[number]): SeedFileFacts => {
    let at = row
    for (let hops = 0; at.sourceFileId && hops < 16; hops += 1) at = sources.get(at.sourceFileId) ?? at
    return { id: at.id, originalName: at.originalName, contentType: at.contentType, sizeBytes: Number(at.sizeBytes) }
  }
  const patiently = async (put: () => Promise<void>): Promise<void> => {
    for (let tries = 1; ; tries += 1) {
      try {
        return await put()
      } catch (error) {
        if (!(error instanceof GatewayRefusal) || error.reason !== 'rate_limited' || tries >= maxTries) throw error
        await sleep(Math.max(250, error.retryAfterMs ?? 1000))
      }
    }
  }

  let written = 0
  let thumbnails = 0
  let notSeeded = 0
  for (const row of rows) {
    let body: Buffer
    try {
      body = seedFileBytes(bytesOf(row))
    } catch {
      notSeeded += 1
      continue
    }
    const sha256 = sha256Of(body)
    if (sha256 !== row.sha256) {
      notSeeded += 1
      continue
    }
    await patiently(() => runtime.storage.put(caller, row.storeAccountId, { key: row.storageKey, contentType: row.contentType, body, sha256 }))
    written += 1
    if (row.thumbnailKey && isStrippable(row.contentType)) {
      const stripped = stripImageMetadata(body, row.contentType)
      if (stripped.ok) {
        const copy = stripped.bytes
        await patiently(() => runtime.storage.put(caller, row.storeAccountId, { key: row.thumbnailKey!, contentType: row.contentType, body: copy, sha256: sha256Of(copy) }))
        thumbnails += 1
      }
    }
  }
  return { written, thumbnails, notSeeded }
}

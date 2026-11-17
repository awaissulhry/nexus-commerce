import { createHash, randomUUID } from 'node:crypto'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isPicture, isStrippable, stripImageMetadata } from '@nexus/factory-domain/files/thumbs/strip'
import { command, type CommandCaller } from '../../../core/command'
import { GatewayCallFailed, GatewayRefusal } from '../../gateway/gateway'
import { contextOf, tenantOf } from '../files'
import { storageKeyFor } from '../rules'
import type { FilesRuntime } from '../service'
// B-TH-063: the small preview, made with the stripped copy.
import { makeSmallPreview, smallKeyOf } from './small'

/**
 * The stripped copy of a picture (COL-058; B-W2b-160): what a portal or a link is shown of a photo. OUTSIDE any
 * transaction, as the tenant's system caller (or an office session):
 *
 *   1. the file as stored: AVAILABLE (so after its virus scan, when a scanner is on), a picture, no copy yet;
 *   2. its bytes from the store (files.read) → factory-domain files/thumbs/strip.ts: EXIF with its GPS position, XMP,
 *      IPTC, comments and anything after the picture removed, the orientation kept, the image data unchanged;
 *   3. the copy put under a new key of the same store (files.put; never under `legal/`, never the file's own key);
 *   3b. B-TH-063: its small preview (about 320 px, small.ts: from the copy's pixels, turned the right way up) put under
 *      the key derived from the copy's key — before step 4, so a file whose `thumbnailKey` is set has its preview;
 *   4. ONE command files.recordStrippedCopy writes `thumbnailKey` + `exifStrippedAt` (the database lets them be set once,
 *      together, while the file is AVAILABLE) with its audit row: what was removed, whether a position was in it, and
 *      how the small preview was made (RESIZED or COPIED, its size).
 *
 * Who runs it: the worker after `file.available` (thumbs/handler.ts) for every picture, and a portal's or a link's own
 * preview or download when the worker has not got to it yet (thumbs/outside.ts). Two at once: the first command wins, the
 * other's object is removed. A HEIC picture (or a damaged one) gets no copy, so it is never shown outside the office.
 */

// B-W2b-F56: `missing`: the store answered and holds no bytes for the file (never `store_unavailable`, which is worth a retry).
export type StripOutcome = 'made' | 'exists' | 'not_available' | 'not_picture' | 'unsupported' | 'unreadable' | 'store_unavailable' | 'missing'

const SELECT = { id: true, companyId: true, contentType: true, sizeBytes: true, storeAccountId: true, storageKey: true, status: true, thumbnailKey: true } as const

const storeDown = (error: unknown): boolean => error instanceof GatewayRefusal || error instanceof GatewayCallFailed

/** Makes the picture's stripped copy unless it has one; returns what happened and the copy's key (null: none). */
export async function makeStrippedCopy(runtime: FilesRuntime, caller: CommandCaller, fileId: string): Promise<{ readonly outcome: StripOutcome; readonly key: string | null }> {
  if (!isUuid(fileId)) throw new NotFoundError('File not found.')
  const row = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: SELECT }))
  if (!row) throw new NotFoundError('File not found.')
  if (row.thumbnailKey) return { outcome: 'exists', key: row.thumbnailKey }
  if (row.status !== 'AVAILABLE') return { outcome: 'not_available', key: null }
  if (!isPicture(row.contentType)) return { outcome: 'not_picture', key: null }
  if (!isStrippable(row.contentType)) return { outcome: 'unsupported', key: null }
  let bytes: Buffer | null
  try {
    bytes = await runtime.storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes)
  } catch (error) {
    if (storeDown(error)) return { outcome: 'store_unavailable', key: null }
    throw error
  }
  if (!bytes) return { outcome: 'missing', key: null }
  const stripped = stripImageMetadata(bytes, row.contentType)
  if (!stripped.ok) return { outcome: stripped.reason, key: null }
  const body = Buffer.from(stripped.bytes.buffer, stripped.bytes.byteOffset, stripped.bytes.byteLength)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const now = runtime.clock.now()
  // A PHOTO's key: never under `legal/` (a fiscal archive file is never a picture anyway).
  const key = storageKeyFor({ tenantId: tenantOf(contextOf(caller)), companyId: row.companyId, kind: 'PHOTO', now, random: randomUUID() })
  try {
    await runtime.storage.put(caller, row.storeAccountId, { key, contentType: row.contentType, body, sha256 })
  } catch (error) {
    if (storeDown(error)) return { outcome: 'store_unavailable', key: null }
    throw error
  }
  // B-TH-063: the small preview, under the key derived from the copy's; if it cannot be put, the copy goes too (the job
  // tries again with a new key), so no file ever names a copy without its preview.
  const small = makeSmallPreview(stripped.bytes, row.contentType)
  const smallBody = Buffer.from(small.bytes.buffer, small.bytes.byteOffset, small.bytes.byteLength)
  const smallKey = smallKeyOf(key)
  const removeObject = (objectKey: string) => runtime.storage.remove(caller, row.storeAccountId, { key: objectKey, legalHold: false, retainUntil: null }, now).catch(() => {})
  try {
    await runtime.storage.put(caller, row.storeAccountId, { key: smallKey, contentType: row.contentType, body: smallBody, sha256: createHash('sha256').update(smallBody).digest('hex') })
  } catch (error) {
    await removeObject(key)
    if (storeDown(error)) return { outcome: 'store_unavailable', key: null }
    throw error
  }
  const smallFacts = { made: small.made, width: small.width, height: small.height, sizeBytes: smallBody.length, ...(small.reason ? { reason: small.reason } : {}) }
  const { result } = await command(
    caller,
    { name: 'files.recordStrippedCopy', idempotencyKey: `files-strip.${fileId}.${newId()}`, input: { fileId }, record: { type: 'StoredFile', id: fileId } },
    async ({ tx, audit, now: at }) => {
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { thumbnailKey: true, status: true, companyId: true } })
      if (current.thumbnailKey || current.status !== 'AVAILABLE') {
        audit({ recordType: 'StoredFile', recordId: fileId, companyId: current.companyId, after: { strippedCopy: current.thumbnailKey ? 'made meanwhile' : `not made: the file is ${current.status}` } })
        return current.thumbnailKey
      }
      await tx.storedFile.update({ where: { id: fileId }, data: { thumbnailKey: key, exifStrippedAt: at }, select: { id: true } })
      audit({ recordType: 'StoredFile', recordId: fileId, companyId: current.companyId, after: { strippedCopy: true, removed: [...stripped.removed], location: stripped.location, sizeBytes: body.length, smallPreview: smallFacts } })
      return key
    },
  )
  if (result !== key) {
    // Another run recorded its copy first (or the file went): this object names nothing, so it goes (B-TH-063: and its
    // small preview).
    await removeObject(key)
    await removeObject(smallKey)
  }
  return result === key ? { outcome: 'made', key } : { outcome: result ? 'exists' : 'not_available', key: result }
}

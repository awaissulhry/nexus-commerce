import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { readPublicDocCode } from '@nexus/factory-domain/compliance/public-doc/code'
import type { PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { isStrippable } from '@nexus/factory-domain/files/thumbs/strip'
import { abuseGuardOf } from '../../../platform/abuse/guard'
import { systemCallerOf } from '../../../platform/files/files'
import { KIND_RULES } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { makeStrippedCopy } from '../../../platform/files/thumbs/strip-copy'
import { GatewayCallFailed, GatewayRefusal } from '../../../platform/gateway/gateway'
import { mainPictures } from '../../product/images/main-picture'
import type { CodeMatch } from './facts'

/**
 * The public DoC page's picture (B-W2b-236, SY3:03; the B-W2b-166 gap "no picture"): the style's MAIN picture, shown to
 * anyone holding the garment only through its copy stripped of camera and location data (B-W2b-160's thumbnailKey: EXIF,
 * GPS, XMP and IPTC removed), never the office's file. A batch shows its style's picture.
 *
 *   page     `picture: { fileId, contentType, caption } | null` on the lookup's page (public-doc.ts pagesUnder): the style's
 *            main picture when its file is AVAILABLE and can be stripped (JPEG, PNG, WebP); null otherwise
 *   bytes    GET /public/doc/:code/picture/:fileId (PUBLIC, rate-limited per address as the PDFs): only the picture the
 *            code's page names (any other id is the same 404 as an unknown code, and raises the network's suspicion); the
 *            stripped copy, made now as the tenant's system when the worker has not made it yet; a picture that cannot be
 *            stripped is not shown (404). Kept in this process (a stored object never changes).
 *
 * Reads only, apart from the stripped copy a first look may make (the files platform's own command).
 */

/** The page's picture of a code's match: its style's main picture that can be stripped, or null. */
export async function readPublicPicture(client: FactoryClient, match: CodeMatch): Promise<NonNullable<PublicDocPage['picture']> | null> {
  const styleId = match.kind === 'STYLE' ? match.id : ((await client.workOrder.findUnique({ where: { id: match.id }, select: { styleId: true } }))?.styleId ?? null)
  if (styleId === null) return null
  const main = (await mainPictures(client, [styleId])).get(styleId)
  if (!main || !isStrippable(main.contentType)) return null
  return { fileId: main.fileId, contentType: main.contentType, caption: main.caption }
}

const CACHE_BYTES = 32 * 1024 * 1024
const cache = new Map<string, { bytes: Buffer; contentType: string }>()
let cachedBytes = 0

function remember(key: string, entry: { bytes: Buffer; contentType: string }) {
  const before = cache.get(key)
  if (before) {
    cache.delete(key)
    cachedBytes -= before.bytes.length
  }
  if (entry.bytes.length > CACHE_BYTES / 4) return entry
  cache.set(key, entry)
  cachedBytes += entry.bytes.length
  while (cachedBytes > CACHE_BYTES) {
    const [oldest, value] = cache.entries().next().value as [string, { bytes: Buffer }]
    cache.delete(oldest)
    cachedBytes -= value.bytes.length
  }
  return entry
}

/** Forget every kept picture (tests). */
export function forgetPublicDocPictures(): void {
  cache.clear()
  cachedBytes = 0
}

const NOT_FOUND = 'We could not find this code. Check it on the label.'

/**
 * GET /public/doc/:code/picture/:fileId (anyone): the stripped copy of the picture the code's page names. `pages` is the
 * lookup's own reading of every page under the code (public-doc.ts pagesUnder), so the picture follows exactly what the page
 * shows.
 */
export async function publicDocPicture(
  app: FastifyInstance,
  request: FastifyRequest,
  codeParam: string,
  fileId: string,
  pages: (request: FastifyRequest, code: string) => Promise<{ readonly match: CodeMatch; readonly page: PublicDocPage }[]>,
): Promise<{ bytes: Buffer; contentType: string }> {
  const guard = abuseGuardOf(app)
  const code = readPublicDocCode(codeParam)
  const owner = code && isUuid(fileId) ? (await pages(request, code)).find((entry) => entry.page.picture?.fileId === fileId) : undefined
  if (!owner) {
    await guard.failed(request, 'public.lookup')
    throw new NotFoundError(NOT_FOUND)
  }
  const system = systemCallerOf(request)(owner.match.tenantId)
  const row = await system.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, status: true, contentType: true, storeAccountId: true, thumbnailKey: true } }))
  if (!row || row.status !== 'AVAILABLE' || !isStrippable(row.contentType)) throw new NotFoundError(NOT_FOUND)
  const notReady = () => new DomainError('not_ready', 'The picture is being prepared. Try again in a moment.')
  const made = row.thumbnailKey ? { outcome: 'exists' as const, key: row.thumbnailKey } : await makeStrippedCopy(processFiles(), system, fileId)
  // The store did not answer (paused, rate-limited): try again later (503); never the office's file instead.
  if (!made.key && made.outcome === 'store_unavailable') throw notReady()
  // A picture that cannot be stripped is not shown at all.
  if (!made.key) throw new NotFoundError(NOT_FOUND)
  const key = made.key
  const kept = cache.get(`${owner.match.tenantId}:${key}`)
  if (kept) return remember(`${owner.match.tenantId}:${key}`, kept)
  let bytes: Buffer | null
  try {
    bytes = await processFiles().storage.read(system, row.storeAccountId, key, KIND_RULES.PHOTO.maxBytes)
  } catch (error) {
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) throw notReady()
    throw error
  }
  if (!bytes) throw notReady()
  return remember(`${owner.match.tenantId}:${key}`, { bytes, contentType: row.contentType })
}

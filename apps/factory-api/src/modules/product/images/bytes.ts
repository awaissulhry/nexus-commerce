import type { FastifyRequest } from 'fastify'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { actorOf } from '../../../core/context'
import { KIND_RULES } from '../../../platform/files/rules'
import { GatewayCallFailed, GatewayRefusal } from '../../../platform/gateway/gateway'
import { processFiles } from '../../../platform/files/service'
import { contextOf, filesCaller } from './store'

/**
 * A picture's bytes (B-W2b-236): `GET /product/pictures/:fileId` (office, product.styles.view over the style's company) —
 * only the file of a style's picture (a StyleImage names it) of a style the caller may see, AVAILABLE, a JPEG, PNG or WebP.
 * The section, the gallery and the lightbox draw it with a plain <img> (the session cookie goes along; no company header is
 * needed for a read). Read once from the store (one gateway `files.read` as the tenant's system holding files.read over the
 * style's company), then kept in this process and in the browser: a stored file never changes (a new picture is a new
 * file), so a gallery of sixty styles costs the store nothing after the first look — where a presigned address per
 * picture and per read would spend the store account's rate limit.
 */

const CACHE_BYTES = 64 * 1024 * 1024
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
export function forgetPictureBytes(): void {
  cache.clear()
  cachedBytes = 0
}

export async function pictureBytes(request: FastifyRequest, fileId: string): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const context = contextOf(request)
  const found = isUuid(fileId)
    ? await request.withClient(async (client) => {
        const picture = await client.styleImage.findFirst({ where: { fileId }, select: { styleId: true } })
        if (!picture) return null
        const style = await client.style.findUnique({ where: { id: picture.styleId }, select: { companyId: true } })
        const file = await client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, status: true, contentType: true, originalName: true, storeAccountId: true, storageKey: true, sizeBytes: true } })
        return style && file ? { companyId: style.companyId, file } : null
      })
    : null
  if (!found || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: found.companyId }) || found.file.status !== 'AVAILABLE' || !isPictureType(found.file.contentType)) {
    throw new NotFoundError('Picture not found.')
  }
  return storedPictureBytes(request, found)
}

/** A stored picture the caller was found to see, AVAILABLE and a picture type: from this process's cache, else read once from the store. */
export interface StoredPicture {
  readonly companyId: string | null
  readonly file: { readonly id: string; readonly contentType: string; readonly originalName: string; readonly storeAccountId: string; readonly storageKey: string; readonly sizeBytes: number }
}

/**
 * The bytes of a picture the caller's module has checked (B-W2b-247: a library colour's photo and a branding set's logo or
 * artwork reuse it): kept in this process; read through the gateway as the tenant's system holding files.read over the
 * file's company. A store refusal is a 503 in words, never a 500.
 */
export async function storedPictureBytes(request: FastifyRequest, found: StoredPicture): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const context = contextOf(request)
  const fileId = found.file.id
  const key = `${'tenantId' in context ? context.tenantId : ''}:${fileId}`
  const kept = cache.get(key)
  if (kept) return { ...remember(key, kept), name: found.file.originalName }
  let bytes: Buffer | null
  try {
    bytes = await processFiles().storage.read(filesCaller(request, found.companyId, [FILES_READ]), found.file.storeAccountId, found.file.storageKey, Math.max(found.file.sizeBytes, KIND_RULES.PHOTO.maxBytes))
  } catch (error) {
    // The store's account paused, rate-limited or not answering: a refusal in words (503), never a 500.
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) throw new DomainError('not_ready', 'The file store does not answer now. Try again in a moment.')
    throw error
  }
  if (!bytes) throw new DomainError('not_ready', 'The picture is not in the file store now. Try again in a moment.')
  return { ...remember(key, { bytes, contentType: found.file.contentType }), name: found.file.originalName }
}

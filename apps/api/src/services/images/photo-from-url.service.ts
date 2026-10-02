/**
 * MCP full control L11 (decision d6) — a photo added to a product's photos from a web link, and an unused one removed.
 *
 * The link is fetched by the ONE public-address fetch (`net/safe-fetch.ts`): https only (every redirect hop too), public
 * addresses only, bounded time and bytes. Only a photo is accepted: the declared type AND the file's own first bytes must
 * be JPEG, PNG, WebP or GIF, at most 15 MB. A photo already there (the same bytes, or a near duplicate by the upload
 * gate's own two hashes) is not added again. Cloudinary stores it.
 *
 * Where it goes is where an upload goes (`uploadDedupScope`): a family on the media plan has ONE library, the family
 * root's row (placed nowhere until the photo plan places it); any other product has its own gallery. Nothing reaches a
 * channel: a publish sends photos.
 */
import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { safeFetch, SafeFetchError } from '../net/safe-fetch.js'
import { deleteFromCloudinary, isCloudinaryConfigured, uploadBufferToCloudinary } from '../cloudinary.service.js'
import { DHASH256_NEAR_DUP_THRESHOLD, NEAR_DUP_HAMMING_THRESHOLD, aHashBuffer, dHash256Buffer, hammingHex } from './image-hash.service.js'
import { uploadDedupScope } from './media-plan-switch.js'
import { publishListingEvent } from '../listing-events.service.js'
import { productEventService } from '../product-event.service.js'

export const PHOTO_URL_MAX_BYTES = 15 * 1024 * 1024
const TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
}

/** A link or photo refused, said to a person; `statusCode` as an HTTP answer would be (400, 409, 413, 502, 503). */
export class PhotoUrlError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = 'PhotoUrlError' }
}

export interface FetchedPhoto { buffer: Buffer; mimeType: string; bytes: number; contentHash: string; host: string; url: string }

/** Fetch a photo from a link, as the rules above say. Reads the web; writes nothing. */
export async function fetchPhoto(link: string): Promise<FetchedPhoto> {
  let url: URL
  try { url = new URL(link.trim()) } catch { throw new PhotoUrlError('That is not a web address.', 400) }
  if (url.protocol !== 'https:') throw new PhotoUrlError('Only an https:// link is fetched.', 400)
  let fetched: Awaited<ReturnType<typeof safeFetch>>
  try {
    fetched = await safeFetch(url.toString(), { maxBytes: PHOTO_URL_MAX_BYTES, timeoutMs: 15_000, maxRedirects: 3, httpsOnly: true })
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.reason === 'refused') throw new PhotoUrlError(`${error.message}.`, 400)
      if (error.reason === 'too_large') throw new PhotoUrlError(`The photo is larger than ${PHOTO_URL_MAX_BYTES / 1024 / 1024} MB.`, 413)
      throw new PhotoUrlError(`The link answered HTTP ${error.status ?? '?'}.`, 502)
    }
    throw new PhotoUrlError(`The link could not be read: ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  const mimeType = fetched.contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  const looksLike = TYPES[mimeType]
  if (!looksLike) throw new PhotoUrlError(`The link is not a photo (${mimeType || 'no type'}): JPEG, PNG, WebP or GIF only.`, 400)
  if (!looksLike(fetched.buffer)) throw new PhotoUrlError(`The file says ${mimeType} but is not one.`, 400)
  return { buffer: fetched.buffer, mimeType, bytes: fetched.buffer.byteLength, contentHash: createHash('sha256').update(fetched.buffer).digest('hex'),
    host: fetched.url.hostname, url: fetched.url.toString() }
}

export interface PhotoHome {
  /** The product whose photos receive it: the family root on the media plan, else the product itself. */
  ownerId: string
  sku: string
  rootId: string
  onPlan: boolean
  /** The products a duplicate is looked for in (the family's one library, or the product alone). */
  scope: string[]
}

/** Where a photo of this product goes, or null when the product is not here (deleted, another business). */
export async function photoHome(productId: string): Promise<PhotoHome | null> {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, sku: true, parentId: true } })
  if (!product) return null
  const rootId = product.parentId ?? product.id
  const onPlan = (await prisma.productMediaPlan.count({ where: { productId: rootId, layer: 'SHARED' } })) > 0
  const ownerId = onPlan ? rootId : product.id
  const sku = ownerId === product.id ? product.sku : (await prisma.product.findFirst({ where: { id: ownerId }, select: { sku: true } }))?.sku ?? product.sku
  return { ownerId, sku, rootId, onPlan, scope: await uploadDedupScope(product.id) }
}

const hashes = async (buffer: Buffer) => {
  try { return { a: await aHashBuffer(buffer), d: await dHash256Buffer(buffer) } } catch { return { a: null, d: null } }
}

/** The photo this one already is (the same bytes, or a near duplicate by the upload gate's two hashes), if any. */
export async function duplicateOf(home: PhotoHome, photo: FetchedPhoto): Promise<{ id: string; kind: 'exact' | 'near' } | null> {
  const exact = await prisma.productImage.findFirst({ where: { productId: { in: home.scope }, contentHash: photo.contentHash }, select: { id: true } })
  if (exact) return { id: exact.id, kind: 'exact' }
  const { a, d } = await hashes(photo.buffer)
  if (!a || !d) return null
  const candidates = await prisma.productImage.findMany({ where: { productId: { in: home.scope }, perceptualHash: { not: null }, dhash256: { not: null } },
    select: { id: true, perceptualHash: true, dhash256: true } })
  const near = candidates.find((c) => hammingHex(c.perceptualHash!, a) <= NEAR_DUP_HAMMING_THRESHOLD && hammingHex(c.dhash256!, d) <= DHASH256_NEAR_DUP_THRESHOLD)
  return near ? { id: near.id, kind: 'near' } : null
}

function changed(home: PhotoHome, imageId: string, source: string) {
  publishListingEvent({ type: 'product.media.changed', productId: home.rootId, layer: 'LIBRARY', ts: Date.now() })
  void productEventService.emit({ aggregateId: home.ownerId, aggregateType: 'Product', eventType: 'IMAGES_UPDATED', data: { source, imageId } })
}

/** Store the photo in Cloudinary and append it to the home's photos. */
export async function addPhoto(home: PhotoHome, photo: FetchedPhoto, label: string | null) {
  if (!isCloudinaryConfigured()) throw new PhotoUrlError('Photo storage (Cloudinary) is not configured.', 503)
  const { a, d } = await hashes(photo.buffer)
  const stored = await uploadBufferToCloudinary(photo.buffer, { folder: `product-images/${home.ownerId}` })
  try {
    const last = await prisma.productImage.aggregate({ where: { productId: home.ownerId }, _max: { sortOrder: true } })
    const image = await prisma.productImage.create({
      data: { productId: home.ownerId, url: stored.url, publicId: stored.publicId, type: 'ALT', alt: label, sortOrder: (last._max.sortOrder ?? -1) + 1,
        width: stored.width, height: stored.height, fileSize: stored.bytes, mimeType: photo.mimeType, contentHash: photo.contentHash, perceptualHash: a, dhash256: d },
      select: { id: true, url: true, width: true, height: true },
    })
    changed(home, image.id, 'claude-link')
    return image
  } catch (error) {
    // The row was not written (most often: the same photo was added at the same moment) — do not keep the stored file.
    void deleteFromCloudinary(stored.publicId, 'image').catch(() => undefined)
    if ((error as { code?: unknown })?.code === 'P2002') throw new PhotoUrlError('This photo was just added. Nothing else changed.', 409)
    throw error
  }
}

/** Why a photo cannot be removed (something uses it), or null. */
export async function photoInUse(home: PhotoHome, imageId: string): Promise<string | null> {
  const image = await prisma.productImage.findFirst({ where: { id: imageId, productId: { in: home.scope } },
    select: { url: true, isPrimary: true, versionGroupId: true } })
  if (!image) return 'it is not one of this product\'s photos'
  if (image.isPrimary) return 'it is the product\'s main photo'
  if (image.versionGroupId) return 'it is a language version of another photo'
  const layers = await prisma.productMediaPlan.findMany({ where: { productId: home.rootId }, select: { layer: true, channel: true, plan: true } })
  const placed = layers.find((l) => JSON.stringify(l.plan).includes(`"assetId":"${imageId}"`))
  if (placed) return `the photo plan places it (${placed.layer.toLowerCase()}${placed.channel ? ` ${placed.channel}` : ''}); take it out with arrange-photos first`
  if (await prisma.productImage.count({ where: { sameAsImageId: imageId } })) return 'other photos are marked as the same picture as it'
  if (await prisma.listingImage.count({ where: { url: image.url } })) return 'a listing\'s own photos use it'
  return null
}

/**
 * Remove an unused photo: the row only. The stored file stays, so the way back (add-photo-from-url from its stored
 * address) has the same bytes.
 */
export async function removePhoto(home: PhotoHome, imageId: string) {
  const gone = await prisma.productImage.deleteMany({ where: { id: imageId, productId: { in: home.scope } } })
  if (gone.count) changed(home, imageId, 'claude-remove')
  return gone.count === 1
}

import type { Prisma } from '@prisma/client'
import { mediaObject, readMediaCollection, resolveMediaCollection, writeMediaCollection } from '@nexus/shared/product-media'
import { legacyImageUrls, legacyPhotoItems, type LibraryPhoto } from './listing-photos.pure.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { isOnMediaPlan } from './media-plan-switch.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import { publishListingEvent } from '../listing-events.service.js'
import { logger } from '../../utils/logger.js'

/**
 * Product media is the one photo source of an eBay listing (Owner 2026-10-05). An eBay listing can still hold an old
 * "Image URLs" list (`platformAttributes.imageUrls`) — written by the file import, the sheet's Image URLs column and
 * Claude. The rule is "one list at a time, the last save wins":
 * - a write of Image URLs removes the listing's Product media (the field's `replaces`); when every address is a photo of
 *   the media library (the same address, or the same Cloudinary photo), `settleListingPhotos` makes them the listing's
 *   Product media in that order. A list with any other address stays the old list: nothing is added to a library by a
 *   write the person did not make in Product media (review 2026-10-05: an automatic library write changed other
 *   channels' default photos, broke later records of one import and could reach a shared business);
 * - a save in Product media removes the old list and adds its other addresses to that row's library
 *   (product-media.service.ts, `addLibraryPhotos`);
 * - until one of the two happens, the sheet, the editor and Publish all read the old list (`legacyPhotoItems`).
 */
type Tx = Prisma.TransactionClient

export * from './listing-photos.pure.js'

const fileSelect = { id: true, productId: true, url: true, publicId: true, mediaType: true, contentHash: true, sortOrder: true } as const
const productSelect = { id: true, parentId: true, version: true, localizedContent: true } as const

/**
 * Adds photos to a row's media library by address, for a save the person made in Product media — on the row's own
 * product, the rule `copyProductMedia` follows. One row per photo: a photo the business already holds at the same address
 * lends its size and hash, and the same bytes already in this row's library are used instead of a second row. Before the
 * row's library grows, its current list is pinned as its all-languages list (the parent's language lists too, when it
 * follows the parent), so no other channel's photos change. Returns the rows by address.
 */
export async function addLibraryPhotos(tx: Tx, input: { productId: string; urls: string[] }): Promise<Map<string, LibraryPhoto>> {
  const added = new Map<string, LibraryPhoto>()
  if (!input.urls.length) return added
  const product = await tx.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: productSelect })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const parent = product.parentId ? await tx.product.findFirst({ where: { id: product.parentId, deletedAt: null }, select: productSelect }) : null
  const files = await tx.productImage.findMany({ where: { productId: { in: [product.id, ...(parent ? [parent.id] : [])] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: fileSelect })
  const ownIds = files.filter(file => file.productId === product.id).map(file => file.id)
  const parentIds = files.filter(file => file.productId === parent?.id).map(file => file.id)
  let content = mediaObject(product.localizedContent)
  if (!readMediaCollection(content, 'und') && (ownIds.length || parentIds.length)) {
    if (!ownIds.length && parent) for (const locale of Object.keys(mediaObject(parent.localizedContent))) {
      const inherited = readMediaCollection(parent.localizedContent, locale)
      if (inherited && !readMediaCollection(content, locale)) content = writeMediaCollection(content, locale, inherited)
    }
    if (!readMediaCollection(content, 'und')) content = writeMediaCollection(content, 'und', resolveMediaCollection({ locale: 'und', own: product.localizedContent, parent: parent?.localizedContent, ownIds, parentIds }).collection)
    const pinned = await tx.product.updateMany({ where: { id: product.id, version: product.version, deletedAt: null }, data: { localizedContent: content as Prisma.InputJsonValue, version: { increment: 1 } } })
    if (pinned.count !== 1) throw new WorkspaceScopeError('The product changed while its photos were saved. Try again.')
  }
  let sortOrder = Math.max(-1, ...files.filter(file => file.productId === product.id).map(file => file.sortOrder))
  for (const url of input.urls) {
    const lend = await tx.productImage.findFirst({ where: { mediaType: 'IMAGE', url }, orderBy: { createdAt: 'asc' },
      select: { alt: true, publicId: true, width: true, height: true, mimeType: true, fileSize: true, contentHash: true, perceptualHash: true, dhash256: true, sourceAssetId: true } })
    const sameBytes = lend?.contentHash ? files.find(file => file.productId === product.id && file.contentHash === lend.contentHash) : undefined
    if (sameBytes) { added.set(url, sameBytes); continue }
    const created = await tx.productImage.create({ select: fileSelect, data: {
      productId: product.id, url, type: 'ALT', isPrimary: false, sortOrder: ++sortOrder, mediaType: 'IMAGE',
      ...(lend ? { alt: lend.alt, publicId: lend.publicId, width: lend.width, height: lend.height, mimeType: lend.mimeType, fileSize: lend.fileSize,
        contentHash: lend.contentHash, perceptualHash: lend.perceptualHash, dhash256: lend.dhash256, sourceAssetId: lend.sourceAssetId } : {}),
    } })
    files.push(created)
    added.set(url, created)
  }
  return added
}

/** `outside`: the addresses that kept the old list (not photos of the media library); `plan`: the family is on the photo plan. */
export interface SettledPhotos { settled: boolean; outside: number; plan?: boolean; rootId: string | null }

/**
 * Makes an eBay listing's old Image URLs list its Product media, in the same order (Owner 2026-10-05), when every address
 * is a photo of the media library (`legacyPhotoItems`). Writes the listing only — never a product or a library. Nothing
 * to do when the listing has no old list; a list with another address stays as it is (the sheet says so), and a family
 * on the photo plan keeps its plan (Publish reads the plan there).
 */
export async function settleListingPhotos(tx: Tx, listingId: string): Promise<SettledPhotos> {
  const none: SettledPhotos = { settled: false, outside: 0, rootId: null }
  const listing = await tx.channelListing.findFirst({ where: { id: listingId }, select: { id: true, version: true, channel: true, productId: true, platformAttributes: true } })
  if (!listing || listing.channel !== 'EBAY') return none
  const urls = legacyImageUrls(listing.platformAttributes)
  if (!urls) return none
  const product = await tx.product.findFirst({ where: { id: listing.productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) return none
  const rootId = product.parentId ?? product.id
  if (await isOnMediaPlan(rootId)) return { ...none, plan: true }
  const files = await tx.productImage.findMany({ where: { productId: { in: [product.id, ...(product.parentId ? [product.parentId] : [])] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: fileSelect })
  const { items, outside } = legacyPhotoItems(urls, files, product.id)
  if (outside.length) return { ...none, outside: outside.length }
  const { imageUrls: _old, ...rest } = mediaObject(listing.platformAttributes)
  const written = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { version: { increment: 1 },
    platformAttributes: { ...rest, _productMediaLocales: writeMediaCollection({}, 'und', { version: 1, items }) } as Prisma.InputJsonValue } })
  if (written.count !== 1) throw new WorkspaceScopeError('This listing changed while its photos were saved. Try again.')
  return { settled: true, outside: 0, rootId }
}

/** `settleListingPhotos` for many listings (an import, a bulk edit); listings without an old list are skipped. */
export async function settleListingsPhotos(tx: Tx, listingIds: Iterable<string>) {
  const results: SettledPhotos[] = []
  for (const id of new Set(listingIds)) results.push(await settleListingPhotos(tx, id))
  return { settled: results.filter(result => result.settled).length, kept: results.filter(result => result.outside > 0).length,
    rootIds: [...new Set(results.flatMap(result => result.rootId ? [result.rootId] : []))] }
}

/**
 * `settleListingsPhotos` in the writer's transaction, then — after the commit — the same live event a Product media save
 * sends, so every open sheet of the family reads its cells again. An event that cannot be sent never fails the write.
 */
export async function settleAndAnnounce(tx: Tx, listingIds: Iterable<string>) {
  const result = await settleListingsPhotos(tx, listingIds)
  for (const rootId of result.rootIds) await afterDatabaseCommit(`product-media-settled:${rootId}`, async () => {
    try { publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'GALLERY', ts: Date.now() }) }
    catch (error) { logger.warn('[listing-photos] photos saved, but the live update could not be sent', { productId: rootId, reason: error instanceof Error ? error.message : String(error) }) }
  })
  return result
}

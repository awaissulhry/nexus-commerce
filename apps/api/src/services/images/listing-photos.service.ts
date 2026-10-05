import type { Prisma } from '@prisma/client'
import { mediaObject, readMediaCollection, resolveMediaCollection, writeMediaCollection, type ProductMediaCollection } from '@nexus/shared/product-media'
import { cloudinaryPhotoKey, legacyImageUrls, legacyPhotoItems, type LibraryPhoto } from './listing-photos.pure.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

/**
 * Product media is the one photo source of an eBay listing (Owner 2026-10-05). An eBay listing can still hold an old
 * "Image URLs" list (`platformAttributes.imageUrls`) — written by the file import, the sheet's Image URLs column and
 * Claude. The rule is "one list at a time, the last save wins":
 * - a write of Image URLs removes the listing's Product media (the field's `replaces`), then `settleListingPhotos` moves
 *   the addresses into Product media: a photo of the media library is used from the library (same address, or the same
 *   Cloudinary photo at another size), any other address is added to the library;
 * - a save in Product media removes the old list (product-media.service.ts);
 * - until one of the two happens, the sheet, the editor and Publish all read the old list (`legacyPhotoItems`).
 */
type Tx = Prisma.TransactionClient

export * from './listing-photos.pure.js'

const fileSelect = { id: true, productId: true, url: true, publicId: true, mediaType: true, contentHash: true, sortOrder: true } as const
const productSelect = { id: true, parentId: true, version: true, localizedContent: true } as const

/**
 * Adds photos to a product's library by address (one row each; existing business photos lend their size and hash).
 * Before the library grows, the product's current fallback list is pinned as its all-languages list, so no other
 * channel's photos change (the same rule as `copyProductMedia`). Returns the new rows by address.
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
  if (!readMediaCollection(content, 'und')) {
    if (!ownIds.length && parent) {
      for (const locale of Object.keys(mediaObject(parent.localizedContent))) {
        const inherited = readMediaCollection(parent.localizedContent, locale)
        if (inherited && !readMediaCollection(content, locale)) content = writeMediaCollection(content, locale, inherited)
      }
    }
    if (!readMediaCollection(content, 'und')) content = writeMediaCollection(content, 'und', resolveMediaCollection({ locale: 'und', own: product.localizedContent, parent: parent?.localizedContent, ownIds, parentIds }).collection)
    const pinned = await tx.product.updateMany({ where: { id: product.id, version: product.version, deletedAt: null }, data: { localizedContent: content as Prisma.InputJsonValue, version: { increment: 1 } } })
    if (pinned.count !== 1) throw new WorkspaceScopeError('The product changed while its photos were saved. Try again.')
  }
  let sortOrder = Math.max(-1, ...files.filter(file => file.productId === product.id).map(file => file.sortOrder))
  for (const url of input.urls) {
    // A photo the business already holds (another product's library) lends its size, hash and Cloudinary id.
    const key = cloudinaryPhotoKey(url)
    const known = await tx.productImage.findFirst({ where: { mediaType: 'IMAGE', OR: [{ url }, ...(key ? [{ url: { contains: key.slice(key.indexOf('/') + 1) } }] : [])] },
      orderBy: { createdAt: 'asc' }, select: { alt: true, publicId: true, width: true, height: true, mimeType: true, fileSize: true, contentHash: true, perceptualHash: true, dhash256: true, sourceAssetId: true, url: true } })
    const lend = known && (known.url === url || cloudinaryPhotoKey(known.url) === key) ? known : null
    // The same bytes may be in this product's library under another address: one row per photo and product.
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

export interface SettledPhotos { settled: boolean; fromLibrary: number; added: number; rootId: string | null }

/**
 * Moves an eBay listing's old Image URLs list into its Product media, in the same order (Owner 2026-10-05). Nothing to
 * do when the listing has no old list. The photos eBay receives do not change: a library photo is the same address,
 * or the same Cloudinary photo; any other address is added to the library as it is.
 */
export async function settleListingPhotos(tx: Tx, listingId: string): Promise<SettledPhotos> {
  const none: SettledPhotos = { settled: false, fromLibrary: 0, added: 0, rootId: null }
  const listing = await tx.channelListing.findFirst({ where: { id: listingId }, select: { id: true, version: true, channel: true, productId: true, platformAttributes: true } })
  if (!listing || listing.channel !== 'EBAY') return none
  const urls = legacyImageUrls(listing.platformAttributes)
  if (!urls) return none
  const product = await tx.product.findFirst({ where: { id: listing.productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) return none
  const files = await tx.productImage.findMany({ where: { productId: { in: [product.id, ...(product.parentId ? [product.parentId] : [])] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: fileSelect })
  const { items, outside } = legacyPhotoItems(urls, files, product.id)
  const added = await addLibraryPhotos(tx, { productId: product.id, urls: outside.map(photo => photo.url) })
  const collection: ProductMediaCollection = { version: 1, items: [] }
  for (const item of items) {
    const url = outside.find(photo => photo.id === item.assetId)?.url
    const assetId = url ? added.get(url)!.id : item.assetId
    if (!collection.items.some(existing => existing.assetId === assetId)) collection.items.push({ assetId })
  }
  const { imageUrls: _old, ...rest } = mediaObject(listing.platformAttributes)
  const written = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { version: { increment: 1 },
    platformAttributes: { ...rest, _productMediaLocales: writeMediaCollection({}, 'und', collection) } as Prisma.InputJsonValue } })
  if (written.count !== 1) throw new WorkspaceScopeError('This listing changed while its photos were saved. Try again.')
  return { settled: true, fromLibrary: items.length - outside.length, added: outside.length, rootId: product.parentId ?? product.id }
}

/** `settleListingPhotos` for many listings (an import, a bulk edit); listings without an old list are skipped. */
export async function settleListingsPhotos(tx: Tx, listingIds: Iterable<string>) {
  const results: SettledPhotos[] = []
  for (const id of new Set(listingIds)) results.push(await settleListingPhotos(tx, id))
  return { settled: results.filter(result => result.settled).length, added: results.reduce((sum, result) => sum + result.added, 0),
    rootIds: [...new Set(results.flatMap(result => result.rootId ? [result.rootId] : []))] }
}

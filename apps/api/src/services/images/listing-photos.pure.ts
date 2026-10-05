import { createHash } from 'node:crypto'
import { mediaObject, resolveMediaCollection, type ProductMediaCollection } from '@nexus/shared/product-media'

/**
 * Pure rules of an eBay listing's photo list (Owner 2026-10-05: Product media is the one photo source). The writes are
 * in listing-photos.service.ts; this file holds no database access, so the sheet, the editor and Publish share it.
 */

/** A photo of an old Image URLs list that is not in the library: the editor shows it by this id until a save adds it. */
export const LEGACY_PHOTO_PREFIX = 'url:'
export const legacyPhotoId = (url: string) => `${LEGACY_PHOTO_PREFIX}${createHash('sha256').update(url).digest('hex').slice(0, 40)}`
export const isLegacyPhotoId = (id: string) => id.startsWith(LEGACY_PHOTO_PREFIX)

/**
 * The Cloudinary photo an address shows, the same rendering only: `https://res.cloudinary.com/<cloud>/image/upload/
 * [v<version>/]<path>.<format>` → `<cloud>/<path>`. The version marker only refreshes caches, so two addresses that differ
 * only by it (or by the file ending) show the same photo. Any transformation step (`w_800,c_fill/…`) is a different
 * rendering and stays part of the key: matching it to the plain photo would change what eBay shows (review 2026-10-05).
 * Null for any other address.
 */
export function cloudinaryPhotoKey(url: string): string | null {
  const match = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/([^?#]+)/i.exec(url.trim())
  if (!match) return null
  const parts = match[2].split('/').filter(Boolean)
  const rest = /^v\d+$/.test(parts[0] ?? '') ? parts.slice(1) : parts
  if (!rest.length) return null
  const last = rest[rest.length - 1].replace(/\.[a-z0-9]{2,5}$/i, '')
  return `${match[1]}/${[...rest.slice(0, -1), last].join('/')}`
}

export interface LibraryPhoto { id: string; productId: string; url: string; publicId?: string | null; mediaType?: string | null; contentHash?: string | null }

/** The library photo an address names: the same address first, else the same Cloudinary photo (`cloudinaryPhotoKey`); the row's own files first. */
export function matchLibraryPhoto<T extends LibraryPhoto>(url: string, files: T[], ownProductId?: string): T | undefined {
  const images = files.filter(file => (file.mediaType ?? 'IMAGE') === 'IMAGE')
  const ordered = ownProductId ? [...images.filter(file => file.productId === ownProductId), ...images.filter(file => file.productId !== ownProductId)] : images
  const exact = ordered.find(file => file.url === url.trim())
  if (exact) return exact
  const key = cloudinaryPhotoKey(url)
  return key ? ordered.find(file => cloudinaryPhotoKey(file.url) === key) : undefined
}

/** Clean addresses, in order, each once. */
export function photoAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    const url = typeof item === 'string' ? item.trim() : ''
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [url]
  })
}

/**
 * An eBay listing's old Image URLs list, while it is still the list Publish sends (no Product media saved on the
 * listing). Undefined when Product media decides.
 */
export function legacyImageUrls(listingAttributes: unknown): string[] | undefined {
  const pa = mediaObject(listingAttributes)
  if (pa._productMediaLocales !== undefined || !Array.isArray(pa.imageUrls)) return undefined
  return photoAddresses(pa.imageUrls)
}

/**
 * The old list as Product media items: a library photo by its id, any other address by `legacyPhotoId` (listed in
 * `outside`). Two addresses of one library photo appear once.
 */
export function legacyPhotoItems<T extends LibraryPhoto>(urls: string[], files: T[], ownProductId?: string) {
  const items: ProductMediaCollection['items'] = []
  const outside: Array<{ id: string; url: string }> = []
  for (const url of urls) {
    const file = matchLibraryPhoto(url, files, ownProductId)
    const id = file?.id ?? legacyPhotoId(url)
    if (items.some(item => item.assetId === id)) continue
    items.push({ assetId: id })
    if (!file) outside.push({ id, url })
  }
  return { items, outside }
}


/** A file of the media library as a photo list reads it. */
export interface PhotoFile { id: string; productId: string; url: string; mediaType?: string | null }
export interface EbayListingPhotosInput {
  listingAttributes: unknown; locale: string; product: { id: string; localizedContent?: unknown }
  parent?: { id: string; localizedContent?: unknown } | null; files: readonly PhotoFile[]
}
/**
 * Owner 2026-10-05 — Product media is the one photo source: the photos Publish sends for one eBay listing row, off the
 * photo plan — its old Image URLs list while that is still the list sent (`legacyImageUrls`), else its Product media
 * resolved the way Publish resolves it (`studio-publication-media.ts` publicationImages: the listing's own list, the
 * Shared product's, the parent's, the library, by sortOrder then id). Photos only: eBay takes no videos, and a missing
 * file is left out (Publish names it). `own`: the listing holds the list itself (old list, or Product media saved on it
 * for this language or all languages); else it follows the Shared product's. Undefined when the saved list cannot be read.
 * The export writes this list (catalog-transfer-export.ts) and the import compares a file's Image URLs with it.
 */
export function ebayListingPhotos(input: EbayListingPhotosInput): { urls: string[]; own: boolean } | undefined {
  const legacy = legacyImageUrls(input.listingAttributes)
  if (legacy) return { urls: legacy, own: true }
  const parent = input.parent && input.parent.id !== input.product.id ? input.parent : null
  try {
    const { collection, source } = resolveMediaCollection({ locale: input.locale, own: mediaObject(input.listingAttributes)._productMediaLocales,
      shared: input.product.localizedContent, parent: parent?.localizedContent,
      ownIds: input.files.filter(f => f.productId === input.product.id).map(f => f.id), parentIds: parent ? input.files.filter(f => f.productId === parent.id).map(f => f.id) : [] })
    const urls = collection.items.flatMap(item => {
      const file = input.files.find(f => f.id === item.assetId && (f.productId === input.product.id || f.productId === parent?.id))
      return file && (file.mediaType ?? 'IMAGE') === 'IMAGE' ? [file.url] : []
    })
    return { urls, own: source === 'locale' || source === 'all-languages' }
  } catch { return undefined }
}
/** The addresses of `ebayListingPhotos`; undefined when the saved list cannot be read (the export keeps the stored value). */
export const ebayListingPhotoUrls = (input: EbayListingPhotosInput): string[] | undefined => ebayListingPhotos(input)?.urls

/**
 * Owner 2026-10-05 — a file's Image URLs restate the list Publish sends: a list of addresses that are, cleaned and each
 * once (`photoAddresses`), exactly that list in that order. Exact addresses: the same Cloudinary photo at another size is
 * another address here (an import then settles it onto the same library photo). An empty list restates nothing.
 */
export function restatesPhotoList(value: unknown, sent: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return false
  const file = photoAddresses(value), current = photoAddresses(sent)
  return current.length > 0 && file.length === current.length && file.every((url, i) => url === current[i])
}

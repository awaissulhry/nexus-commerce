import { createHash } from 'node:crypto'
import { mediaObject, type ProductMediaCollection } from '@nexus/shared/product-media'

/**
 * Pure rules of an eBay listing's photo list (Owner 2026-10-05: Product media is the one photo source). The writes are
 * in listing-photos.service.ts; this file holds no database access, so the sheet, the editor and Publish share it.
 */

/** A photo of an old Image URLs list that is not in the library yet: the editor shows it by this id until a save adds it. */
export const LEGACY_PHOTO_PREFIX = 'url:'
export const legacyPhotoId = (url: string) => `${LEGACY_PHOTO_PREFIX}${createHash('sha256').update(url).digest('hex').slice(0, 40)}`
export const isLegacyPhotoId = (id: string) => id.startsWith(LEGACY_PHOTO_PREFIX)

const TRANSFORMATION = /^(?:[a-z]{1,3}_[^/]*(?:,[a-z]{1,3}_[^/]*)*)$/
/**
 * The Cloudinary photo an address shows, whatever size or format it asks for:
 * `https://res.cloudinary.com/<cloud>/image/upload/[<transformations>/][v<version>/]<public id>.<format>` → `<cloud>/<public id>`.
 * Null for any other address.
 */
export function cloudinaryPhotoKey(url: string): string | null {
  const match = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/([^?#]+)/i.exec(url.trim())
  if (!match) return null
  const parts = match[2].split('/').filter(Boolean)
  const version = parts.findIndex(part => /^v\d+$/.test(part))
  let rest = version >= 0 ? parts.slice(version + 1) : parts
  // Without a version, leading transformation steps (`w_800,c_fill`, `f_auto`) are not part of the public id.
  if (version < 0) while (rest.length > 1 && TRANSFORMATION.test(rest[0])) rest = rest.slice(1)
  if (!rest.length) return null
  const last = rest[rest.length - 1].replace(/\.[a-z0-9]{2,5}$/i, '')
  return `${match[1]}/${[...rest.slice(0, -1), last].join('/')}`
}

export interface LibraryPhoto { id: string; productId: string; url: string; publicId?: string | null; mediaType?: string | null; contentHash?: string | null }

/** The library photo an address names: the same address first, else the same Cloudinary photo; the row's own files first. */
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


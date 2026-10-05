import { mediaObject, readMediaCollection } from '@nexus/shared/product-media'
import { legacyImageUrls } from '../images/listing-photos.pure.js'

export { legacyImageUrls }

/**
 * Product media is the one source (Owner 2026-10-05) — a variation row's photos are its own when the row chose them: its
 * listing's Product media, its old Image URLs list (until it moves into Product media), its product's own gallery or its
 * own files. A row with none of these shows the main row's gallery and sends no photos of its own.
 */
export function rowHasOwnPhotos(input: { listingAttributes: unknown; productContent: unknown; ownFileCount: number; locale: string }): boolean {
  const pa = mediaObject(input.listingAttributes)
  const chosen = (content: unknown) => (readMediaCollection(content, input.locale) ?? readMediaCollection(content, 'und')) !== undefined
  if (pa._productMediaLocales !== undefined && chosen(pa._productMediaLocales)) return true
  const legacy = legacyImageUrls(pa)
  if (legacy) return legacy.length > 0
  return chosen(input.productContent) || input.ownFileCount > 0
}

export interface VariationPhotoRow { sku: string; specifics: Record<string, string>; urls: string[]; own: boolean }
export interface VariationPhotoSets { axisName: string; byValue: Record<string, string[]>; order: string[] }

/** eBay takes at most 12 photos per variation value (Trading VariationSpecificPictureSet). */
export const EBAY_PHOTOS_PER_VALUE = 12
const same = (a: string[], b: string[]) => a.length === b.length && a.every((url, i) => url === b[i])

/**
 * The photo sets eBay shows per variation value. eBay groups photos by ONE variation name, so the sets use the first
 * name (in the listing's order) under which every value's rows hold the same photos. A row whose photos are the main
 * gallery adds nothing. When no name fits, nothing is sent and `note` says why (eBay keeps showing the main gallery).
 */
export function ebayVariationPhotoSets(input: { names: string[]; order?: Record<string, string[]>; gallery: string[]; rows: VariationPhotoRow[] }):
  { sets?: VariationPhotoSets; problems: string[]; note?: string } {
  const rows = input.rows.filter(row => row.own && row.urls.length && !same(row.urls, input.gallery))
  if (!rows.length) return { problems: [] }
  for (const axisName of input.names) {
    const byValue = new Map<string, string[]>()
    const fits = rows.every(row => {
      const value = row.specifics[axisName]
      if (!value) return false
      const held = byValue.get(value)
      if (!held) { byValue.set(value, row.urls); return true }
      return same(held, row.urls)
    })
    if (!fits) continue
    const order = [...(input.order?.[axisName] ?? []).filter(value => byValue.has(value)), ...[...byValue.keys()].filter(value => !input.order?.[axisName]?.includes(value))]
    const problems = order.filter(value => byValue.get(value)!.length > EBAY_PHOTOS_PER_VALUE)
      .map(value => `The ${value} photos: eBay takes at most ${EBAY_PHOTOS_PER_VALUE} per variation; this one has ${byValue.get(value)!.length}. Remove some in Product media.`)
    return { sets: { axisName, byValue: Object.fromEntries(order.map(value => [value, byValue.get(value)!])), order }, problems }
  }
  const names = input.names.join(' or ')
  return { problems: [], note: `Photos by variation are not sent: variations with the same ${names || 'value'} hold different photos in Product media. eBay keeps showing the main gallery for every variation. Give every variation of one ${input.names[0] ?? 'value'} the same photos to send them.` }
}

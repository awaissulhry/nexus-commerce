import { mediaObject, readMediaCollection } from '@nexus/shared/product-media'
import { legacyImageUrls } from '../images/listing-photos.pure.js'
import { aspectCanonicalName } from '../ebay-theme-axes.js'

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
 * The photo sets eBay shows per variation value. eBay groups photos by ONE variation name: the one the person chose for
 * this listing (`_imageAxis`, else the product's choice — readImageAxisPreference's order), else the first name (in the
 * listing's order) under which every value's rows show the same photos. A row without photos of its own shows the main
 * gallery and counts as it (review 2026-10-05: dropping those rows let another value's photos reach their buyers). A
 * value that shows the main gallery gets no set. eBay shows 12 photos per value: the first 12 are sent, and a note says so
 * — it never stops a publish. When no name fits, nothing is sent and a note says why (eBay keeps the main gallery).
 */
export function ebayVariationPhotoSets(input: { names: string[]; order?: Record<string, string[]>; gallery: string[]; rows: VariationPhotoRow[]; chosen?: string | null }):
  { sets?: VariationPhotoSets; notes: string[] } {
  const shown = (row: VariationPhotoRow) => row.own && row.urls.length ? row.urls : input.gallery
  if (input.rows.every(row => same(shown(row), input.gallery))) return { notes: [] }
  const chosen = input.chosen ? input.names.find(name => aspectCanonicalName(name) === aspectCanonicalName(input.chosen!)) : undefined
  for (const axisName of chosen ? [chosen] : input.names) {
    const byValue = new Map<string, string[]>()
    const fits = input.rows.every(row => {
      const value = row.specifics[axisName]
      if (!value) return false
      const held = byValue.get(value)
      if (!held) { byValue.set(value, shown(row)); return true }
      return same(held, shown(row))
    })
    if (!fits) continue
    const order = [...(input.order?.[axisName] ?? []).filter(value => byValue.has(value)), ...[...byValue.keys()].filter(value => !input.order?.[axisName]?.includes(value))]
      .filter(value => !same(byValue.get(value)!, input.gallery))
    const notes = order.filter(value => byValue.get(value)!.length > EBAY_PHOTOS_PER_VALUE)
      .map(value => `The ${value} photos: eBay shows at most ${EBAY_PHOTOS_PER_VALUE} per variation; the first ${EBAY_PHOTOS_PER_VALUE} of ${byValue.get(value)!.length} are sent.`)
    return { sets: { axisName, byValue: Object.fromEntries(order.map(value => [value, byValue.get(value)!.slice(0, EBAY_PHOTOS_PER_VALUE)])), order }, notes }
  }
  const name = chosen ?? input.names.join(' or ')
  return { notes: [`Photos by variation are not sent: variations with the same ${name || 'value'} show different photos in Product media. eBay keeps showing the main gallery for every variation. Give every variation of one ${chosen ?? input.names[0] ?? 'value'} the same photos to send them.`] }
}

import { listingContentState, contentAttribute } from '../pim/content-read.js'
import { translationMissing } from '../pim/content-resolver.js'

export const ETSY_CONTENT_FIELDS = new Set(['title', 'description', 'tags'])
export function etsyContentState(listing: Record<string, any> | null | undefined, locale: string, field: string) {
  if (!listing || !ETSY_CONTENT_FIELDS.has(field)) return null
  const resolved = listingContentState(listing, locale, field === 'tags' ? 'keywords' : field)
  return { ...contentAttribute(resolved, listing.productId), needsTranslation: translationMissing(resolved, locale) }
}

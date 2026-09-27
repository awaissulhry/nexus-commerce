/**
 * 2026-09-27 — what the channel sheet says about the channel's rules (`meta.schemaMissing`), in ONE place: the status
 * chip, the Requirements dialog and the empty-grid notice used to phrase it three ways, and none of them said the
 * plain fact behind "Incomplete: OUTERWEAR" — Amazon's rules for that product type in that market are not downloaded,
 * so the sheet shows only its fixed columns.
 *
 * Keys, as the API writes them (`sheet-columns.service.ts`): an Amazon product type (`OUTERWEAR`),
 * `AMAZON:category not selected`, `EBAY:<leaf>` / `EBAY:*`, `ETSY:<taxonomy>` / `ETSY:*`, `SHOPIFY:*`.
 */
import { channelLabel } from '../../scopes'

const SHOPIFY_FIELDS_UNREAD = 'SHOPIFY:*'
const AMAZON_TYPE_UNSET = 'AMAZON:category not selected'

export interface RulesStatus {
  tone: 'warning' | 'neutral'
  label: string
  /** One sentence per missing key, then what to do. */
  detail: string
  /** The categories the download action can fetch (Amazon types, eBay/Etsy category ids). */
  downloadable: string[]
}

/** The category a key names when the download action can fetch it, else null. */
export function downloadableCategory(key: string): string | null {
  if (key === SHOPIFY_FIELDS_UNREAD || key === AMAZON_TYPE_UNSET || key.endsWith(':*')) return null
  const scoped = /^(EBAY|ETSY):(.+)$/.exec(key)
  if (scoped) return scoped[2]
  return key.includes(':') ? null : key
}

/** One missing key, as a sentence. */
export function missingRuleSentence(channel: string, market: string, key: string): string {
  const where = `${channelLabel(channel)} · ${market}`
  if (key === SHOPIFY_FIELDS_UNREAD) return 'The Shopify store fields are still loading.'
  if (key === AMAZON_TYPE_UNSET) return 'No Amazon product type is set. Choose one to load its fields.'
  if (key === 'ETSY:*') return 'No Etsy category is selected. Choose one to load its fields.'
  if (key === 'EBAY:*') return `No eBay category is known for this product on ${where}. Choose one to load its fields.`
  const scoped = /^(EBAY|ETSY):(.+)$/.exec(key)
  if (scoped) return `${scoped[1] === 'EBAY' ? 'eBay' : 'Etsy'}'s rules for category ${scoped[2]} are not downloaded yet.`
  return `Amazon's rules for ${key} on ${where} are not downloaded yet, so only the fixed columns show.`
}

export function rulesStatus(channel: string, market: string, missing: readonly string[]): RulesStatus {
  const downloadable = [...new Set(missing.map(downloadableCategory).filter((c): c is string => c !== null))]
  if (!missing.length) {
    return { tone: 'neutral', label: 'Requirements', downloadable, detail: 'Requirements depend on the listing category and marketplace. Refresh them after changing categories and before publishing.' }
  }
  const sentences = missing.map(key => missingRuleSentence(channel, market, key))
  const next = downloadable.length ? 'Open Requirements and choose Download rules.' : 'Readiness cannot be confirmed until these requirements are available.'
  return { tone: 'warning', label: downloadable.length ? 'Rules not downloaded' : 'Requirements incomplete', downloadable, detail: `${sentences.join(' ')} ${next}` }
}

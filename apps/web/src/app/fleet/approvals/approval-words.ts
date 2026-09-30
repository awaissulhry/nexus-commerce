/**
 * MCP.12 — what the Approvals page SAYS about a request, kept apart from how it is drawn so a test can hold it.
 *
 * A local end-to-end run (2026-09-30, a copy of the development data, requests queued by Claude over MCP) found three
 * sentences on this page that were not true for the bulk tools:
 *
 *   · the Apply button named only the FIRST product of a 3-product price change
 *     ("Apply — <first SKU> base price €100.00 → €105.00");
 *   · the card showed the master prices and nothing of what each marketplace would get, although the preview carries
 *     it (one line per listing, "eBay IT: 90.00 → 105.00", and the listings that keep their own price);
 *   · the section heading said "3 requests can actually change something on Amazon" for an eBay price change and a
 *     change that touches Nexus only.
 */
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'

export interface Delta {
  field: string
  from: string | null
  to: string
}

type Preview = Record<string, unknown> | null | undefined

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const money = (value: number, currency: unknown) =>
  currency === 'EUR' || currency == null ? `€${value.toFixed(2)}` : `${String(currency)} ${value.toFixed(2)}`

/** What a bulk price change does to each price, as one phrase: "+5 %", "−€2.50", "set to €99.00". */
function priceMove(change: Record<string, unknown> | undefined): string | null {
  const value = num(change?.value)
  if (value == null) return null
  const sign = value > 0 ? '+' : '−'
  if (change?.operation === 'percent') return `${sign}${Math.abs(value)} %`
  if (change?.operation === 'amount') return `${sign}${money(Math.abs(value), change?.currency)}`
  if (change?.operation === 'set') return `set to ${money(value, change?.currency)}`
  return null
}

/**
 * The primary button's label. One change keeps the wording the card has always used ("Apply — bid €0.31 → €0.84");
 * more than one says what the WHOLE request does, never only its first line.
 */
export function approveLabelFor(toolName: string, deltas: Delta[], preview: Preview, fallback: string): string {
  if (deltas.length === 0) return fallback
  if (deltas.length === 1) {
    const [d] = deltas
    return d.from ? `Apply — ${d.field} ${d.from} → ${d.to}` : `Apply — ${d.field}: ${d.to}`
  }
  const p = (preview ?? {}) as Record<string, any>
  if (toolName === 'bulk-price-change') {
    const products = num(p.totals?.changing) ?? deltas.length
    const move = priceMove(p.change)
    return `Apply — base price ${move ? `${move} ` : ''}on ${plural(products, 'product')}`
  }
  if (toolName === 'bulk-attribute-change') {
    const products = num(p.totals?.products) ?? deltas.length
    const attributes = Array.isArray(p.attributes) ? (p.attributes as Array<{ attribute?: unknown; value?: unknown }>) : []
    if (attributes.length === 1 && typeof attributes[0].attribute === 'string') {
      const value = attributes[0].value
      const shown = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
      return `Apply — ${attributes[0].attribute}${shown != null ? `: ${shown}` : ''} on ${plural(products, 'product')}`
    }
    return `Apply — ${plural(attributes.length || deltas.length, 'attribute')} on ${plural(products, 'product')}`
  }
  // Any other request with several changes (apply-content's title and description): the count and what they are.
  const fields = deltas.map((d) => d.field)
  return `Apply — ${deltas.length} changes: ${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` and ${fields.length - 3} more` : ''}`
}

/**
 * How many more lines the request covers than the card lists: a bulk preview keeps 20 lines and counts the rest
 * (`moreProducts`, `moreChanges`), so the card must say "and N more" or it contradicts its own button.
 */
export function moreThanShown(toolName: string, preview: Preview): string | null {
  const p = (preview ?? {}) as Record<string, unknown>
  if (toolName === 'bulk-price-change') {
    const n = num(p.moreProducts)
    return n ? `and ${plural(n, 'more product')}` : null
  }
  if (toolName === 'bulk-attribute-change') {
    const n = num(p.moreChanges)
    return n ? `and ${plural(n, 'more change')}` : null
  }
  return null
}

export interface ChannelEffect {
  /** "SKU · eBay IT: 90.00 → 105.00", as the tool wrote them, at most the 20 it keeps. */
  lines: string[]
  /** Listing lines the preview counted but did not keep. */
  more: number
  /** One clause per non-zero count: "3 listings are sent to their marketplace", "6 keep their own price". */
  counts: string[]
}

/**
 * What each channel gets from a bulk price change, from its preview: the listing lines and the counts the master price
 * service will act on. Null for a request whose preview carries no listing effect.
 */
export function channelEffectOf(toolName: string, preview: Preview): ChannelEffect | null {
  if (toolName !== 'bulk-price-change') return null
  const p = (preview ?? {}) as Record<string, any>
  const t = (p.totals ?? {}) as Record<string, unknown>
  const lines = Array.isArray(p.listings) ? (p.listings as unknown[]).filter((l): l is string => typeof l === 'string') : []
  const count = (key: string) => num(t[key]) ?? 0
  const sent = count('listingsSent')
  const counts = [
    sent ? `${plural(sent, 'listing')} ${sent === 1 ? 'is' : 'are'} sent to ${sent === 1 ? 'its' : 'their'} marketplace` : 'no listing is sent to a marketplace',
    count('listingsPaused') ? `${plural(count('listingsPaused'), 'paused listing')} ${count('listingsPaused') === 1 ? 'takes' : 'take'} the new price but ${count('listingsPaused') === 1 ? 'is' : 'are'} not sent` : '',
    count('listingsWithOwnPrice') ? `${plural(count('listingsWithOwnPrice'), 'listing')} ${count('listingsWithOwnPrice') === 1 ? 'keeps its' : 'keep their'} own price` : '',
    count('listingsOtherCurrency') ? `${plural(count('listingsOtherCurrency'), 'listing')} in another currency ${count('listingsOtherCurrency') === 1 ? 'is' : 'are'} not sent` : '',
    count('listingsAlreadyAtPrice') ? `${plural(count('listingsAlreadyAtPrice'), 'listing')} ${count('listingsAlreadyAtPrice') === 1 ? 'is' : 'are'} already at the new price` : '',
  ].filter(Boolean)
  return { lines, more: num(p.moreListings) ?? 0, counts }
}

/**
 * The heading of the section of requests that can run. "N requests can actually change something on Amazon" was
 * wrong twice: the channel can be any of them, and a Nexus-only request reaches none.
 */
export function outsideHeading(toolNames: string[]): string {
  const n = toolNames.length
  const nexusOnly = toolNames.filter((name) => toolCardFor(name).nexusOnly).length
  const reach = n - nexusOnly
  if (nexusOnly === 0) return `${plural(n, 'request')} can change something on your sales channels`
  if (reach === 0) return n === 1 ? '1 request can change Nexus — it does not reach a sales channel' : `${n} requests can change Nexus — none of them reaches a sales channel`
  return `${plural(n, 'request')} can change something — ${reach} on your sales channels, ${nexusOnly} in Nexus only`
}

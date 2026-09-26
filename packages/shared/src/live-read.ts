/**
 * Read live (Owner, 2026-09-26): what a channel listing holds right now, in ONE shape for every channel, used by both the
 * publish review and the Information sheet so the two can never disagree. Read only: a live read is never stored as Nexus
 * data and never changes what Publish sends. The API keeps the raw provider documents server-side (never in this type).
 */
export type LiveReadChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'
export type LiveReadSource = 'amazon-listings-item' | 'ebay-trading-item' | 'ebay-inventory-group' | 'shopify-product' | 'etsy-listing'

/** One channel × market × account × listing alias, and Nexus's own SKUs there (so each variant can be marked). */
export interface LiveReadDestination {
  productId: string
  channel: LiveReadChannel
  marketplace: string
  accountId: string
  aliasKey: string
  expectedSkus: string[]
}

/** `unread` is never an empty value: it says why this value could not be read, so it is shown as "Could not read". */
export type LiveValue = { state: 'value'; value: unknown } | { state: 'absent' } | { state: 'unread'; reason: string }

/** A failed read, addressed to the whole item, one SKU, or one field. */
export interface LiveReadError { scope: 'item' | 'sku' | 'field'; sku?: string; field?: string; reason: string }

export interface LiveVariant {
  sku: string
  /** Axis name as the channel calls it → the value the channel shows. */
  values: Record<string, string>
  /** As the channel reports it: `{ amount: string; currency: string | null }`. Read only; the price door sets prices. */
  price: LiveValue
  /** Units the channel reports AVAILABLE (eBay Trading: Quantity − QuantitySold). Read only; the stock door sets stock. */
  stock: LiveValue
  /** live = on the channel and in Nexus · missing = in Nexus, not on the channel · extra = on the channel, not in Nexus. */
  state: 'live' | 'missing' | 'extra'
}

export interface LiveVariations {
  /** Axis names as the channel calls them, in the channel's order. */
  axes: string[]
  variants: LiveVariant[]
  /** Per axis, its values in the order the channel shows them. */
  order: Record<string, string[]>
}

export interface LiveRead {
  /** ISO time of the read. */
  readAt: string
  source: LiveReadSource
  destination: Omit<LiveReadDestination, 'expectedSkus'>
  /** Digest of the parsed live content; the publish review re-checks it just before a send. Null when the item was not read. */
  revision: string | null
  /** Keyed by the publish review's field ids: title, description, pictures, aspect:<key> (eBay); Amazon content roots as
   *  `<root>:["<marketplaceId>","<language>"]` and every other Amazon attribute by its root name. */
  content: Record<string, LiveValue>
  /** Null for a listing without variations. */
  variations: LiveVariations | null
  errors: LiveReadError[]
}

/** Marks each variant against Nexus's SKUs; a Nexus SKU the channel does not hold becomes a `missing` row. */
export function markLiveVariants(expectedSkus: readonly string[], live: Omit<LiveVariant, 'state'>[]): LiveVariant[] {
  const expected = new Set(expectedSkus), seen = new Set(live.map(v => v.sku))
  const none: LiveValue = { state: 'absent' }
  return [
    ...live.map(v => ({ ...v, state: expected.has(v.sku) ? 'live' as const : 'extra' as const })),
    ...expectedSkus.filter(sku => !seen.has(sku)).map(sku => ({ sku, values: {}, price: none, stock: none, state: 'missing' as const })),
  ]
}

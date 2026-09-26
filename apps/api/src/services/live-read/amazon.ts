/**
 * Read live — one Amazon family (parent + child seller SKUs) in one marketplace, as Amazon holds it now
 * (Listings Items API, one read per SKU), in the shared LiveRead shape. Read only.
 *
 * Content comes from the parent SKU, keyed by the publish review's field ids: `<root>:["<marketplaceId>","<language>"]`
 * for the four content roots, the attribute root name for every other attribute. Axes are the variation_theme's own
 * segments; each child's value is read from the attribute the cached schema binds that segment to — never guessed.
 * Amazon keeps no value order, so `order` is first-seen. The Listings API cannot list children it was not asked about,
 * so Amazon-only variants are not discovered here (no `extra` rows). Stock is the merchant quantity Amazon reports;
 * Amazon-fulfilled stock is not reported by this API.
 */
import { markLiveVariants, type LiveReadDestination, type LiveReadError, type LiveValue, type LiveVariations } from '@nexus/shared/live-read'
import { CONTENT_ROOTS } from '../channel-drift/amazon-content-compare.js'
import { amazonContentField } from '../pim/studio-publication-amazon-changes.js'
import { bindSegmentToAttribute, themeSegments } from '../pim/variation-theme-segments.js'
import { publicationDigest } from '../pim/studio-publication-plan.js'
import type { ServerLiveRead } from './types.js'

type Json = Record<string, any>
export type AmazonDestination = LiveReadDestination & { parentSku: string; marketplaceId: string; languageTag: string }
export type AmazonListingRead = { status: 'found'; raw: Json } | { status: 'absent' } | { status: 'error'; reason: string }
export interface AmazonReads {
  listing(sku: string): Promise<AmazonListingRead>
  /** The cached product-type schema's `properties`; null when it is not cached (the axis binding is then unknown). */
  schemaProperties(productType: string): Promise<Record<string, unknown> | null>
}
export interface AmazonRaw { listings: Record<string, AmazonListingRead> }

const value = (v: unknown): LiveValue => v == null || v === '' || (Array.isArray(v) && !v.length) ? { state: 'absent' } : { state: 'value', value: v }
const unread = (reason: string): LiveValue => ({ state: 'unread', reason })
const inMarket = (entries: unknown, marketplaceId: string): Json[] =>
  (Array.isArray(entries) ? entries : []).filter((e: Json) => e && typeof e === 'object' && (!e.marketplace_id || e.marketplace_id === marketplaceId))

/** A bound value: the entry's `value`, or a structured member (apparel_size → `size`). */
function pick(entry: Json | undefined, path?: string[]): unknown {
  if (!entry) return undefined
  let node: any = entry
  for (const key of path ?? []) node = Array.isArray(node?.[key]) ? node[key][0] : node?.[key]
  return node && typeof node === 'object' ? node.value : node
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]) } }))
  return out
}

export async function readAmazonListing(destination: AmazonDestination, reads: AmazonReads, now = () => new Date()): Promise<ServerLiveRead<AmazonRaw>> {
  const { expectedSkus, parentSku, marketplaceId, languageTag, ...where } = destination
  const skus = [...new Set([parentSku, ...expectedSkus])]
  const answers = await pool(skus, 5, sku => reads.listing(sku).catch((error): AmazonListingRead => ({ status: 'error', reason: error instanceof Error ? error.message : String(error) })))
  const listings: Record<string, AmazonListingRead> = Object.fromEntries(skus.map((sku, i) => [sku, answers[i]]))
  const errors: LiveReadError[] = []
  const parent = listings[parentSku]
  const base = { readAt: now().toISOString(), source: 'amazon-listings-item' as const, destination: where, raw: { listings } }
  if (parent.status !== 'found') {
    const reason = parent.status === 'error' ? parent.reason : 'The parent seller SKU is not listed on Amazon in this marketplace.'
    errors.push({ scope: 'item', reason })
    return { ...base, revision: null, variations: null, errors,
      content: parent.status === 'error' ? Object.fromEntries(CONTENT_ROOTS.map(root => [amazonContentField(root, marketplaceId, languageTag), unread(reason)])) : {} }
  }
  const attributes: Json = parent.raw.attributes ?? {}
  const content: Record<string, LiveValue> = {}
  for (const [root, entries] of Object.entries(attributes)) {
    if ((CONTENT_ROOTS as readonly string[]).includes(root)) {
      const mine = inMarket(entries, marketplaceId).filter(e => !e.language_tag || e.language_tag === languageTag)
      content[amazonContentField(root, marketplaceId, languageTag)] = value(mine.map(e => e.value).filter(v => v != null))
    } else content[root] = value(inMarket(entries, marketplaceId))
  }

  let variations: LiveVariations | null = null
  const theme = inMarket(attributes.variation_theme, marketplaceId)[0]?.name
  if (typeof theme === 'string' && theme.trim()) {
    const axes = themeSegments(theme)
    const productType = (parent.raw.summaries as Json[] | undefined)?.find(s => s.marketplaceId === marketplaceId)?.productType
    const properties = typeof productType === 'string' ? await reads.schemaProperties(productType).catch(() => null) : null
    if (!properties) errors.push({ scope: 'field', field: 'variation_theme', reason: 'The product-type schema is not cached; the variation values cannot be bound to their attributes.' })
    const bindings = new Map(axes.map(axis => [axis, properties ? bindSegmentToAttribute(axis, properties) : null]))
    const order: Record<string, string[]> = Object.fromEntries(axes.map(axis => [axis, []]))
    const live = expectedSkus.filter(sku => listings[sku]?.status !== 'absent').map(sku => {
      const read = listings[sku]
      if (read.status !== 'found') {
        errors.push({ scope: 'sku', sku, reason: read.status === 'error' ? read.reason : 'Not listed.' })
        return { sku, values: {}, price: unread('This seller SKU could not be read.'), stock: unread('This seller SKU could not be read.') }
      }
      const values: Record<string, string> = {}
      for (const axis of axes) {
        const binding = bindings.get(axis)
        const entry = binding ? inMarket(read.raw.attributes?.[binding.attribute], marketplaceId)[0] : undefined
        const raw = pick(entry, binding?.valuePath)
        if (raw == null) continue
        values[axis] = String(raw)
        if (!order[axis].includes(values[axis])) order[axis].push(values[axis])
      }
      const offer = (read.raw.offers as Json[] | undefined)?.find(o => o.marketplaceId === marketplaceId && (o.offerType ?? 'B2C') === 'B2C')
      const merchant = (read.raw.fulfillmentAvailability as Json[] | undefined)?.find(f => f.fulfillmentChannelCode === 'DEFAULT')
      return { sku, values,
        price: offer?.price?.amount != null ? value({ amount: String(offer.price.amount), currency: offer.price.currencyCode ?? null }) : { state: 'absent' as const },
        stock: Number.isSafeInteger(merchant?.quantity) ? value(merchant!.quantity) : unread('Amazon reports no merchant quantity for this SKU (Amazon-fulfilled or not set).') }
    })
    variations = { axes, order, variants: markLiveVariants(expectedSkus, live) }
  }
  const revision = publicationDigest(Object.fromEntries(skus.map(sku => [sku, listings[sku].status === 'found' ? (listings[sku] as { raw: Json }).raw.attributes ?? null : listings[sku].status])))
  return { ...base, revision, content, variations, errors }
}

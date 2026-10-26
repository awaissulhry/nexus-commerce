/**
 * The Listings page's bulk bar (step 6 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): which listings a price
 * action on the selected products reaches, BEFORE anything runs. `POST /api/catalog-transfer/readiness/listing-ids`
 * `{ productIds, destinationKeys }` answers the `ChannelListing` ids the page then hands to the existing
 * `POST /api/listings/bulk-action` (Set price, Follow master, Stop following master) — that route keeps every check of
 * its own. Read only; no channel call.
 *
 * A selected family parent stands for its family: the parent and its variants. A listing belongs to a destination by the
 * live layer's join rule (listing-readiness-live.service.ts: `liveDestinationKey` against `canonicalDestinationKey` —
 * channel, market with GB = UK, account and alias, exactly), the rule the chips, the tiles and the Listing window use.
 * Price actions never reach two kinds of listing, so neither is answered:
 *  - a second listing (an alias: `aliasKey` set) — it is counted in `aliases`, so the page can say it was left out;
 *  - a family parent's own listing — the parent is not buyable (the Matrix refuses its price the same way).
 * Shared and alias destinations are dropped from `destinationKeys` for the same reason.
 */
import prisma from '../../db.js'
import { canonicalDestinationKey, currencyMap, currencyOf, liveDestinationKey } from './listing-readiness-live.service.js'

export const LISTING_IDS_MAX_PRODUCTS = 1000
export const LISTING_IDS_MAX_DESTINATIONS = 200
/** Ids per query: keeps every `IN (…)` list well inside PostgreSQL's bind-parameter limit. */
const CHUNK = 1000

export interface ReadinessListingIds {
  /** The listings a price action reaches, by product. */
  listingIds: string[]
  /** Products with at least one listing reached. */
  products: number
  /** Product × destination pairs where the product belongs (it has a readiness row there) but has no listing. */
  missing: number
  /** Second listings (aliases) on these destinations: left out. */
  aliases: number
  /** The currencies of the reached listings' markets, once each, in order; null = a market Nexus has no currency for. */
  currencies: Array<string | null>
  /** Every product the selection covers: each selected product, and a family parent's variants. */
  productIds: string[]
}

interface Coordinate { channel: string | null; market: string | null; accountId: string | null; aliasId: string | null }

const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max
const optional = (value: unknown, max: number): value is string | null => value === null || text(value, max)

/** A destination key (`readinessCoordinateKey`: `[channel, market, accountId, aliasId]`) read back; refused when it is not one. */
export function parseDestinationKey(key: unknown): Coordinate {
  let parts: unknown = null
  if (typeof key === 'string' && key.length <= 1000) {
    try { parts = JSON.parse(key) } catch { parts = null }
  }
  if (!Array.isArray(parts) || parts.length !== 4) throw refuse('Choose destinations from the Listings page')
  const [channel, market, accountId, aliasId] = parts as unknown[]
  if (!(channel === null || (typeof channel === 'string' && /^[A-Z][A-Z0-9_]{1,49}$/.test(channel)))
    || !optional(market, 20) || !optional(accountId, 200) || !optional(aliasId, 200)) throw refuse('Choose destinations from the Listings page')
  return { channel: channel as string | null, market: market as string | null, accountId: accountId as string | null, aliasId: aliasId as string | null }
}

/**
 * The request, checked: 1–1,000 product ids, up to 200 destination keys (none is allowed: the answer is then only
 * `productIds`). The destinations come back in the live layer's spelling (`canonicalDestinationKey`).
 */
export function listingIdsInput(body: unknown): { productIds: string[]; destinations: Set<string>; channels: string[] } {
  const input = (body && typeof body === 'object' ? body : {}) as { productIds?: unknown; destinationKeys?: unknown }
  const ids = input.productIds
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > LISTING_IDS_MAX_PRODUCTS || ids.some(id => !text(id, 200))) {
    throw refuse(`Choose 1–${LISTING_IDS_MAX_PRODUCTS.toLocaleString('en')} products`)
  }
  const keys = input.destinationKeys ?? []
  if (!Array.isArray(keys) || keys.length > LISTING_IDS_MAX_DESTINATIONS) throw refuse(`Choose at most ${LISTING_IDS_MAX_DESTINATIONS} destinations`)
  const destinations = new Set<string>()
  const channels = new Set<string>()
  for (const key of keys) {
    const coordinate = parseDestinationKey(key)
    // Shared has no listing; an alias destination is a second listing: price actions reach neither.
    if (!coordinate.channel || coordinate.aliasId) continue
    destinations.add(canonicalDestinationKey(key as string))
    channels.add(coordinate.channel)
  }
  return { productIds: [...new Set((ids as string[]).map(id => id.trim()))], destinations, channels: [...channels] }
}

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

export async function readinessListingIds(body: unknown): Promise<ReadinessListingIds> {
  const { productIds: selected, destinations, channels } = listingIdsInput(body)
  // The selected products and, for a family parent, its variants.
  const products = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: { in: selected } }, { parentId: { in: selected } }] },
    select: { id: true, isParent: true },
    orderBy: { id: 'asc' },
  })
  const productIds = products.map(p => p.id)
  const empty: ReadinessListingIds = { listingIds: [], products: 0, missing: 0, aliases: 0, currencies: [], productIds }
  // A family parent's own listing is never priced: only the products that sell.
  const sellable = products.filter(p => !p.isParent).map(p => p.id)
  if (destinations.size === 0 || sellable.length === 0) return empty

  const listings: Array<{ id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string }> = []
  const belongs = new Map<string, Set<string>>() // product → the chosen destinations it has a readiness row on
  for (const part of chunks(sellable)) {
    const [rows, index] = await Promise.all([
      prisma.channelListing.findMany({
        where: { productId: { in: part }, channel: { in: channels } },
        select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true },
        orderBy: [{ productId: 'asc' }, { id: 'asc' }],
      }),
      prisma.readinessIndex.findMany({
        where: { productId: { in: part }, channel: { in: channels } },
        select: { productId: true, coordinateKey: true },
        distinct: ['productId', 'coordinateKey'],
      }),
    ])
    listings.push(...rows)
    for (const row of index) {
      const key = canonicalDestinationKey(row.coordinateKey)
      if (!destinations.has(key)) continue
      if (!belongs.has(row.productId)) belongs.set(row.productId, new Set())
      belongs.get(row.productId)!.add(key)
    }
  }

  const reached: typeof listings = []
  const reachedAt = new Set<string>() // product × destination with a listing reached
  let aliases = 0
  for (const listing of listings) {
    if (listing.aliasKey) {
      // The same store and market as a chosen destination, under a second listing: left out, and said.
      if (destinations.has(liveDestinationKey({ ...listing, aliasKey: null }))) aliases++
      continue
    }
    const key = liveDestinationKey(listing)
    if (!destinations.has(key)) continue
    reached.push(listing)
    reachedAt.add(`${listing.productId}\u0000${key}`)
  }

  // Where a product belongs (a readiness row on a chosen destination) and has no listing: not listed there.
  let missing = 0
  for (const [productId, keys] of belongs) for (const key of keys) if (!reachedAt.has(`${productId}\u0000${key}`)) missing++

  // One currency per market (Marketplace, GB = UK, as the live layer reads it); the page holds Set price unless every
  // listing shares one.
  const currencies = currencyMap(await prisma.marketplace.findMany({ where: { channel: { in: channels } }, select: { channel: true, code: true, currency: true } }))
  const used = [...new Set(reached.map(l => currencyOf(currencies, l.channel, l.marketplace)?.toUpperCase() ?? null))]

  return {
    listingIds: reached.map(l => l.id),
    products: new Set(reached.map(l => l.productId)).size,
    missing,
    aliases,
    currencies: used,
    productIds,
  }
}

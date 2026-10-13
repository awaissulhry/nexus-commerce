/**
 * Proposal 2.3 — the facts a listing price or sale change stands on, read the same way by every tool that reads or writes
 * them, so the change plan runner can tell an earlier step's own write (PlanWrite) from anyone else's:
 *
 *   `listing:<id>:price`    its own price: { follow, override, price } — what a price write sets (pinnedPrice)
 *   `listing:<id>:sale`     its sale: { value, start, end } — what a sale write sets (saleFact)
 *   and, folded into the preview's `context`: what else its price depends on, which no plan step writes — its rule and
 *   adjustment, whether it is held (paused or a draft), FBA, its market and currency, and its product's master price with
 *   its floor and ceiling.
 *
 * A sale stands on the price it was planned against, and a price on the sale, so neither runs past the other unseen.
 * Nothing names another business: the listings are read in the caller's business only.
 */
import prisma from '../../../db.js'
import { holdsCascadedPrice, listingMarketCurrency } from '../../pim/follower-price.js'
import { readSaleWindows } from '../../pim/sale-window.js'
import { factHash, type PlanFacts } from '../tool-types.js'

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A listing's own price after a write pinned it at `price` (the price door stores the pin in all three columns). */
export const pinnedPrice = (price: number) => ({ follow: false, override: price, price })

/** A sale as a fact: the value and its days. */
export const saleFact = (sale: { value?: unknown; start?: unknown; end?: unknown } | null | undefined) =>
  ({ value: num(sale?.value), start: typeof sale?.start === 'string' ? sale.start : null, end: typeof sale?.end === 'string' ? sale.end : null })

export interface ListingFacts {
  /** By key: `listing:<id>:price` and `listing:<id>:sale`, the facts a plan step may write. */
  writable: Map<string, unknown>
  /** Everything else, by key: what no plan step writes. */
  context: Map<string, unknown>
}

/** The price facts of these listings (and of their products). Unknown ids are left out. */
export async function listingPriceFacts(listingIds: readonly string[]): Promise<ListingFacts> {
  const ids = [...new Set(listingIds)]
  const out: ListingFacts = { writable: new Map(), context: new Map() }
  if (!ids.length) return out
  const rows = await prisma.channelListing.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, productId: true, channel: true, marketplace: true, price: true, priceOverride: true, followMasterPrice: true, salePrice: true,
      pricingRule: true, priceAdjustmentPercent: true, syncPaused: true, listingStatus: true, isPublished: true, externalListingId: true,
      fulfillmentMethod: true, product: { select: { basePrice: true, minPrice: true, maxPrice: true } },
    },
  })
  const channels = [...new Set(rows.map((r) => r.channel))]
  const [windows, markets] = await Promise.all([
    readSaleWindows(prisma as never, rows.map((r) => r.id)),
    channels.length ? prisma.marketplace.findMany({ where: { channel: { in: channels } }, select: { channel: true, code: true, currency: true } }) : [],
  ])
  for (const r of rows) {
    const window = windows.get(r.id)
    out.writable.set(`listing:${r.id}:price`, { follow: r.followMasterPrice, override: num(r.priceOverride), price: num(r.price) })
    out.writable.set(`listing:${r.id}:sale`, saleFact({ value: r.salePrice, start: window?.start ?? null, end: window?.end ?? null }))
    out.context.set(`listing:${r.id}:pricing`, {
      rule: r.pricingRule, adjustment: num(r.priceAdjustmentPercent), held: holdsCascadedPrice(r), fba: r.fulfillmentMethod,
      market: `${r.channel}:${r.marketplace}`, currency: listingMarketCurrency(r, markets),
    })
    out.context.set(`product:${r.productId}:price`, { base: num(r.product?.basePrice), min: num(r.product?.minPrice), max: num(r.product?.maxPrice) })
  }
  return out
}

const sorted = <T>(entries: Iterable<[string, T]>): Array<[string, T]> => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * A preview's `planFacts` (PlanFacts) from listing facts: the writable facts it stands on (`keep` says which), each by
 * key; all its other facts under `context` (unless `context: false`); and what it sets.
 */
export function listingPlanFacts(
  facts: ListingFacts,
  sets: Record<string, unknown>,
  opts: { keep?: (key: string) => boolean; context?: boolean } = {},
): PlanFacts {
  const stands: Record<string, string> = {}
  for (const [key, value] of sorted(facts.writable)) if (!opts.keep || opts.keep(key)) stands[key] = factHash(value)
  if (opts.context !== false && facts.context.size) stands.context = factHash(Object.fromEntries(sorted(facts.context)))
  return { stands, sets: factHash(Object.fromEntries(sorted(Object.entries(sets)))) }
}

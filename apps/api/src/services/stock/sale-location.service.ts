import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import { defaultStockLocation } from '../default-stock-location.js'
import { normalizeMarket, sellsFrom, type SellsFromOrigin } from '../sync-control-core.js'
import { ledgerInputs, loadSyncLedgers } from '../stock-pool/sync-ledgers.js'

/**
 * Step 2 — "Sells from": WHERE a sale takes its stock.
 *
 * A listing shows the sum of the locations its market sells from (`sellsFrom` in sync-control-core.ts: the listing's
 * own list, else the business's list for the market, else the locations' routes, default warehouse first). A sale
 * takes its units from ONE of those locations: the first in that order that has enough available for the whole line.
 * Owner rulings (2026-10-07):
 *   • one order line is never split across locations;
 *   • when no location has enough, the FIRST location is used, so the hold or take fails exactly as it did before
 *     (InsufficientStockError → the line is recorded as a shortfall);
 *   • a pooled product, a product with no routed row, or a sale whose market cannot be told: no answer here (`null`),
 *     and the caller keeps the location it used before (the default warehouse);
 *   • FBA / MCF holds never come here (the callers ask only for a warehouse hold or take).
 *
 * It only reads. Callers ask AFTER their order-stock lock (nexus_lock_order_stock / lockProductStock) and inside the
 * same transaction, so two orders racing for the last units see each other's holds and takes.
 */

/** What the channel says about the sale: enough to find the listing that sold and the market it sold in. */
export interface SaleRoute {
  /** 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY' | … (ChannelListing.channel). */
  channel: string
  /** The market of the sale when the channel says it (Amazon: 'IT'); otherwise the listing's own market. */
  marketplace?: string | null
  /** The channel account the order came from. A listing of another account of the same channel is never used. */
  channelConnectionId?: string | null
  /** The channel's id of the listing that sold (eBay: the line's legacy item id); picks it among the account's listings. */
  externalListingId?: string | null
}

export interface SaleLocation {
  locationId: string
  code: string
  /** Which list decided the order: the listing's own, the market's, or the locations' routes. */
  origin: SellsFromOrigin
  /** False: no location had enough, so this is the first one (the hold or take will report the shortfall). */
  enough: boolean
}

/**
 * Pure. The location a sale of `quantity` takes from, among rows already in sale order: the first with
 * `available ≥ quantity`; else the first row (one line is never split — the shortfall is reported as before);
 * `null` only when there is no row at all.
 */
export function pickSaleLocation<T extends { available: number }>(rowsInSaleOrder: ReadonlyArray<T>, quantity: number): T | null {
  if (rowsInSaleOrder.length === 0) return null
  return rowsInSaleOrder.find((row) => row.available >= quantity) ?? rowsInSaleOrder[0]
}

interface ListingFacts {
  id: string
  marketplace: string
  channelConnectionId: string | null
  aliasKey: string
  externalListingId: string | null
  sourceLocationCodes: string[]
}

/**
 * The product's listing that made the sale: same channel; same market when the sale names one; never another account
 * of the channel. Among several, the one carrying the sold item id, then the order's own account, then the primary
 * listing (aliasKey ''), then the oldest id. With no market named and no item id matched, listings in two markets are
 * ambiguous: `ambiguous` — the caller must not guess a market.
 */
function saleListingOf(listings: ListingFacts[], route: SaleRoute): { listing: ListingFacts | null; ambiguous: boolean } {
  const channel = route.channel.trim().toUpperCase()
  const market = route.marketplace ? normalizeMarket(channel, route.marketplace) : null
  const candidates = listings.filter((l) =>
    (market === null || normalizeMarket(channel, l.marketplace) === market)
    && (!route.channelConnectionId || l.channelConnectionId == null || l.channelConnectionId === route.channelConnectionId))
  if (candidates.length === 0) return { listing: null, ambiguous: false }
  const itemId = route.externalListingId?.trim() || null
  const score = (l: ListingFacts) =>
    (itemId && l.externalListingId === itemId ? 4 : 0)
    + (route.channelConnectionId && l.channelConnectionId === route.channelConnectionId ? 2 : 0)
    + (l.aliasKey === '' ? 1 : 0)
  const ranked = [...candidates].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const best = ranked[0]
  const matchedItem = !!itemId && best.externalListingId === itemId
  if (market === null && !matchedItem && new Set(candidates.map((l) => normalizeMarket(channel, l.marketplace))).size > 1) {
    return { listing: null, ambiguous: true }
  }
  return { listing: best, ambiguous: false }
}

/**
 * The location a sale of `quantity` units of `productId` takes from, inside the caller's transaction (after its
 * order-stock lock). `null` = "Sells from" does not decide: the product sells from a pool, has no routed warehouse
 * row, or the sale's market cannot be told — the caller keeps the location it always used.
 */
export async function saleLocationInTx(tx: Prisma.TransactionClient, args: SaleRoute & { productId: string; quantity: number }): Promise<SaleLocation | null> {
  const channel = args.channel.trim().toUpperCase()
  const product = (await loadSyncLedgers(tx, [args.productId])).get(args.productId)
  // A pooled product sells from the lender's warehouses (the pool doors decide); an empty ledger has nothing to pick.
  if (!product || product.source.kind === 'pool' || product.ledger.length === 0) return null

  const listings = await tx.channelListing.findMany({
    where: { productId: args.productId, channel },
    select: { id: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true, sourceLocationCodes: true },
  })
  const { listing, ambiguous } = saleListingOf((listings ?? []) as ListingFacts[], { ...args, channel })
  if (ambiguous) return null
  const marketplace = args.marketplace?.trim() || listing?.marketplace || null
  if (!marketplace) return null

  const chosen = sellsFrom({ ...ledgerInputs(product, listing?.sourceLocationCodes ?? []), channel, marketplace })
  // One row per location (a location counted twice keeps its first place), and only switched-on warehouses: the
  // loader already drops the others, this keeps a stale code from ever naming one.
  const seen = new Set<string>()
  const rows = chosen.rows.filter((row) => !seen.has(row.locationCode) && !!seen.add(row.locationCode))
  if (rows.length === 0) return null
  const active = await tx.stockLocation.findMany({
    where: { code: { in: rows.map((row) => row.locationCode) }, type: 'WAREHOUSE', isActive: true },
    select: { id: true, code: true },
  })
  const idOf = new Map((active ?? []).map((location) => [location.code, location.id]))
  const pick = pickSaleLocation(rows.filter((row) => idOf.has(row.locationCode)), args.quantity)
  if (!pick) return null
  return { locationId: idOf.get(pick.locationCode)!, code: pick.locationCode, origin: chosen.origin, enough: pick.available >= args.quantity }
}

/**
 * The warehouse every channel order was held at before Step 2, inside the caller's transaction: IT-MAIN, else the
 * business's default warehouse (what `resolveLocationByCode('IT-MAIN')` answers). The location a sale uses when
 * "Sells from" does not decide.
 */
export async function fallbackSaleLocationInTx(tx: Prisma.TransactionClient): Promise<string | null> {
  const itMain = await tx.stockLocation.findUnique({ where: { workspace_code: workspaceKey({ code: 'IT-MAIN' }) }, select: { id: true } })
  if (itMain) return itMain.id
  return (await defaultStockLocation(tx))?.id ?? null
}

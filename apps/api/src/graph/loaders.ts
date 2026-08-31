// PH.3 — per-request DataLoaders.
//
// The N+1 answer, and not optional. `products(skus: [...])` with 50 skus and
// naive resolvers issues 1 + 50 + 50 queries; with these it issues 3. A graph
// without batching is a very efficient way to overload Postgres, and the load
// arrives as a shape the REST API never produced.
//
// Loaders are built PER REQUEST. A process-wide loader would cache across
// users and across time — serving one caller's rows to the next, and stale
// rows forever. Per-request is the only correct lifetime here.

import DataLoader from 'dataloader'
import prisma from '../db.js'

export interface StockRow {
  locationId: string
  code: string
  type: string
  quantity: number
  reserved: number
  available: number
}

export interface ListingRow {
  id: string
  channel: string
  marketplace: string | null
  listingStatus: string
  quantity: number | null
  fulfillmentMethod: string | null
  syncPaused: boolean
}

export interface GraphLoaders {
  stockByProduct: DataLoader<string, StockRow[]>
  listingsByProduct: DataLoader<string, ListingRow[]>
  costPriceByProduct: DataLoader<string, number | null>
}

/**
 * DataLoader requires the results array to line up with the keys array, index
 * for index. Grouping into a Map and reading it back by key is what guarantees
 * that — returning rows in database order would hand product A's stock to
 * product B whenever a product has no rows at all.
 */
function groupBy<T>(rows: T[], key: (row: T) => string, ids: readonly string[]): T[][] {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = map.get(k)
    if (list) list.push(row)
    else map.set(k, [row])
  }
  return ids.map((id) => map.get(id) ?? [])
}

export function createLoaders(): GraphLoaders {
  return {
    stockByProduct: new DataLoader<string, StockRow[]>(async (productIds) => {
      const rows = await prisma.stockLevel.findMany({
        where: { productId: { in: [...productIds] } },
        select: {
          productId: true,
          locationId: true,
          quantity: true,
          reserved: true,
          available: true,
          location: { select: { code: true, type: true } },
        },
      })
      return groupBy(
        rows.map((r) => ({
          productId: r.productId,
          locationId: r.locationId,
          code: r.location?.code ?? 'UNKNOWN',
          type: r.location?.type ?? 'UNKNOWN',
          quantity: r.quantity,
          reserved: r.reserved,
          available: r.available,
        })),
        (r) => r.productId,
        productIds,
      )
    }),

    listingsByProduct: new DataLoader<string, ListingRow[]>(async (productIds) => {
      const rows = await prisma.channelListing.findMany({
        where: { productId: { in: [...productIds] } },
        select: {
          id: true,
          productId: true,
          channel: true,
          marketplace: true,
          listingStatus: true,
          quantity: true,
          fulfillmentMethod: true,
          syncPaused: true,
        },
      })
      return groupBy(rows, (r) => r.productId, productIds)
    }),

    // Not in ProductReadCache, so it costs a query — but only for a caller
    // that actually selects it.
    costPriceByProduct: new DataLoader<string, number | null>(async (productIds) => {
      const rows = await prisma.product.findMany({
        where: { id: { in: [...productIds] } },
        select: { id: true, costPrice: true },
      })
      const map = new Map(rows.map((r) => [r.id, r.costPrice == null ? null : Number(r.costPrice)]))
      return productIds.map((id) => map.get(id) ?? null)
    }),
  }
}

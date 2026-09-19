import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { syncLedgerOf, type RoutedLedgerRow, type SyncLedger } from '../sync-control-core.js'
import { poolLevels, type PoolLevel } from './pool-doors.js'

/**
 * Shared stock (plan docs/2026-09-19-shared-stock-plan.md, contract docs/2026-09-19-shared-stock-build.md
 * §2) — THE place a listing's ledger comes from.
 *
 * A product in this business sells from one source at a time:
 *   • its own stock: this business's WAREHOUSE StockLevel rows (exactly what every caller read before);
 *   • a shared pool: the lent warehouses of another business, read through door 1
 *     (nexus_pool_available). This business cannot read those rows itself.
 * Every path that works out how many units a listing should advertise — the cascade, the dispatch
 * re-read, the read-backs, the drift heal, the Sync Control and matrix views — takes its ledger from
 * here. The branded `SyncLedger` type in sync-control-core.ts makes that a compile error to forget.
 */

type Db = Prisma.TransactionClient | typeof prisma

export type StockSource =
  | { kind: 'own' }
  | { kind: 'pool'; grantId: string; ownerWorkspaceId: string; locations: PoolLevel[] }

export interface ProductLedger {
  productId: string
  source: StockSource
  /** The WAREHOUSE rows the product's listings follow: its own, or the pool's lent locations. */
  ledger: SyncLedger
  /** Σ quantity over those rows — the drift snapshot (ChannelListing.masterQuantity). */
  quantity: number
  /** Σ available over those rows. */
  available: number
  /**
   * The product sold from a pool before and now uses its own stock: an own stock that was never
   * counted means 0 here, never "unknown", so a listing never keeps the pool's last number.
   */
  uncountedIsZero: boolean
  /** This business's own AMAZON_FBA units for the product (FBA method resolution). Never pooled. */
  fbaBucket: number
}

const emptyOwn = (productId: string): ProductLedger => ({
  productId,
  source: { kind: 'own' },
  ledger: syncLedgerOf([]),
  quantity: 0,
  available: 0,
  uncountedIsZero: false,
  fbaBucket: 0,
})

export async function loadSyncLedgers(db: Db, productIds: Iterable<string>): Promise<Map<string, ProductLedger>> {
  const ids = [...new Set([...productIds].filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const out = new Map<string, ProductLedger>()
  if (ids.length === 0) return out

  // One after another: `db` may be an interactive transaction, which runs one statement at a time.
  const own = await db.stockLevel.findMany({
    where: { productId: { in: ids } },
    select: { productId: true, quantity: true, available: true, location: { select: { type: true, code: true, syncRoutes: true } } },
  })
  const pool = await poolLevels(db, ids)
  const history = await db.stockPoolLink.findMany({ where: { productId: { in: ids } }, select: { productId: true }, distinct: ['productId'] })
  const everPooled = new Set(history.map((h) => h.productId))

  const ownRows = new Map<string, RoutedLedgerRow[]>()
  const ownTotals = new Map<string, { quantity: number; available: number; fba: number }>()
  for (const row of own) {
    const totals = ownTotals.get(row.productId) ?? { quantity: 0, available: 0, fba: 0 }
    if (row.location?.type === 'WAREHOUSE') {
      const rows = ownRows.get(row.productId) ?? []
      rows.push({ locationCode: row.location.code ?? '?', available: row.available, syncRoutes: row.location.syncRoutes ?? [] })
      ownRows.set(row.productId, rows)
      totals.quantity += row.quantity
      totals.available += row.available
    } else if (row.location?.type === 'AMAZON_FBA') {
      totals.fba += row.quantity
    }
    ownTotals.set(row.productId, totals)
  }

  for (const productId of ids) {
    const fbaBucket = ownTotals.get(productId)?.fba ?? 0
    const lent = pool.get(productId)
    if (lent && lent.length > 0) {
      // The pool's routes are the borrower's to decide: a lent row routes everywhere. (A location's
      // syncRoutes belong to the lender's own channels.)
      out.set(productId, {
        productId,
        source: { kind: 'pool', grantId: lent[0].grantId, ownerWorkspaceId: lent[0].ownerWorkspaceId, locations: lent },
        ledger: syncLedgerOf(lent.map((l) => ({ locationCode: l.locationCode ?? l.locationId, available: l.available, syncRoutes: [] }))),
        quantity: lent.reduce((sum, l) => sum + l.quantity, 0),
        available: lent.reduce((sum, l) => sum + l.available, 0),
        uncountedIsZero: false,
        fbaBucket,
      })
      continue
    }
    const totals = ownTotals.get(productId)
    out.set(productId, {
      ...emptyOwn(productId),
      ledger: syncLedgerOf(ownRows.get(productId) ?? []),
      quantity: totals?.quantity ?? 0,
      available: totals?.available ?? 0,
      uncountedIsZero: everPooled.has(productId),
      fbaBucket,
    })
  }
  return out
}

/** The ledger fields of the core's inputs, for one product. A pooled product ignores a listing's own
 *  location override: those codes name this business's warehouses, and the pool's are the lender's. */
export function ledgerInputs(product: ProductLedger | undefined, sourceLocationCodes: string[] = []): {
  ledger: SyncLedger
  sourceLocationCodes: string[]
  uncountedIsZero: boolean
} {
  if (!product) return { ledger: syncLedgerOf([]), sourceLocationCodes, uncountedIsZero: false }
  return {
    ledger: product.ledger,
    sourceLocationCodes: product.source.kind === 'pool' ? [] : sourceLocationCodes,
    uncountedIsZero: product.uncountedIsZero,
  }
}

/**
 * For the product switch's preview: the two ledgers a product could follow — its own stock (a product
 * leaving the pool: uncounted means 0) and the pool of `grantId` as it would be if the product were
 * switched now (nexus_pool_preview: through its catalog link, before any pool link exists). A product
 * with no active catalog link to that lender has no pool choice.
 */
export async function loadLedgerChoices(db: Db, productIds: Iterable<string>, grantId: string | null): Promise<Map<string, { own: ProductLedger; pool: ProductLedger | null }>> {
  const ids = [...new Set([...productIds].filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const out = new Map<string, { own: ProductLedger; pool: ProductLedger | null }>()
  if (ids.length === 0) return out
  const own = await db.stockLevel.findMany({
    where: { productId: { in: ids } },
    select: { productId: true, quantity: true, available: true, location: { select: { type: true, code: true, syncRoutes: true } } },
  })
  const preview = grantId
    ? await db.$queryRaw<Array<{ product_id: string; location_id: string; location_code: string | null; quantity: number; reserved: number; available: number }>>`
        SELECT product_id, location_id, location_code, quantity, reserved, available FROM nexus_pool_preview(${grantId}, ${ids}::text[])`
    : []
  const grant = grantId ? await db.stockPoolGrant.findUnique({ where: { id: grantId }, select: { ownerWorkspaceId: true } }) : null
  for (const productId of ids) {
    const rows = own.filter((r) => r.productId === productId)
    const warehouse = rows.filter((r) => r.location?.type === 'WAREHOUSE')
    const fbaBucket = rows.filter((r) => r.location?.type === 'AMAZON_FBA').reduce((sum, r) => sum + r.quantity, 0)
    const ownLedger: ProductLedger = {
      productId,
      source: { kind: 'own' },
      ledger: syncLedgerOf(warehouse.map((r) => ({ locationCode: r.location?.code ?? '?', available: r.available, syncRoutes: r.location?.syncRoutes ?? [] }))),
      quantity: warehouse.reduce((sum, r) => sum + r.quantity, 0),
      available: warehouse.reduce((sum, r) => sum + r.available, 0),
      uncountedIsZero: true,
      fbaBucket,
    }
    const lent = preview.filter((r) => r.product_id === productId)
    const pool: ProductLedger | null = lent.length > 0 && grantId && grant
      ? {
          productId,
          source: {
            kind: 'pool', grantId, ownerWorkspaceId: grant.ownerWorkspaceId,
            locations: lent.map((l) => ({ grantId, ownerWorkspaceId: grant.ownerWorkspaceId, locationId: l.location_id, locationCode: l.location_code, quantity: Number(l.quantity), reserved: Number(l.reserved), available: Number(l.available) })),
          },
          ledger: syncLedgerOf(lent.map((l) => ({ locationCode: l.location_code ?? l.location_id, available: Number(l.available), syncRoutes: [] }))),
          quantity: lent.reduce((sum, l) => sum + Number(l.quantity), 0),
          available: lent.reduce((sum, l) => sum + Number(l.available), 0),
          uncountedIsZero: false,
          fbaBucket,
        }
      : null
    out.set(productId, { own: ownLedger, pool })
  }
  return out
}

/**
 * Units a product's listings may promise, before a listing's own hold-back: Σ available over the
 * ledger it follows — its own WAREHOUSE rows, or the pool's lent warehouses. The one number every
 * send-time limit and every "is it in stock" check uses, so none of them caps a pooled product to its
 * business's own (often empty) stock.
 */
export async function sellableAvailable(db: Db, productIds: Iterable<string>): Promise<Map<string, number>> {
  const ledgers = await loadSyncLedgers(db, productIds)
  return new Map([...ledgers].map(([productId, product]) => [productId, product.available]))
}

/**
 * For the older publish paths that send Product.totalStock (the eBay draft publish, the listing wizard,
 * the Shopify content publisher, bulk channel batches, the Amazon variation mapper, new drafts): the
 * whole-unit number a product sells from. A pooled product: the pool's quantity. A product that left a
 * pool: its own ledger (0 when never counted). Any other product: its Product.totalStock, unchanged —
 * so these paths behave exactly as before for every product that never used shared stock.
 */
export async function sellableQuantity(db: Db, products: Array<{ id: string; totalStock: number | null }>): Promise<Map<string, number>> {
  const ledgers = await loadSyncLedgers(db, products.map((p) => p.id))
  return new Map(products.map((p) => {
    const ledger = ledgers.get(p.id)
    const usesLedger = ledger && (ledger.source.kind === 'pool' || ledger.uncountedIsZero)
    return [p.id, usesLedger ? ledger.quantity : p.totalStock ?? 0]
  }))
}

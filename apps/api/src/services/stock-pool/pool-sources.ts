import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { poolLevels } from './pool-doors.js'

/**
 * Shared stock plan step 5 — "who owns this pool" on the stock pages and the product list.
 *
 * The stock pages read this business's OWN StockLevel rows. For a product that sells from another
 * business's pool those rows are not what its listings sell from, so every stock payload carries the
 * pool beside them: the lender's name and the pool's numbers (door 1, the borrower's own view). The
 * page shows both, labelled, never added together (a product uses one source at a time).
 *
 * A business that borrows nothing pays one indexed count: no door call.
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface PoolSource {
  /** The business that lends the stock. */
  lenderName: string
  grantId: string
  quantity: number
  reserved: number
  available: number
}

/** For a parent row: its pooled variations added up, and how many of them sell from a pool. */
export interface PoolSourceSummary extends PoolSource {
  products: number
}

/** Does this business sell any product from a pool right now? One indexed count. */
export async function borrowsStock(db: Db): Promise<boolean> {
  return (await db.stockPoolLink.count({ where: { status: 'active' } })) > 0
}

export async function loadPoolSources(db: Db, productIds: string[], known?: { borrows: boolean }): Promise<Map<string, PoolSource>> {
  const out = new Map<string, PoolSource>()
  const ids = [...new Set(productIds.filter(Boolean))]
  if (ids.length === 0) return out
  if (!(known?.borrows ?? (await borrowsStock(db)))) return out
  const levels = await poolLevels(db, ids)
  if (levels.size === 0) return out
  const grantIds = [...new Set([...levels.values()].map((rows) => rows[0].grantId))]
  const grants = await db.stockPoolGrant.findMany({ where: { id: { in: grantIds } }, select: { id: true, ownerWorkspace: { select: { name: true } } } })
  const nameOf = new Map(grants.map((g) => [g.id, g.ownerWorkspace.name]))
  for (const [productId, rows] of levels) {
    out.set(productId, {
      lenderName: nameOf.get(rows[0].grantId) ?? 'another business',
      grantId: rows[0].grantId,
      quantity: rows.reduce((sum, r) => sum + r.quantity, 0),
      reserved: rows.reduce((sum, r) => sum + r.reserved, 0),
      available: rows.reduce((sum, r) => sum + r.available, 0),
    })
  }
  return out
}

/**
 * For a page of stock rows: each product's pool, and for each parent row its variations (children and
 * grandchildren) so the row can add up the pooled ones. A pooled variation may have no own stock row,
 * so the ids come from the product tree, not from the stock rows. A business that borrows nothing: one count.
 */
export async function loadPagePoolSources(db: Db, pageProductIds: string[], parentProductIds: string[]): Promise<{ sources: Map<string, PoolSource>; childrenOf: Map<string, string[]> }> {
  const childrenOf = new Map<string, string[]>()
  const borrows = await borrowsStock(db)
  if (!borrows) return { sources: new Map(), childrenOf }
  if (parentProductIds.length > 0) {
    const parents = new Set(parentProductIds)
    const descendants = await db.product.findMany({
      where: { isParent: false, OR: [{ parentId: { in: parentProductIds } }, { parent: { parentId: { in: parentProductIds } } }] },
      select: { id: true, parentId: true, parent: { select: { parentId: true } } },
    })
    for (const d of descendants) {
      const topId = d.parentId && parents.has(d.parentId) ? d.parentId : d.parent?.parentId ?? null
      if (topId) childrenOf.set(topId, [...(childrenOf.get(topId) ?? []), d.id])
    }
  }
  const sources = await loadPoolSources(db, [...pageProductIds, ...[...childrenOf.values()].flat()], { borrows })
  return { sources, childrenOf }
}

/**
 * Shared stock step 7 — the stock page's cards and its "stockout risk" list judged every product by its own
 * shelf. A product that sells from a pool has none in the borrowing business, so the page counted it as a
 * stockout and told the business to restock urgently while its listings sold the pool's units. The state of
 * a pooled product is judged by the pool's free units; with no pool behind it right now (a paused lender),
 * by its own total, which is what its listings then show.
 */
export function unitsForState(productId: string, ownTotal: number, pools: Map<string, PoolSource>): number {
  return pools.get(productId)?.available ?? ownTotal
}

export interface PooledRisk {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  /** The units its state is judged by (unitsForState). */
  totalStock: number
  lowStockThreshold: number
  costPrice: Prisma.Decimal | null
  images: Array<{ url: string }>
  /** The lender, when the number is the pool's. */
  poolLenderName: string | null
}

/** Pooled products at risk (5 free units or fewer), lowest first. A business that borrows nothing: one count. */
export async function pooledStockRisk(db: Db, limit: number): Promise<PooledRisk[]> {
  if (!(await borrowsStock(db))) return []
  const pooled = await db.product.findMany({
    where: { isParent: false, status: { not: 'INACTIVE' }, stockPoolLinks: { some: { status: 'active' } } },
    select: { id: true, sku: true, name: true, amazonAsin: true, totalStock: true, lowStockThreshold: true, costPrice: true, images: { select: { url: true }, take: 1 } },
  })
  const sources = await loadPoolSources(db, pooled.map((p) => p.id), { borrows: true })
  return pooled
    .map(({ totalStock, ...p }) => ({ ...p, totalStock: unitsForState(p.id, totalStock, sources), poolLenderName: sources.get(p.id)?.lenderName ?? null }))
    .filter((p) => p.totalStock <= 5)
    .sort((a, b) => a.totalStock - b.totalStock || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * A parent's pooled variations, added up; null when none sells from a pool. Two lenders under one parent
 * are named together ("A, B"): the numbers are still each variation's own pool, summed for the row.
 */
export function summarizePoolSources(childIds: string[], sources: Map<string, PoolSource>): PoolSourceSummary | null {
  const pooled = childIds.map((id) => sources.get(id)).filter((s): s is PoolSource => Boolean(s))
  if (pooled.length === 0) return null
  const lenders = [...new Set(pooled.map((s) => s.lenderName))].sort()
  return {
    lenderName: lenders.join(', '),
    grantId: pooled[0].grantId,
    quantity: pooled.reduce((sum, s) => sum + s.quantity, 0),
    reserved: pooled.reduce((sum, s) => sum + s.reserved, 0),
    available: pooled.reduce((sum, s) => sum + s.available, 0),
    products: pooled.length,
  }
}

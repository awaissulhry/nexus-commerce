import prisma from '../../db.js'
import { Prisma } from '@prisma/client'
import { requireWorkspace } from '../../lib/workspace-context.js'

/**
 * Shared stock step 7b — what the lender's pool gave to its borrowers' orders, for the LENDER's reordering
 * (contract docs/2026-09-19-shared-stock-build.md §8.1).
 *
 * The doors write every pool movement in the lender's own ledger, naming the borrowing business and its order
 * (`consumerWorkspaceId`, `consumerOrderRef`), so this reads only the lender's rows. The rule is the one the
 * business's own sales follow (sales-aggregate.service.ts): per borrower order and product, the units taken
 * (ORDER_PLACED, RESERVATION_CONSUMED — a hold counts when it ships) minus the units put back for a
 * cancellation (ORDER_CANCELLED), on the UTC day of the first take; a cancelled order is no sale, and a return
 * (RETURN_RESTOCKED) does not unsell.
 *
 * Never written to DailySalesAggregate: analytics, dashboards and advertising read that table, and these sales
 * belong to the borrower.
 */

type Db = Prisma.TransactionClient | typeof prisma

/** The channel name of pool demand wherever reordering shows it beside real channels. */
export const POOL_DEMAND_CHANNEL = 'SHARED_POOL'

export interface PoolDemandDay {
  sku: string
  borrowerWorkspaceId: string
  /** UTC day, YYYY-MM-DD. */
  day: string
  units: number
}

export async function lenderPoolDemand(db: Db, args: { since: Date; until?: Date; skus?: string[]; borrowerWorkspaceId?: string }): Promise<PoolDemandDay[]> {
  if (args.skus && args.skus.length === 0) return []
  const rows = await db.$queryRaw<Array<{ sku: string; borrower: string; day: Date; units: number }>>`
    WITH per_order AS (
      SELECT m."productId", m."consumerWorkspaceId" AS borrower, m."consumerOrderRef" AS ref,
        min(m."createdAt") FILTER (WHERE m.reason IN ('ORDER_PLACED', 'RESERVATION_CONSUMED') AND m.change < 0) AS sold_at,
        sum(CASE WHEN m.reason IN ('ORDER_PLACED', 'RESERVATION_CONSUMED') AND m.change < 0 THEN -m.change
                 WHEN m.reason = 'ORDER_CANCELLED' AND m.change > 0 THEN -m.change
                 ELSE 0 END)::int AS units
      FROM "StockMovement" m
      WHERE m."consumerWorkspaceId" IS NOT NULL AND m."consumerOrderRef" IS NOT NULL
        AND m."createdAt" >= ${args.since}
        ${args.borrowerWorkspaceId ? Prisma.sql`AND m."consumerWorkspaceId" = ${args.borrowerWorkspaceId}` : Prisma.empty}
      GROUP BY 1, 2, 3
    )
    SELECT p.sku, o.borrower, o.sold_at::date AS day, sum(o.units)::int AS units
    FROM per_order o JOIN "Product" p ON p.id = o."productId"
    WHERE o.sold_at IS NOT NULL AND o.units > 0
      ${args.until ? Prisma.sql`AND o.sold_at < ${args.until}` : Prisma.empty}
      ${args.skus ? Prisma.sql`AND p.sku = ANY(${args.skus})` : Prisma.empty}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`
  return rows.map((r) => ({ sku: r.sku, borrowerWorkspaceId: r.borrower, day: r.day.toISOString().slice(0, 10), units: r.units }))
}

export interface LenderBorrower {
  name: string
  /** The warehouses this lender lends to that business (its live grant, else its latest). */
  locationIds: string[]
}

/** The businesses this lender lends to, by id, from its own grants. */
export async function lenderBorrowers(db: Db): Promise<Map<string, LenderBorrower>> {
  const { workspaceId: lender } = requireWorkspace()
  const grants = await db.stockPoolGrant.findMany({
    where: { ownerWorkspaceId: lender },
    select: { workspaceId: true, status: true, locationIds: true, updatedAt: true, workspace: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  const live = (status: string) => status === 'active' || status === 'paused'
  const out = new Map<string, LenderBorrower>()
  for (const g of [...grants.filter((x) => live(x.status)), ...grants.filter((x) => !live(x.status))]) {
    if (!out.has(g.workspaceId)) out.set(g.workspaceId, { name: g.workspace.name, locationIds: g.locationIds })
  }
  return out
}

/** A pool demand row's stock on the reorder page: the lender's free units in the warehouses it lends that borrower. */
export function poolCoverStock(byLocation: Array<{ locationId: string; locationCode: string; available: number }>, locationIds: string[]) {
  const lent = byLocation.filter((row) => locationIds.includes(row.locationId))
  return {
    locationId: null,
    locationCode: lent.map((row) => row.locationCode).join(', ') || null,
    available: lent.reduce((sum, row) => sum + row.available, 0),
    source: 'SHARED_POOL' as const,
  }
}

/** This business's products that sell from a pool right now, with the lenders' names (the borrower's side). */
export async function pooledProductIds(db: Db, productIds?: string[]): Promise<{ ids: Set<string>; lenders: string[] }> {
  const links = await db.stockPoolLink.findMany({
    where: { status: 'active', ...(productIds ? { productId: { in: productIds } } : {}) },
    select: { productId: true, grant: { select: { ownerWorkspace: { select: { name: true } } } } },
  })
  return { ids: new Set(links.map((l) => l.productId)), lenders: [...new Set(links.map((l) => l.grant.ownerWorkspace.name))].sort() }
}

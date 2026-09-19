import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { requireWorkspace } from '../../lib/workspace-context.js'

/**
 * Shared stock plan step 5 — "who sold what" on the LENDER's stock pages (plan §7 step 5; research §7:
 * "In the owner profile, sales split by profile").
 *
 * A door that takes, holds or puts back pool stock writes the movement and the hold in the LENDER's own
 * ledger, with the business that used the units (`consumerWorkspaceId`) and its order reference
 * (`consumerOrderRef`). This reads them back for the lender: per borrowing business, what it holds for
 * open orders now and what it sold (and put back) in the last 30 days. The lender names its borrowers
 * through its own grants. A business that lends nothing pays one indexed count.
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface LentUsage {
  workspaceId: string
  businessName: string
  /** Units held for this business's open orders right now. */
  heldNow: number
  /** Units taken for this business's sales in the last 30 days. */
  sold30d: number
  /** Units put back for it (cancelled sales, returns) in the last 30 days. */
  putBack30d: number
}

export interface LentUsageView {
  usage: LentUsage[]
  /** Borrowing business names, for movement rows that name a business by id. */
  names: Map<string, string>
}

const DAY = 24 * 3600_000

export async function lentUsage(db: Db, productIds: string[]): Promise<LentUsageView> {
  const empty: LentUsageView = { usage: [], names: new Map() }
  const ids = [...new Set(productIds.filter(Boolean))]
  if (!ids.length) return empty
  // Grants this business made as the lender (it may borrow too: those rows name it as the borrower).
  const { workspaceId: lender } = requireWorkspace()
  const lent = await db.stockPoolGrant.findMany({ where: { ownerWorkspaceId: lender }, select: { workspaceId: true, workspace: { select: { name: true } } } })
  if (!lent.length) return empty
  const names = new Map(lent.map((grant) => [grant.workspaceId, grant.workspace.name]))

  const holds = await db.stockReservation.findMany({
    where: { consumerWorkspaceId: { not: null }, releasedAt: null, consumedAt: null, stockLevel: { productId: { in: ids } } },
    select: { consumerWorkspaceId: true, quantity: true },
  })
  const movements = await db.stockMovement.findMany({
    where: { productId: { in: ids }, consumerWorkspaceId: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * DAY) } },
    select: { consumerWorkspaceId: true, change: true },
  })

  const by = new Map<string, LentUsage>()
  const row = (workspaceId: string) => {
    let entry = by.get(workspaceId)
    if (!entry) {
      entry = { workspaceId, businessName: names.get(workspaceId) ?? 'another business', heldNow: 0, sold30d: 0, putBack30d: 0 }
      by.set(workspaceId, entry)
    }
    return entry
  }
  for (const hold of holds) row(hold.consumerWorkspaceId!).heldNow += hold.quantity
  for (const movement of movements) {
    if (movement.change < 0) row(movement.consumerWorkspaceId!).sold30d += -movement.change
    else row(movement.consumerWorkspaceId!).putBack30d += movement.change
  }
  return { usage: [...by.values()].sort((a, b) => a.businessName.localeCompare(b.businessName)), names }
}

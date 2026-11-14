import type { Prisma } from '@nexus/factory-db'
import { majorOf } from '@nexus/factory-domain/costing/landed/rules'
import type { KeyBalance } from '@nexus/factory-domain/costing/valuation/rules'
import { unique, type Reader } from '../actual/store'

/**
 * The lots' cost moves with their landed cost (B-W2b-407; FIN-044): a POSTED share is part of its lot's cost from its
 * posting until it is reversed. Two readers, so the stock ledger and the stock valuation agree:
 *
 *   landedForLotCost   the landed value standing on each lot now, for the cost of stock leaving a lot
 *                      (inventory/ledger post-moves valueMovesInCommand: lotUnitCostWithLanded)
 *   withLanded         the stock valuation's balances with the landed value standing on each lot at the date added to
 *                      the lot's first key (the rows roll a lot's keys into one: valuationRows)
 * A share in another currency than the lot's valuation is never added (an allocation is refused in another currency).
 */

/** The shares standing at `at` (null: now): POSTED by then and not reversed by then. */
function standingWhere(at: Date | null): Prisma.LandedCostShareWhereInput {
  if (at === null) return { allocation: { status: 'POSTED' } }
  return { allocation: { status: { in: ['POSTED', 'REVERSED'] }, postedAt: { lte: at }, OR: [{ reversedAt: null }, { reversedAt: { gt: at } }] } }
}

interface Standing {
  readonly amount: number
  readonly currency: string
}

/** Σ the standing shares per `<siteId>|<lotId>`, in minor units of their allocation's currency. */
async function standing(db: Reader, lotIds: readonly string[], at: Date | null): Promise<Map<string, Standing>> {
  const out = new Map<string, Standing>()
  if (lotIds.length === 0) return out
  const shares = await db.landedCostShare.findMany({ where: { AND: [{ lotId: { in: [...lotIds] } }, standingWhere(at)] }, select: { siteId: true, lotId: true, amount: true, allocationId: true } })
  if (shares.length === 0) return out
  const currencies = new Map((await db.landedCostAllocation.findMany({ where: { id: { in: unique(shares.map((row) => row.allocationId)) } }, select: { id: true, currency: true } })).map((row) => [row.id, row.currency]))
  for (const share of shares) {
    const key = `${share.siteId}|${share.lotId}`
    const currency = currencies.get(share.allocationId) ?? ''
    const seen = out.get(key)
    if (seen && seen.currency !== currency) continue
    out.set(key, { amount: (seen?.amount ?? 0) + share.amount, currency })
  }
  return out
}

/**
 * The landed value standing on lots now, in major units of the valuation's currency: `(siteId, lotId, currency)` → the
 * value, or null (none, or in another currency).
 */
export async function landedForLotCost(db: Reader, lotIds: readonly string[]): Promise<(siteId: string, lotId: string, currency: string) => string | null> {
  const found = await standing(db, lotIds, null)
  return (siteId, lotId, currency) => {
    const row = found.get(`${siteId}|${lotId}`)
    return row && row.currency === currency && row.amount !== 0 ? majorOf(row.amount, currency) : null
  }
}

/** The balances with each lot's standing landed value added to its first key, and how many lots took one. */
export async function withLanded(db: Reader, balances: readonly KeyBalance[], at: Date | null): Promise<{ balances: KeyBalance[]; lots: number }> {
  const found = await standing(db, unique(balances.map((row) => row.lotId)), at)
  if (found.size === 0) return { balances: [...balances], lots: 0 }
  const done = new Set<string>()
  const out = balances.map((row) => {
    const key = `${row.siteId}|${row.lotId}`
    const landed = row.lotId ? found.get(key) : undefined
    if (!landed || done.has(key) || (row.currencies.length > 0 && !row.currencies.includes(landed.currency))) return row
    done.add(key)
    return { ...row, value: row.value + landed.amount, currencies: row.currencies.length > 0 ? row.currencies : [landed.currency] }
  })
  return { balances: out, lots: done.size }
}

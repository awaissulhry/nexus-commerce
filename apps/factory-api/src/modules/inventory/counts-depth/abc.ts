import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ABC_RULES, abcClassesOf, type Classified } from '@nexus/factory-domain/inventory/counts-depth/abc'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, siteFor } from '../ledger/access'
import type { Db } from './store'

/**
 * The ABC class of a site's materials (B-W2b-299; SCM-227; factory-domain inventory/counts-depth/abc): every material that
 * moved at the site, ranked by the value it was issued at over the last year (the ledger's valuations of its ISSUE moves; a
 * material issued without a valuation at its standard cost). Read on demand, never stored: a class follows the use.
 *
 *   GET /inventory/count-schedules/abc?siteId   the classes (inventory.counts.view at the site); the share of the value only
 *                                               with the cost grain
 */

const DAY_MS = 86_400_000

export async function classesOfSite(db: Db, siteId: string, now: Date): Promise<Classified[]> {
  const since = new Date(now.getTime() - ABC_RULES.days * DAY_MS)
  const moved = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId } })
  const valued = await db.stockValuation.groupBy({ by: ['itemId'], where: { siteId, move: { reason: 'ISSUE', occurredAt: { gte: since }, reversalOfId: null } }, _sum: { valueAmount: true } })
  const issued = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId, reason: 'ISSUE', occurredAt: { gte: since }, reversalOfId: null }, _sum: { baseQuantity: true } })
  const ids = [...new Set([...moved.map((row) => row.itemId), ...issued.map((row) => row.itemId)])]
  const items = ids.length === 0 ? [] : await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, standardCost: true } })
  const value = new Map(valued.map((row) => [row.itemId, new Dec(Math.abs(row._sum.valueAmount ?? 0)).dividedBy(100)]))
  const quantity = new Map(issued.map((row) => [row.itemId, new Dec(row._sum.baseQuantity?.toString() ?? '0')]))
  return abcClassesOf(
    items.map((item) => {
      const fromLedger = value.get(item.id)
      const fallback = item.standardCost !== null ? (quantity.get(item.id) ?? ZERO).times(item.standardCost.toString()) : ZERO
      return { itemId: item.id, code: item.code, value: fromLedger && !fromLedger.isZero() ? fromLedger : fallback }
    }),
  )
}

/** GET /inventory/count-schedules/abc */
export async function abcOfSite(caller: CommandCaller, query: { readonly siteId: string }, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_COUNTS_VIEW, 'siteId')
  const withCost = heldGrains(actorOf(context)).has('cost')
  return caller.withClient(async (db) => {
    const classes = await classesOfSite(db, site.id, now)
    const items = new Map((await db.item.findMany({ where: { id: { in: classes.map((entry) => entry.itemId) } }, select: { id: true, code: true, name: true, kind: true } })).map((item) => [item.id, item]))
    const counts = { A: 0, B: 0, C: 0 }
    for (const entry of classes) counts[entry.abcClass] += 1
    return {
      siteId: site.id,
      days: ABC_RULES.days,
      rules: { aPercent: ABC_RULES.aPercent, bPercent: ABC_RULES.bPercent },
      materials: classes.map((entry) => {
        const item = items.get(entry.itemId)!
        return { item: { id: item.id, code: item.code, name: item.name, kind: item.kind as string }, abcClass: entry.abcClass, rank: entry.rank, ...(withCost ? { sharePercent: entry.sharePercent } : {}) }
      }),
      counts,
    }
  })
}

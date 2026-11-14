import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDayRange, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { CLOSE_WAITS } from '@nexus/factory-domain/costing/close/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type { VariancesQuery } from '@nexus/factory-domain/costing/variances/contracts'
import type { VarianceCategory } from '@nexus/factory-domain/costing/variances/split'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { textOrNull, unique } from '../actual/store'
import { itemsOf, VARIANCE_COLUMNS } from '../close/views'
import { actualSettingsOf } from '../ppv/settings'

/**
 * GET /costing/variances (B-W2b-411; FIN-030): the variance lines of the work orders' closes the caller may see
 * (costing.view over each line's company and site), newest close first, in pages; filters by company, site, work order,
 * category, the days of the closes, and whether the close still stands. The totals run over every line the filters find.
 * Per work order and category, never per person.
 */
export async function listVariances(caller: CommandCaller, query: VariancesQuery) {
  const actor = actorOf(contextOf(caller))
  const where: Prisma.WorkOrderVarianceWhereInput = {
    AND: [
      scopeWhere(actor, COSTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderVarianceWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.category && query.category.length > 0 ? { category: { in: [...query.category] } } : {},
      query.live ? { close: { undoneAt: null } } : {},
      query.from ? { close: { closedAt: { gte: businessDayStart(query.from) } } } : {},
      query.to ? { close: { closedAt: { lt: businessDayRange(query.to).end } } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.workOrderVariance.findMany({ where: { AND: [where, query.cursor ? { id: { lt: query.cursor } } : {}] }, select: VARIANCE_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const closes = new Map((await db.workOrderClose.findMany({ where: { id: { in: unique(page.map((row) => row.closeId)) } }, select: { id: true, closedAt: true, undoneAt: true } })).map((row) => [row.id, row]))
    const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(page.map((row) => row.workOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
    const items = await itemsOf(db, page.map((row) => row.itemId))
    const totals = await db.workOrderVariance.groupBy({ by: ['currency', 'category'], where, _sum: { amount: true }, _count: { _all: true }, orderBy: [{ currency: 'asc' }, { category: 'asc' }] })
    const waits = query.companyId ? ((await actualSettingsOf(db, query.companyId)).postingsOn ? null : CLOSE_WAITS) : null
    return {
      rows: page.map((row) => {
        const close = closes.get(row.closeId)!
        const item = row.itemId ? items.get(row.itemId) : undefined
        return {
          id: row.id,
          closeId: row.closeId,
          workOrder: orders.get(row.workOrderId) ?? { id: row.workOrderId, number: '' },
          companyId: row.companyId,
          siteId: row.siteId,
          category: row.category as VarianceCategory,
          item: item ? { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom as never } : null,
          standardQuantity: textOrNull(row.standardQuantity),
          actualQuantity: textOrNull(row.actualQuantity),
          standardUnitCost: asMoney('cost', textOrNull(row.standardUnitCost)),
          actualUnitCost: asMoney('cost', textOrNull(row.actualUnitCost)),
          amount: asMoney('cost', row.amount),
          currency: row.currency,
          closedAt: toUtcIso(close.closedAt),
          live: close.undoneAt === null,
          note: row.note,
        }
      }),
      totals: totals.map((row) => ({ currency: row.currency, category: row.category as VarianceCategory, lines: row._count._all, amount: asMoney('cost', row._sum.amount ?? 0) })),
      nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
      waits,
    }
  })
}

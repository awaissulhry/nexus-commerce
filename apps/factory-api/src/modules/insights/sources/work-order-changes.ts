import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { workOrderChangeWords } from '@nexus/factory-domain/insights/words'
import { CHANGE_WORDS, type ChangeCell, type ExtraPieces } from '@nexus/factory-domain/order-apply/rules'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { reachesWorkOrder, workOrderWhere } from '../../production/work-orders/scope'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * Work-order changes waiting for a person (B-SA-044; sales page plan R1, P5 "one engine, more doors"; review F-8, C-11): a PROPOSED
 * WorkOrderChange — the gap an accepted change of a sales order (B-SA-042) or an office's own change left on one of its work orders
 * (modules/production/work-order-changes) — for the people who may apply it: workorders.manage over its work order (its company,
 * site and customer; insights/attention's act), a new DRAFT's over the order's company and customer. Read through workorders.view in
 * the viewer's own customer scope (B-PR-03's wall, null-safe: a mixed work order made before the one-customer rule only for people
 * of every customer); a person limited to another customer reads no row and no count. A proposal is not an approval (rule 42): its
 * proposer may apply it, so nobody is left out by `notBy`. The row opens the work order (its band notice carries the change; a new
 * DRAFT's opens the order). Oldest first; a change that leaves extra pieces is urgent.
 */
export const workOrderChanges: Source = async ({ caller, viewer, all }) => {
  const own = scopeWhere(viewer.actor, WORKORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.WorkOrderChangeWhereInput
  const where: Prisma.WorkOrderChangeWhereInput = {
    AND: [{ status: 'PROPOSED' }, { OR: [{ workOrder: { is: workOrderWhere(viewer.actor, WORKORDERS_VIEW) } }, { AND: [{ workOrderId: null }, own] }] }],
  }
  return caller.withClient(async (db) => {
    const found = await db.workOrderChange.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...(all ? {} : { take: SOURCE_LIMIT + 1 }),
      select: {
        id: true,
        companyId: true,
        siteId: true,
        partyId: true,
        kind: true,
        cells: true,
        extra: true,
        createdAt: true,
        salesOrder: { select: { id: true, number: true } },
        workOrder: { select: { id: true, number: true, companyId: true, siteId: true, partyId: true } },
      },
    })
    const { rows: read, complete } = capped(found, all ? found.length : SOURCE_LIMIT)
    // The wall again, row by row (the filter's twin): a work order the viewer does not reach is never a row.
    const rows = read.filter((row) => (row.workOrder ? reachesWorkOrder(viewer.actor, WORKORDERS_VIEW, row.workOrder) : true))
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const cells = (Array.isArray(row.cells) ? row.cells : []) as unknown as ChangeCell[]
      const extra = (Array.isArray(row.extra) ? row.extra : []) as unknown as ExtraPieces[]
      return {
        kind: 'WORK_ORDER_CHANGE',
        state: 'PROPOSED',
        severity: extra.length > 0 ? 'HIGH' : 'MEDIUM',
        record: row.workOrder ? { type: 'WorkOrder', id: row.workOrder.id, label: row.workOrder.number } : { type: 'SalesOrder', id: row.salesOrder.id, label: row.salesOrder.number },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.workOrder ? row.workOrder.partyId : row.partyId },
        ...workOrderChangeWords({
          kind: row.kind,
          number: row.workOrder?.number ?? null,
          order: row.salesOrder.number,
          cells: CHANGE_WORDS.cells(cells),
          extra: extra.length > 0 ? extra.map((entry) => `${entry.count} ${entry.size}`).join(', ') : null,
        }),
        due: null,
        since: row.createdAt,
        // One row per change (a work order may wait on two: subKey keeps them apart).
        subKey: `change:${row.id}`,
        act: [WORKORDERS_MANAGE],
      }
    })
    return { kind: 'WORK_ORDER_CHANGE', candidates, complete }
  })
}

import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { isLocked, lockedRefusal } from '@nexus/factory-domain/product/versions/lock'
import type { StyleVersionsView } from '@nexus/factory-domain/product/versions/contracts'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, readStyleFor } from '../bom/store'
import { REVISION_COLUMNS, type Db } from './read'

/**
 * A style's revisions (B-W2b-220; PRD-166 "every style has versions with who, when and why", PRD-167 "a released version
 * is read-only"): GET /product/styles/:styleId/versions — every revision, newest first, with its change note (why), who
 * started and released it and when, its effective days, whether it is locked (in the words every write path says), and how
 * many work orders, quote lines and order lines were made from it (an order line on its own revision, else its quote line's;
 * each only when the caller's role reaches that kind of record over the style's company: null otherwise). A read.
 */

const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))

async function names(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** Count per revision of grouped rows. */
const countBy = (groups: readonly { styleRevisionId: string | null; _count: { _all: number } }[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const group of groups) if (group.styleRevisionId) out.set(group.styleRevisionId, group._count._all)
  return out
}

export async function listVersions(caller: CommandCaller, styleId: string): Promise<StyleVersionsView> {
  const style = await readStyleFor(caller, styleId)
  const actor = actorOf(contextOf(caller))
  const reaches = (permission: string) => can(actor, permission as Permission, { companyId: style.companyId })
  return caller.withClient(async (client) => {
    const rows = await client.styleRevision.findMany({ where: { styleId }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } })
    const people = await names(client, rows.flatMap((row) => [row.createdById, row.releasedById]))
    // Counts per revision, read only for the kinds the role reaches (row-level security narrows them to the caller's grants).
    let workOrders: Map<string, number> | null = null
    if (reaches('workorders.view')) {
      const groups = await client.workOrder.groupBy({ by: ['styleRevisionId'], where: { styleId }, _count: { _all: true } })
      workOrders = countBy(groups)
    }
    let quoteLines: Map<string, number> | null = null
    if (reaches('quotes.view')) {
      const groups = await client.quoteLine.groupBy({ by: ['styleRevisionId'], where: { styleId }, _count: { _all: true } })
      quoteLines = countBy(groups)
    }
    let orderLines: Map<string, number> | null = null
    if (reaches('orders.view')) {
      // An order line is on its own revision, else on its quote line's (as the drift reads it).
      const groups = await client.salesOrderLine.groupBy({ by: ['styleRevisionId'], where: { styleId, styleRevisionId: { not: null } }, _count: { _all: true } })
      orderLines = countBy(groups)
      const quoted = await client.salesOrderLine.groupBy({ by: ['quoteLineId'], where: { styleId, styleRevisionId: null, quoteLineId: { not: null } }, _count: { _all: true } })
      const quoteIds = quoted.map((group) => group.quoteLineId).filter((id): id is string => id !== null)
      const revisionOf = new Map(quoteIds.length ? (await client.quoteLine.findMany({ where: { id: { in: quoteIds } }, select: { id: true, styleRevisionId: true } })).map((row) => [row.id, row.styleRevisionId]) : [])
      for (const group of quoted) {
        const revisionId = group.quoteLineId ? revisionOf.get(group.quoteLineId) : null
        if (revisionId) orderLines.set(revisionId, (orderLines.get(revisionId) ?? 0) + group._count._all)
      }
    }
    const person = (id: string | null) => (id === null ? null : { id, name: people.get(id) ?? '—' })
    return {
      style: { id: style.id, code: style.code, name: style.name, status: style.status, companyId: style.companyId },
      current: rows.find((row) => row.status === 'RELEASED')?.id ?? null,
      revisions: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        status: row.status,
        changeNote: row.changeNote,
        createdAt: toUtcIso(row.createdAt),
        createdBy: person(row.createdById),
        releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
        releasedBy: person(row.releasedById),
        effectiveFrom: dayOf(row.effectiveFrom),
        effectiveTo: dayOf(row.effectiveTo),
        locked: isLocked(row),
        lockedReason: lockedRefusal(row),
        workOrders: workOrders ? (workOrders.get(row.id) ?? 0) : null,
        quoteLines: quoteLines ? (quoteLines.get(row.id) ?? 0) : null,
        orderLines: orderLines ? (orderLines.get(row.id) ?? 0) : null,
      })),
    }
  })
}

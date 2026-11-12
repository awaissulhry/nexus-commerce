import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { SUBSTITUTION_LIMITS, SUBSTITUTION_STATUSES, type SubstitutionStatus } from '@nexus/factory-domain/inventory/substitutions/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { mayAt, officeContextOf } from '../ledger/access'
import { readSubstitution, substitutionViews, SUBSTITUTION_COLUMNS } from './store'

/**
 * The office's reads of substitutes (B-W2b-298; design warehouse.picking pk-metrics "Substitutes waiting for approval (W2b)",
 * pk-grid master-detail "substitute"; inventory.stock.view): a site's or a work order's substitutes, newest first, with the
 * tiles (waiting for a yes, approved and not yet issued), and one substitute with its request for a yes (its history is the
 * approval engine's GET /approvals/history/MaterialSubstitution/:id). No money; who asked is "the office" or "the floor".
 */

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly status?: SubstitutionStatus | 'OPEN' | 'ALL' | undefined
  readonly limit: number
}

export async function listSubstitutions(caller: CommandCaller, query: ListQuery) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
  return caller.withClient(async (db) => {
    const orders = await db.workOrder.findMany({ where: { AND: [scope, query.siteId ? { siteId: query.siteId } : {}, query.workOrderId ? { id: query.workOrderId } : {}] }, select: { id: true } })
    const ids = orders.map((row) => row.id)
    const statuses: SubstitutionStatus[] = query.status === undefined || query.status === 'OPEN' ? ['WAITING', 'APPROVED'] : query.status === 'ALL' ? [...SUBSTITUTION_STATUSES] : [query.status]
    const where: Prisma.MaterialSubstitutionWhereInput = { workOrderId: { in: ids } }
    const limit = Math.min(query.limit, SUBSTITUTION_LIMITS.list)
    const rows = ids.length === 0 ? [] : await db.materialSubstitution.findMany({ where: { ...where, status: { in: statuses } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: SUBSTITUTION_COLUMNS })
    const counts = ids.length === 0 ? [] : await db.materialSubstitution.groupBy({ by: ['status'], where: { ...where, status: { in: ['WAITING', 'APPROVED'] } }, _count: { _all: true } })
    const count = (status: SubstitutionStatus) => counts.find((row) => row.status === status)?._count._all ?? 0
    return {
      asOf: toUtcIso(serverClock.now()),
      tiles: { waiting: count('WAITING'), approved: count('APPROVED') },
      substitutions: await substitutionViews(db, rows.slice(0, limit)),
      more: rows.length > limit,
    }
  })
}

export async function substitutionRecord(caller: CommandCaller, substitutionId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = await readSubstitution(db, substitutionId)
    const header = row ? await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { companyId: true, siteId: true } }) : null
    if (!row || !header || !mayAt(context, INVENTORY_STOCK_VIEW, header)) throw new NotFoundError('Substitute not found.')
    const [view] = await substitutionViews(db, [row])
    const task = row.approvalTaskId
      ? await db.approvalTask.findUnique({ where: { id: row.approvalTaskId }, select: { id: true, status: true, approverRoleId: true, approverUserId: true, signatureMeaning: true, dueAt: true, decidedAt: true, rejectReasonCode: true, rejectReason: true } })
      : null
    return {
      substitution: view!,
      /** The office person who asked or decided it (an id inside one record; a floor request names no one here). */
      requestedById: row.requestedById,
      decidedById: row.decidedById,
      mine: row.requestedById === context.actorId,
      request: task
        ? { id: task.id, status: task.status, approverRoleId: task.approverRoleId, approverUserId: task.approverUserId, signatureMeaning: task.signatureMeaning, dueAt: task.dueAt ? toUtcIso(task.dueAt) : null, decidedAt: task.decidedAt ? toUtcIso(task.decidedAt) : null, rejectReasonCode: task.rejectReasonCode, rejectReason: task.rejectReason }
        : null,
    }
  })
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CHANGE_WORDS, type ChangeCell, type ExtraOutcome, type ExtraPieces, type WorkOrderChangeKind, type WorkOrderChangeStatus } from '@nexus/factory-domain/order-apply/rules'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../work-orders/access'
import { reachesWorkOrder, workOrderWhere } from '../work-orders/scope'

/**
 * B-SA-041: reading work-order changes (factory-db WorkOrderChange; office only — no portal, floor or link grant). THE WALL (Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all"): a change is read by a person who reaches its order's customer with orders.view (sales: the order's "Still
 * to do") or its work order with workorders.view (production: the work order's band, Home › Approvals); a change of a mixed work
 * order made before the one-customer rule only by a person who reaches that work order (every customer: it names a work order
 * shared with another customer). It is decided (applied, declined) with workorders.manage over its work order — a new DRAFT's
 * over the order's company and customer. Anything else is not found, in the words of an unknown id.
 *
 *   GET /production/work-order-changes?salesOrderId&workOrderId&status=PROPOSED|…|ALL&limit   newest first
 *   GET /production/work-order-changes/:changeId
 */

export type Reader = FactoryClient | CommandTx

export const CHANGE_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  salesOrderId: true,
  siteId: true,
  workOrderId: true,
  requestId: true,
  amendmentId: true,
  kind: true,
  cells: true,
  extra: true,
  extraOutcome: true,
  reason: true,
  status: true,
  lastError: true,
  proposedById: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  madeWorkOrderId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.WorkOrderChangeSelect
export type ChangeRow = Prisma.WorkOrderChangeGetPayload<{ select: typeof CHANGE_COLUMNS }>

/** The work order a change names, as the wall reads it. */
export interface ChangeWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly kind: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string | null
}

export const WORK_ORDER_COLUMNS = { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, partyId: true } as const satisfies Prisma.WorkOrderSelect

/** The events the office's screens of changes listen to. */
export const LIVE_EVENTS = ['work_order_change.proposed', 'work_order_change.applied', 'work_order_change.declined', 'work_order_change.stale', 'workorder.changed', 'workorder.status_changed'] as const

/** Does the person read this change (see the file's head)? */
export function mayRead(actor: Actor, row: Pick<ChangeRow, 'companyId' | 'partyId'>, workOrder: ChangeWorkOrder | null): boolean {
  if (workOrder && workOrder.partyId === null) return reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder)
  if (can(actor, ORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId })) return true
  return workOrder ? reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) : can(actor, WORKORDERS_VIEW, { companyId: row.companyId, partyId: row.partyId })
}

/** May the person apply or decline it (workorders.manage over its work order; a new DRAFT's: the order's company and customer)? */
export function mayDecide(actor: Actor, row: Pick<ChangeRow, 'companyId' | 'partyId'>, workOrder: ChangeWorkOrder | null): boolean {
  return workOrder ? reachesWorkOrder(actor, WORKORDERS_MANAGE, workOrder) : can(actor, WORKORDERS_MANAGE, { companyId: row.companyId, partyId: row.partyId })
}

/** The changes a person reads, as a filter (the JS check `mayRead` holds the same rule row by row). */
export function readWhere(actor: Actor): Prisma.WorkOrderChangeWhereInput {
  const own = { company: 'companyId', party: 'partyId' } as const
  return {
    OR: [
      { AND: [scopeWhere(actor, ORDERS_VIEW, own) as Prisma.WorkOrderChangeWhereInput, { OR: [{ workOrderId: null }, { workOrder: { is: { partyId: { not: null } } } }] }] },
      { workOrder: { is: workOrderWhere(actor, WORKORDERS_VIEW) } },
      { AND: [{ workOrderId: null }, scopeWhere(actor, WORKORDERS_VIEW, own) as Prisma.WorkOrderChangeWhereInput] },
    ],
  }
}

export const cellsOf = (row: Pick<ChangeRow, 'cells'>): ChangeCell[] => (Array.isArray(row.cells) ? (row.cells as unknown as ChangeCell[]) : [])
export const extraOf = (row: Pick<ChangeRow, 'extra'>): ExtraPieces[] => (Array.isArray(row.extra) ? (row.extra as unknown as ExtraPieces[]) : [])

/** The views of these changes (one query per table, whatever the count), for this reader. */
export async function changeViews(db: Reader, actor: Actor, rows: readonly ChangeRow[]) {
  if (rows.length === 0) return []
  const workOrderIds = [...new Set(rows.flatMap((row) => [row.workOrderId, row.madeWorkOrderId].filter((id): id is string => id !== null)))]
  const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: WORK_ORDER_COLUMNS }) : []).map((row) => [row.id, row]))
  const orders = new Map((await db.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.salesOrderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
  const lineIds = [...new Set(rows.flatMap((row) => cellsOf(row).map((cell) => cell.salesOrderLineId)))]
  const seqOf = new Map((lineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true } }) : []).map((row) => [row.id, row.seq]))
  const people = [...new Set(rows.flatMap((row) => [row.proposedById, row.decidedById].filter((id): id is string => id !== null)))]
  const names = new Map((people.length > 0 ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const personOf = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)
  return rows.map((row) => {
    const workOrder = row.workOrderId ? (workOrders.get(row.workOrderId) ?? null) : null
    const made = row.madeWorkOrderId ? (workOrders.get(row.madeWorkOrderId) ?? null) : null
    const cells = cellsOf(row)
    return {
      id: row.id,
      status: row.status as WorkOrderChangeStatus,
      kind: row.kind as WorkOrderChangeKind,
      partyId: row.partyId,
      salesOrder: { id: row.salesOrderId, number: orders.get(row.salesOrderId)?.number ?? '' },
      workOrder: workOrder ? { id: workOrder.id, number: workOrder.number, status: workOrder.status } : null,
      requestId: row.requestId,
      amendmentId: row.amendmentId,
      cells: cells.map((cell) => ({ ...cell, lineSeq: seqOf.get(cell.salesOrderLineId) ?? null })),
      extra: extraOf(row).map((entry) => ({ ...entry, words: CHANGE_WORDS.extra(entry.count, entry.size) })),
      extraOutcome: (row.extraOutcome as ExtraOutcome | null) ?? null,
      reason: row.reason,
      lastError: row.lastError,
      proposedBy: personOf(row.proposedById),
      proposedAt: toUtcIso(row.createdAt),
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      decidedBy: personOf(row.decidedById),
      decisionNote: row.decisionNote,
      madeWorkOrder: made ? { id: made.id, number: made.number } : null,
      version: row.version,
      mayDecide: row.status === 'PROPOSED' && mayDecide(actor, row, workOrder),
      words: { title: CHANGE_WORDS.title(workOrder?.number ?? made?.number ?? null), status: CHANGE_WORDS.status(row.status as WorkOrderChangeStatus), cells: CHANGE_WORDS.cells(cells) },
    }
  })
}

/** A change the person reads (else 404 in the words of an unknown id), with its work order. */
export async function readableChange(db: Reader, actor: Actor, changeId: string): Promise<{ row: ChangeRow; workOrder: ChangeWorkOrder | null }> {
  const row = isUuid(changeId) ? await db.workOrderChange.findUnique({ where: { id: changeId }, select: CHANGE_COLUMNS }) : null
  const workOrder = row?.workOrderId ? await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: WORK_ORDER_COLUMNS }) : null
  if (!row || !mayRead(actor, row, workOrder)) throw new NotFoundError('Work order change not found.')
  return { row, workOrder }
}

export interface ListQuery {
  readonly salesOrderId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly status: WorkOrderChangeStatus | 'ALL'
  readonly limit: number
}

/** GET /production/work-order-changes (see the file's head). */
export async function listChanges(caller: CommandCaller, query: ListQuery) {
  const actor = actorOf(officeContextOf(caller))
  return caller.withClient(async (db) => {
    const filters: Prisma.WorkOrderChangeWhereInput[] = [readWhere(actor)]
    if (query.salesOrderId) filters.push({ salesOrderId: query.salesOrderId })
    if (query.workOrderId) filters.push({ workOrderId: query.workOrderId })
    if (query.status !== 'ALL') filters.push({ status: query.status })
    const rows = await db.workOrderChange.findMany({ where: { AND: filters }, select: CHANGE_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit })
    const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: WORK_ORDER_COLUMNS }) : []).map((row) => [row.id, row]))
    const kept = rows.filter((row) => mayRead(actor, row, row.workOrderId ? (workOrders.get(row.workOrderId) ?? null) : null))
    return { items: await changeViews(db, actor, kept), live: { events: [...LIVE_EVENTS] } }
  })
}

/** GET /production/work-order-changes/:changeId */
export async function getChange(caller: CommandCaller, changeId: string) {
  const actor = actorOf(officeContextOf(caller))
  return caller.withClient(async (db) => {
    const { row } = await readableChange(db, actor, changeId)
    return { change: (await changeViews(db, actor, [row]))[0]! }
  })
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, NO_ROWS, scopeWhere, type Actor, type ScopeColumns, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { cancelFeeFor } from '@nexus/factory-domain/sales/change-requests/fee'
import { officeAnswersOf, type CounterState } from '@nexus/factory-domain/sales/change-requests/counter'
import { ASK_RULES, ORDER_REQUEST_KINDS, type OrderRequestKind, type RequestStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { earliestAskOf, earliestOf, impactAskOf, impactFrom, impactLinesOf, readImpactFacts } from '../../sales/change-requests/impact'
import { officeViews } from '../../sales/change-requests/office'
import { dayOrNull, feeLinesOf, feeView, impactOut, keptImpactOf, LIVE_EVENTS, OFFICE_REQUEST_COLUMNS, readCells, readCounterStates, readCutoffs, type OfficeRequestRow, type Reader } from '../../sales/change-requests/store'
import { readLines, readOrder } from '../../sales/orders/store'
import { officeContextOf } from '../work-orders/access'
import { workOrderWhere } from '../work-orders/scope'

/**
 * B-PR-26 — the office's ONE read of every customer request (production plan §5 Home › Approvals "the one place brand requests
 * are answered": this read feeds its 'Customer request' source and review window — it is not a second answering page; lead pick
 * L26 "a batch reads as one group"; wall tests PW-H01, PW-H01b; the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well.").
 *
 *   who reads  workorders.view or orders.view over the request's company AND customer (scopeWhere over its own columns: the
 *              office's database role is walled by tenant only, so the wall is here); neither anywhere: 403; a customer filter
 *              the reader does not reach, or another customer's request: 404 in words that name nobody
 *   list       GET /production/brand-requests?status=WAITING|OPEN|COUNTERED|…|ALL&kind&partyId&orderId&batchId — every kind
 *              (change, cancel and the production asks), WAITING (OPEN + COUNTERED) oldest first, the rest newest first; the
 *              counts by status and the waiting ones by kind
 *   record     GET …/:requestId — the request, our counter-offer's approval (the customer's answer), its batch's other requests
 *   impact     GET …/:requestId/impact — the impact the customer saw at Send and the same read now (factory-domain impactOf over
 *              the customer's own freeze rules, its cells' stages and planning's date only), the order's work orders the reader
 *              sees (the others counted, never named), a cancel's fee by grain
 * Each request: the customer's own view of it (sales/change-requests requestView, our counter-offer where it stands) plus who
 * answers its kind (ASK_RULES answeredWith), where its accept goes, what accepting does, who it waits on, what this reader may
 * answer now (factory-domain officeAnswersOf + the kind's permission over the order), its batch's size.
 */

const READ_CAP = 200
const REQUEST_SCOPE: ScopeColumns = { company: 'companyId', party: 'partyId' }
/** The kinds whose accept is Sales' (/sales/change-requests/:id/accept); the others' is production's (B-PR-27a/b). */
const SALES_ACCEPTS: readonly OrderRequestKind[] = Object.freeze(['CHANGE', 'CANCEL', 'SPLIT_SHIPMENT'])
const LIVE = { events: [...LIVE_EVENTS, 'approval_request.answered', 'approval_request.expired', 'approval_request.withdrawn'] }

const isNone = (where: WhereClause): boolean => where === NO_ROWS

/** The requests the reader reaches: orders.view or workorders.view over their company and customer (null: none at all). */
export function brandRequestWhere(actor: Actor): Prisma.OrderChangeRequestWhereInput | null {
  const parts = [scopeWhere(actor, ORDERS_VIEW, REQUEST_SCOPE), scopeWhere(actor, WORKORDERS_VIEW, REQUEST_SCOPE)].filter((where) => !isNone(where))
  if (parts.length === 0) return null
  return (parts.length === 1 ? parts[0]! : { OR: parts }) as unknown as Prisma.OrderChangeRequestWhereInput
}

/** Whether the reader reaches this request (its company and customer) through either permission. */
export const readsRequest = (actor: Actor, row: { readonly companyId: string; readonly partyId: string }): boolean => can(actor, ORDERS_VIEW, row) || can(actor, WORKORDERS_VIEW, row)

/** The request the reader reaches (else 404 in words that name nobody: the wall, PW-H01b). */
export async function readableRequest(db: Reader, actor: Actor, requestId: string): Promise<OfficeRequestRow> {
  const row = isUuid(requestId) ? await db.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS }) : null
  if (!row || !readsRequest(actor, row)) throw new NotFoundError('Change request not found.')
  return row
}

const counterStateFrom = (row: Pick<OfficeRequestRow, 'counterApprovalId'>, states: ReadonlyMap<string, CounterState>): CounterState | null =>
  row.counterApprovalId ? (states.get(row.counterApprovalId) ?? 'LAPSED') : null

/** The office's views of these requests, with what this reader may answer and each batch's size (one query per table). */
export async function brandRequestViews(db: Reader, context: OfficeContext, rows: readonly OfficeRequestRow[]) {
  if (rows.length === 0) return []
  const actor = actorOf(context)
  const base = await officeViews(db, context, rows)
  const statuses = await readCounterStates(db, rows)
  const reach = brandRequestWhere(actor)
  const batchIds = [...new Set(rows.flatMap((row) => (row.batchId ? [row.batchId] : [])))]
  const batches = new Map<string, { count: number; waiting: number }>()
  if (batchIds.length > 0 && reach) {
    const grouped = await db.orderChangeRequest.groupBy({ by: ['batchId', 'status'], where: { AND: [reach, { batchId: { in: batchIds } }] }, _count: { _all: true } })
    for (const entry of grouped) {
      if (!entry.batchId) continue
      const known = batches.get(entry.batchId) ?? { count: 0, waiting: 0 }
      batches.set(entry.batchId, { count: known.count + entry._count._all, waiting: known.waiting + (entry.status === 'OPEN' ? entry._count._all : 0) })
    }
  }
  const seesPrices = heldGrains(actor).has('price')
  return rows.map((row, index) => {
    const { mayAnswer: _sales, ...view } = base[index]!
    const kind = row.kind as OrderRequestKind
    const rule = ASK_RULES[kind]
    const answers = officeAnswersOf({ kind, status: row.status as RequestStatus }, counterStateFrom(row, statuses))
    const permitted = can(actor, rule.answeredWith, { companyId: row.companyId, partyId: row.partyId })
    const batch = row.batchId ? (batches.get(row.batchId) ?? { count: 1, waiting: row.status === 'OPEN' ? 1 : 0 }) : null
    return {
      ...view,
      answeredWith: rule.answeredWith as string,
      answeredIn: SALES_ACCEPTS.includes(kind) ? ('SALES' as const) : ('PRODUCTION' as const),
      acceptWords: { it: rule.acceptWords.it, en: rule.acceptWords.en },
      waitingOn: answers.waitingOn,
      standing: { it: answers.words.it, en: answers.words.en },
      may: { accept: permitted && answers.accept, refuse: permitted && answers.refuse, counter: permitted && answers.counter, counterWithPrice: permitted && answers.counter && seesPrices },
      batch: row.batchId && batch ? { id: row.batchId, count: batch.count, waiting: batch.waiting } : null,
    }
  })
}

export type BrandRequestView = Awaited<ReturnType<typeof brandRequestViews>>[number]

export interface ListQuery {
  readonly status: 'WAITING' | RequestStatus | 'ALL'
  readonly kind?: OrderRequestKind | undefined
  readonly partyId?: string | undefined
  readonly orderId?: string | undefined
  readonly batchId?: string | undefined
  readonly limit: number
  readonly offset: number
}

const statusFilter = (status: ListQuery['status']): Prisma.OrderChangeRequestWhereInput | null =>
  status === 'ALL' ? null : status === 'WAITING' ? { status: { in: ['OPEN', 'COUNTERED'] } } : { status }

export async function listBrandRequests(caller: CommandCaller, query: ListQuery, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const reach = brandRequestWhere(actor)
  if (!reach) throw new ForbiddenError()
  if (query.partyId && !(can(actor, ORDERS_VIEW, { partyId: query.partyId }) || can(actor, WORKORDERS_VIEW, { partyId: query.partyId }))) throw new NotFoundError('Customer not found.')
  const filters: Prisma.OrderChangeRequestWhereInput[] = [reach]
  if (query.kind) filters.push({ kind: query.kind })
  if (query.partyId) filters.push({ partyId: query.partyId })
  if (query.orderId) filters.push({ orderId: query.orderId })
  if (query.batchId) filters.push({ batchId: query.batchId })
  const status = statusFilter(query.status)
  const where: Prisma.OrderChangeRequestWhereInput = { AND: status ? [...filters, status] : filters }
  return caller.withClient(async (client) => {
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const grouped = await client.orderChangeRequest.groupBy({ by: ['status'], where: { AND: filters }, _count: { _all: true } })
    const countOf = (value: string) => grouped.find((row) => row.status === value)?._count._all ?? 0
    const count = query.status === 'ALL' ? grouped.reduce((total, row) => total + row._count._all, 0) : query.status === 'WAITING' ? countOf('OPEN') + countOf('COUNTERED') : countOf(query.status)
    const byKind = await client.orderChangeRequest.groupBy({ by: ['kind'], where: { AND: [...filters, { status: { in: ['OPEN', 'COUNTERED'] } }] }, _count: { _all: true } })
    // What waits does so oldest first (the customer waits); the answered ones newest first.
    const order = query.status === 'WAITING' || query.status === 'OPEN' || query.status === 'COUNTERED' ? 'asc' : 'desc'
    const rows = await client.orderChangeRequest.findMany({ where, select: OFFICE_REQUEST_COLUMNS, orderBy: [{ createdAt: order }, { id: order }], take: Math.min(query.limit, READ_CAP), skip: query.offset })
    return {
      asOf: toUtcIso(now),
      items: await brandRequestViews(client, context, rows),
      count,
      counts: { OPEN: countOf('OPEN'), COUNTERED: countOf('COUNTERED'), ACCEPTED: countOf('ACCEPTED'), REFUSED: countOf('REFUSED'), WITHDRAWN: countOf('WITHDRAWN') },
      waitingByKind: ORDER_REQUEST_KINDS.flatMap((kind) => {
        const found = byKind.find((entry) => entry.kind === kind)?._count._all ?? 0
        return found > 0 ? [{ kind, count: found }] : []
      }),
      live: LIVE,
    }
  })
}

export async function brandRequestRecord(caller: CommandCaller, requestId: string, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  return caller.withClient(async (client) => {
    const row = await readableRequest(client, actor, requestId)
    const [request] = await brandRequestViews(client, context, [row])
    const approval = row.counterApprovalId ? await client.approvalRequest.findUnique({ where: { id: row.counterApprovalId }, select: { id: true, status: true, dueAt: true, answeredAt: true, typedName: true, answer: true } }) : null
    const reach = brandRequestWhere(actor)!
    const siblings = row.batchId ? await client.orderChangeRequest.findMany({ where: { AND: [reach, { batchId: row.batchId }, { id: { not: row.id } }] }, select: { id: true, orderId: true, status: true, version: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: READ_CAP }) : []
    const numbers = new Map((siblings.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: [...new Set(siblings.map((entry) => entry.orderId))] } }, select: { id: true, number: true } }) : []).map((entry) => [entry.id, entry.number]))
    return {
      asOf: toUtcIso(now),
      request: request!,
      counterApproval: approval ? { id: approval.id, status: approval.status as string, dueAt: toUtcIso(approval.dueAt), answeredAt: approval.answeredAt ? toUtcIso(approval.answeredAt) : null, typedName: approval.typedName, answer: approval.answer } : null,
      batch: siblings.map((entry) => ({ id: entry.id, orderId: entry.orderId, orderNumber: numbers.get(entry.orderId) ?? '', status: entry.status as RequestStatus, version: entry.version })),
      live: LIVE,
    }
  })
}

/** The office impact: what the customer saw at Send and the same read now; the order's work orders; a cancel's fee by grain. */
export async function brandRequestImpact(caller: CommandCaller, requestId: string, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  return caller.withClient(async (client: FactoryClient) => {
    const row = await readableRequest(client, actor, requestId)
    const order = await readOrder(client, row.orderId)
    if (!order) throw new NotFoundError('Change request not found.')
    const kind = row.kind as OrderRequestKind
    const lines = await readLines(client, order.id)
    const goods = lines.filter((line) => line.kind !== 'FEE')
    const cells = (await readCells(client, [row.id])).get(row.id) ?? []
    const requestedDate = dayOrNull(row.requestedDate)
    // The impact now, as the customer's Send read it (the customer's own freeze rules, its cells' stages, planning's date only).
    const ask = impactAskOf(kind, cells, { requestedDate, shipToAddressId: row.shipToAddressId })
    const reads = await readImpactFacts(client, order, goods.map((line) => line.id))
    const planning = earliestAskOf(kind, cells, requestedDate, goods.filter((line) => line.closedShortQuantity === null).map((line) => line.id))
    const earliest = planning ? await earliestOf(client, { tenantId: context.tenantId, requestId: context.requestId, order, lines: reads.lines, ask: planning, now }) : null
    const settings = await readCutoffs(client, context.tenantId, order.companyId)
    const impact = impactFrom(ask, impactLinesOf(goods, reads.stages), reads, settings.cancelFeePct, earliest)

    // The order's work orders the reader sees (by the one-customer wall); the others only counted.
    const lineIds = lines.map((line) => line.id)
    const workOrderIds = lineIds.length > 0 ? [...new Set((await client.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' } } }, select: { workOrderId: true } })).map((cell) => cell.workOrderId))] : []
    const shown = workOrderIds.length > 0 ? await client.workOrder.findMany({ where: { AND: [{ id: { in: workOrderIds } }, workOrderWhere(actor, WORKORDERS_VIEW)] }, select: { id: true, number: true, status: true, partyId: true }, orderBy: { number: 'asc' } }) : []

    return {
      asOf: toUtcIso(now),
      request: { id: row.id, kind, status: row.status as RequestStatus, version: row.version },
      kept: keptImpactOf(row.impact),
      now: impactOut(impact),
      workOrders: shown.map((workOrder) => ({ id: workOrder.id, number: workOrder.number, status: workOrder.status as string, held: workOrder.status === 'ON_HOLD', mixed: workOrder.partyId === null })),
      workOrdersNotShown: workOrderIds.length - shown.length,
      cancelFee: kind === 'CANCEL' ? feeView(cancelFeeFor(feeLinesOf(lines), cells.length > 0 ? cells.map((cell) => cell.orderLineId) : null, settings.cancelFeePct, order.currency)) : null,
      live: LIVE,
    }
  })
}

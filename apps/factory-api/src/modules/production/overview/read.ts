import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, reachesEveryParty } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { withActions } from '@nexus/factory-domain/insights/actions'
import { attentionFor, matchesScope, sourcesFor, type AttentionItem, type Viewer } from '@nexus/factory-domain/insights/attention'
import { supervisorMarkOf, type SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'
import { daysLate, OPEN_STATUSES, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDER_REQUEST_KINDS, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readActions, storedOf } from '../../insights/actions-store'
import { portalChangeRequests } from '../../insights/sources/portal-change-requests'
import { viewerOf } from '../../insights/viewer'
import { gateHoldsOf } from '../../planning/schedule/gates'
import { LIVE_EVENTS as REQUEST_LIVE_EVENTS } from '../../sales/change-requests/store'
import { workOrderCustomerUrgency } from '../brand/urgency-of'
import { brandRequestWhere } from '../brand-requests/read'
import { customerDefaultsOf, orderSupervisorsOf, workOrderSupervisorsOf } from '../supervisor/resolver'
import { officeContextOf } from '../work-orders/access'
import { customerFacts, type CustomerFact } from '../work-orders/customers'
import { decodeCursor, pageOf, riskFactsOf, riskRank, type SortKey } from '../work-orders/risk'
import { workOrderWhere } from '../work-orders/scope'
import { dayOrNull, type Reader } from '../work-orders/store'
import { progressTotalsOf } from '../work-orders/views'
import { groupId, groupOf, groupsOf, requestsByKind, stageShareOf, tallyOf, type GroupKey, type OverviewFact, type ProgressCounts, type RequestCounts } from './tally'

/**
 * B-PR-33 — Production › Overview: every customer's production on one page (production plan §1 "Production › Overview: all brands
 * on one page — waiting on us, waiting on a brand, late, at risk, blocked, work in progress by stage, brand requests to answer.
 * Every number opens the working list", §5; 06-tree A.1; 08-backend §5 "All-brands overview"; review fix R-31; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well.").
 *
 *   GET /production/overview?siteId&partyId&supervisor=me&limit&cursor   (workorders.view, `record`)
 *
 * What it reads, all of it in full (no silent cap: every open work order the reader reaches, every waiting request), computed per
 * read from what is stored, as the Work orders list computes it (so each number opens that list with its filters, F-PR-04):
 *   - the open work orders (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD — held ones included) the reader reaches: B-PR-03's wall
 *     (`workOrderWhere`): a person limited to some customers gets only those customers' work orders, rows and Total; a work order
 *     of no customer (mixed before the rule, a sample for no customer) only reaches a person of every customer — so the
 *     "Mixed customers (made before the rule)" row, the figure that mixes customers, needs every customer (B-PR-07's rule);
 *   - their risk and what their orders wait on (../work-orders/risk riskFactsOf: the keeper's BrandOrderProduction, the WORKING
 *     plan's bars, a standing raise), their gate holds (planning's gateHoldsOf), their customer urgency (B-PR-22b), their
 *     supervisor (B-PR-42a: `?supervisor=me` keeps the work orders whose supervisor — their order's own, else the customer's
 *     default — is the reader, as the list's "Mine");
 *   - the pieces of each per WIP stage (./tally): started ones through the record's own progress (work-orders views
 *     progressTotalsOf) and the bundles out at a workshop on open subcontract orders and not back;
 *   - the customers' requests that wait (OPEN or COUNTERED; B-PR-26's reach: orders.view or workorders.view over the request's
 *     company and customer) by kind and customer; and the ones THIS reader answers: the rows of Home › Approvals' 'Customer
 *     request' source (insights portal-change-requests, read in full here, matched to the reader by Today's own rule — the right
 *     to act per kind, done or snoozed rows left out), so the Customer requests tile counts exactly what Approvals shows.
 * Most urgent: the late and at-risk ones in the list's risk sort (late, at risk; by due date; the customer's urgency breaks a tie),
 * one page after the cursor with the count of all ("10 of 37 · Show all"). Read only.
 */

/** A subcontract order whose pieces are out at the workshop (the keeper's AT_WORKSHOP). */
const OUT_AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

/** The events after which the page reads again (work orders, holds, the keeper's states, customer requests). */
const LIVE_EVENTS: readonly string[] = Object.freeze([
  'workorder.created',
  'workorder.changed',
  'workorder.released',
  'workorder.status_changed',
  'work_order_hold.placed',
  'work_order_hold.lifted',
  'brand_production.stage_reached',
  'brand_production.health_changed',
  'brand_production.hold_changed',
  'brand_production.urgency_changed',
  'brand_production.supervisor_changed',
  ...REQUEST_LIVE_EVENTS,
  'approval_request.answered',
  'approval_request.expired',
  'approval_request.withdrawn',
])

export interface OverviewQuery {
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly supervisor?: 'me' | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

/** What the overview reads of each open work order. */
const OPEN_SELECT = {
  id: true,
  number: true,
  status: true,
  kind: true,
  siteId: true,
  styleId: true,
  dueDate: true,
  partyId: true,
  heldFromStatus: true,
  site: { select: { code: true, timezone: true } },
  style: { select: { code: true, name: true } },
  sizes: { select: { quantity: true, partyId: true, salesOrderLine: { select: { orderId: true } } } },
} as const satisfies Prisma.WorkOrderSelect

type OpenRow = Prisma.WorkOrderGetPayload<{ select: typeof OPEN_SELECT }>

const ordersOfRow = (row: OpenRow): string[] => [...new Set(row.sizes.flatMap((cell) => (cell.salesOrderLine ? [cell.salesOrderLine.orderId] : [])))]

/**
 * Per started work order, the pieces out at a workshop: the bundles sent on its open subcontract orders (issued, at the workshop,
 * partly received) that have not come back on that order (no receipt line of that bundle).
 */
async function atWorkshopOf(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (workOrderIds.length === 0) return out
  const sent = await db.subcontractBundle.findMany({
    where: { workOrderId: { in: [...workOrderIds] }, subcontractOrder: { is: { status: { in: [...OUT_AT_WORKSHOP] } } } },
    select: { workOrderId: true, subcontractOrderId: true, bundleId: true, quantity: true },
  })
  if (sent.length === 0) return out
  const back = await db.subcontractReceiptLine.findMany({
    where: { workOrderId: { in: [...new Set(sent.map((row) => row.workOrderId))] }, bundleId: { in: [...new Set(sent.map((row) => row.bundleId))] }, receipt: { is: { subcontractOrderId: { in: [...new Set(sent.map((row) => row.subcontractOrderId))] } } } },
    select: { bundleId: true, receipt: { select: { subcontractOrderId: true } } },
  })
  const returned = new Set(back.map((line) => `${line.receipt.subcontractOrderId}|${line.bundleId ?? ''}`))
  for (const row of sent) if (!returned.has(`${row.subcontractOrderId}|${row.bundleId}`)) out.set(row.workOrderId, (out.get(row.workOrderId) ?? 0) + row.quantity)
  return out
}

/** Of these orders, the ones the reader supervises: their own supervisor, else their customer's default (B-PR-42a). */
async function ordersSupervisedBy(db: Reader, orders: readonly { readonly orderId: string; readonly partyId: string }[], viewerId: string): Promise<Set<string>> {
  if (orders.length === 0) return new Set()
  const own = await orderSupervisorsOf(db, [...new Set(orders.map((order) => order.orderId))])
  const defaults = await customerDefaultsOf(db, [...new Set(orders.map((order) => order.partyId))])
  return new Set(orders.filter((order) => (own.get(order.orderId) ?? defaults.get(order.partyId)?.supervisorId ?? null) === viewerId).map((order) => order.orderId))
}

/**
 * The Home › Approvals rows of the 'Customer request' source this reader answers (Today's own pipeline for that one kind: the
 * source read in full, matched to the reader, inside the page's site, done and snoozed rows left out). None when the reader cannot
 * see that source at all (no orders.view anywhere).
 */
async function requestsToAnswer(caller: CommandCaller, viewer: Viewer, scope: { readonly site: { readonly id: string; readonly companyId: string } | null; readonly partyId: string | undefined }): Promise<AttentionItem[]> {
  if (!sourcesFor(viewer.actor).includes('ORDER_CHANGE_REQUEST')) return []
  const answer = await portalChangeRequests({ caller, viewer, all: true })
  const rows = attentionFor(viewer, answer.candidates).filter((item) => matchesScope(item, { site: scope.site }) && (scope.partyId === undefined || item.partyId === scope.partyId))
  const stored = await caller.withClient((db) => readActions(db, rows.map((item) => item.key)))
  return withActions(rows, new Map([...stored].map(([key, action]) => [key, storedOf(action)])), viewer.now).items
}

export async function productionOverview(caller: CommandCaller, query: OverviewQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!can(actor, WORKORDERS_VIEW)) throw new ForbiddenError()
  // A customer filter the reader does not reach: the words of an unknown customer (never says it exists).
  if (query.partyId && !can(actor, WORKORDERS_VIEW, { partyId: query.partyId })) throw new NotFoundError('Customer not found.')
  const after = decodeCursor('risk', query.cursor)
  const now = serverClock.now()
  const today: BusinessDate = businessDate(now)
  const viewer = viewerOf(caller)
  const siteId = query.siteId
  const site = siteId ? await caller.withClient((db) => db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })) : null
  if (siteId && !site) throw new NotFoundError('Site not found.')
  // Home › Approvals' rows first: its source reads with its own client (one connection runs one query at a time).
  const answerable = await requestsToAnswer(caller, viewer, { site, partyId: query.partyId })

  return caller.withClient(async (db) => {
    // ── the open work orders the reader reaches (B-PR-03), in full ──
    const where: Prisma.WorkOrderWhereInput = {
      AND: [workOrderWhere(actor, WORKORDERS_VIEW), { status: { in: [...OPEN_STATUSES] } }, siteId ? { siteId } : {}, query.partyId ? { partyId: query.partyId } : {}],
    }
    const found = await db.workOrder.findMany({ where, select: OPEN_SELECT, orderBy: { id: 'asc' } })
    // "Only mine": the work orders whose supervisor is the reader (the list's ?supervisor=me).
    const supervisors = await workOrderSupervisorsOf(
      db,
      found.map((row) => ({ id: row.id, partyId: row.partyId, orderIds: ordersOfRow(row) })),
    )
    const markOf = (workOrderId: string): SupervisorMark | null => {
      const supervisor = supervisors.get(workOrderId) ?? null
      return supervisor === null ? null : supervisorMarkOf(supervisor, context.actorId)
    }
    const rows = query.supervisor === 'me' ? found.filter((row) => markOf(row.id) === 'ME') : found
    const ids = rows.map((row) => row.id)
    const risk = await riskFactsOf(
      db,
      rows.map((row) => ({ id: row.id, status: row.status as WorkOrderStatus, dueDate: dayOrNull(row.dueDate), siteId: row.siteId, timezone: row.site.timezone })),
      today,
    )
    const gates = await gateHoldsOf(db, ids)
    const urgency = await workOrderCustomerUrgency(db, ids)
    const started = rows.filter((row) => row.status === 'IN_PROGRESS')
    const progress = new Map<string, ProgressCounts | null>()
    for (const row of started) progress.set(row.id, await progressTotalsOf(db, { id: row.id, siteId: row.siteId, styleId: row.styleId, status: row.status, heldFromStatus: row.heldFromStatus }))
    const atWorkshop = await atWorkshopOf(
      db,
      started.map((row) => row.id),
    )

    const facts: OverviewFact[] = rows.map((row) => {
      const known = risk.get(row.id)
      const pieces = row.sizes.reduce((sum, cell) => sum + cell.quantity, 0)
      const group = groupOf({ partyId: row.partyId, cellParties: row.sizes.map((cell) => cell.partyId) })
      const { share, sewingNotCounted } = stageShareOf({ status: row.status as WorkOrderStatus, pieces, progress: progress.get(row.id) ?? null, atWorkshop: atWorkshop.get(row.id) ?? 0 })
      return {
        id: row.id,
        group,
        status: row.status as WorkOrderStatus,
        pieces,
        risk: known?.risk ?? null,
        waiting: known?.waiting ?? null,
        gate: (gates.get(row.id)?.length ?? 0) > 0,
        mixed: group.kind === 'MIXED',
        customerUrgent: urgency.get(row.id)?.urgency === 'URGENT',
        share,
        sewingNotCounted,
      }
    })

    // ── the customers' requests that wait (OPEN or COUNTERED), in the reader's reach, in full ──
    const reach = brandRequestWhere(actor)
    const waitingAll = reach
      ? await db.orderChangeRequest.findMany({
          where: { AND: [reach, { status: { in: ['OPEN', 'COUNTERED'] } }, query.partyId ? { partyId: query.partyId } : {}, site ? { companyId: site.companyId } : {}] },
          select: { id: true, orderId: true, partyId: true, kind: true, status: true },
        })
      : []
    // "Only mine": the requests and Approvals rows of the orders the reader supervises.
    const mine =
      query.supervisor === 'me'
        ? await ordersSupervisedBy(
            db,
            [...waitingAll.map((entry) => ({ orderId: entry.orderId, partyId: entry.partyId })), ...answerable.flatMap((item) => (item.record.type === 'SalesOrder' && item.partyId ? [{ orderId: item.record.id, partyId: item.partyId }] : []))],
            context.actorId,
          )
        : null
    const waiting = mine === null ? waitingAll : waitingAll.filter((entry) => mine.has(entry.orderId))
    const toAnswer = mine === null ? answerable : answerable.filter((item) => item.record.type === 'SalesOrder' && mine.has(item.record.id))
    const requestsOf = (partyId: string | null): RequestCounts =>
      partyId === null
        ? { waiting: 0, toAnswer: 0 }
        : { waiting: waiting.filter((entry) => entry.partyId === partyId).length, toAnswer: toAnswer.filter((item) => item.partyId === partyId).length }

    // ── the rows: one per customer (open work or a waiting request), the mixed ones, the work of no customer; the Total ──
    const grouped = groupsOf(facts)
    const partyIds = [
      ...new Set([
        ...facts.flatMap((fact) => (fact.group.kind === 'CUSTOMER' ? [fact.group.partyId] : [])),
        ...waiting.map((entry) => entry.partyId),
        ...toAnswer.flatMap((item) => (item.partyId ? [item.partyId] : [])),
      ]),
    ]
    const names = await customerFacts(db, partyIds)
    const rowOf = (group: GroupKey | 'ALL', of: readonly OverviewFact[], requests: RequestCounts, customer: CustomerFact | null) => {
      const tally = tallyOf(of)
      return {
        kind: group === 'ALL' ? ('ALL' as const) : group.kind,
        customer,
        inProduction: { workOrders: tally.workOrders, pieces: tally.pieces },
        late: tally.late,
        atRisk: tally.atRisk,
        blocked: tally.blocked,
        waitingOn: tally.waitingOn,
        blockedBy: tally.blockedBy,
        customerUrgent: tally.customerUrgent,
        requests,
        wip: tally.wip,
      }
    }
    const customers = partyIds
      .flatMap((partyId) => {
        const customer = names.get(partyId)
        if (!customer) return []
        const group: GroupKey = { kind: 'CUSTOMER', partyId }
        return [rowOf(group, grouped.get(groupId(group))?.facts ?? [], requestsOf(partyId), customer)]
      })
      .sort((a, b) => a.customer!.name.localeCompare(b.customer!.name) || a.customer!.code.localeCompare(b.customer!.code))
    const mixedFacts = grouped.get(groupId({ kind: 'MIXED' }))?.facts ?? []
    const noCustomerFacts = grouped.get(groupId({ kind: 'NO_CUSTOMER' }))?.facts ?? []
    const overall = rowOf('ALL', facts, { waiting: waiting.length, toAnswer: toAnswer.length }, null)

    // ── Most urgent: late and at risk, in the list's risk sort, one page with the count of all ──
    const byId = new Map(rows.map((row) => [row.id, row]))
    const keyed = facts
      .filter((fact) => fact.risk?.state === 'LATE' || fact.risk?.state === 'AT_RISK')
      .map((fact) => {
        const urgent = urgency.get(fact.id)
        const key: SortKey = { rank: riskRank(fact.risk), due: dayOrNull(byId.get(fact.id)!.dueDate), id: fact.id }
        return { key: urgent?.urgency === 'URGENT' && urgent.urgentRank !== null ? { ...key, urgent: urgent.urgentRank } : key, fact }
      })
    const { page, next } = pageOf(keyed, 'risk', after, query.limit)
    const pageNames = await customerFacts(
      db,
      page.map((entry) => byId.get(entry.fact.id)!.partyId),
    )
    const items = page.map(({ fact }) => {
      const row = byId.get(fact.id)!
      const dueDate = dayOrNull(row.dueDate)
      const urgent = urgency.get(fact.id)
      return {
        id: row.id,
        number: row.number,
        status: row.status,
        kind: row.kind,
        siteId: row.siteId,
        siteCode: row.site.code,
        style: { code: row.style.code, name: row.style.name },
        partyId: row.partyId,
        customer: row.partyId ? (pageNames.get(row.partyId) ?? null) : null,
        mixedCustomers: fact.mixed,
        dueDate,
        daysLate: daysLate(row.status as WorkOrderStatus, dueDate, today),
        pieces: fact.pieces,
        risk: fact.risk!,
        waitingOn: fact.waiting ? { on: fact.waiting.on, since: fact.waiting.since ? toUtcIso(fact.waiting.since) : null } : null,
        supervisor: markOf(row.id),
        customerUrgency: urgent?.urgency ?? null,
        urgentRank: urgent?.urgentRank ?? null,
        gate: fact.gate,
      }
    })

    return {
      asOf: toUtcIso(now),
      today,
      filter: { siteId: siteId ?? null, partyId: query.partyId ?? null, supervisor: query.supervisor ?? null },
      everyCustomer: reachesEveryParty(actor, WORKORDERS_VIEW, site ? { companyId: site.companyId, siteId: site.id } : {}),
      tiles: {
        waitingOnUs: overall.waitingOn.US,
        waitingOnCustomer: overall.waitingOn.BRAND,
        waitingOnSupplier: overall.waitingOn.SUPPLIER,
        waitingOnWorkshop: overall.waitingOn.WORKSHOP,
        late: overall.late,
        atRisk: overall.atRisk,
        blocked: overall.blocked,
        customerRequests: toAnswer.length,
      },
      customers,
      mixed: mixedFacts.length > 0 ? rowOf({ kind: 'MIXED' }, mixedFacts, { waiting: 0, toAnswer: 0 }, null) : null,
      noCustomer: noCustomerFacts.length > 0 ? rowOf({ kind: 'NO_CUSTOMER' }, noCustomerFacts, { waiting: 0, toAnswer: 0 }, null) : null,
      overall,
      requests: {
        waiting: waiting.length,
        toAnswer: toAnswer.length,
        byKind: requestsByKind(
          waiting.map((entry) => ({ kind: entry.kind as OrderRequestKind, status: entry.status as string })),
          ORDER_REQUEST_KINDS,
        ),
      },
      mostUrgent: { items, count: keyed.length, nextCursor: next },
      live: { events: [...LIVE_EVENTS] },
    }
  })
}

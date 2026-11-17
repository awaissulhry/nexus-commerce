import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { customerRequestWords, type CustomerRequestKind } from '@nexus/factory-domain/insights/words'
import { ASK_RULES, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import { counterStateOf, type CounterState } from '@nexus/factory-domain/sales/change-requests/counter'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { capped, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Customers' change and cancel requests from the portal waiting for the office's answer (B-W2b-183; SAL-077, SAL-078; design
 * home.approvals "one inbox for every request that needs my yes", portal.customer.orders conn "the change request lands" in
 * the office). An OPEN request of an order the viewer sees (orders.view over its company and customer); it is the viewer's
 * when they manage that customer's orders (orders.manage: insights/attention's act). The row opens the order (its Changes
 * tab answers it: modules/sales/change-requests accept / refuse); one row per request. Oldest first: the customer waits.
 *
 * B-PR-26 (production plan §5 "Home › Approvals: the one place brand requests are answered", the 'Customer request' source;
 * lead pick L26 "the office sees one group in Approvals"; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): every
 * kind a customer asks, routed to the people who answer it — the row's own act permission is its kind's (factory-domain
 * ASK_RULES answeredWith: CHANGE, CANCEL, SPLIT_SHIPMENT orders.manage; RUSH, HOLD, RESUME production.brand.manage; SAMPLE_ROUND
 * sales.samples.manage), over the order's company and customer; a customer's batch (one batchId: one customer, one kind) is ONE
 * row (its oldest request's order, `subKey` batch:<id>, the count in the words; the review window lists the orders with
 * GET /production/brand-requests?batchId); a request we countered comes back once the customer said yes (accept it to carry it
 * out) or our counter lapsed (answer it). Read through orders.view in the viewer's own customer scope: a person limited to some
 * customers sees only theirs (PW-H01).
 */
export const portalChangeRequests: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.OrderChangeRequestWhereInput
  return caller.withClient(async (db) => {
    const found = await db.orderChangeRequest.findMany({
      where: { AND: [scope, { status: { in: ['OPEN', 'COUNTERED'] } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, companyId: true, partyId: true, orderId: true, kind: true, status: true, batchId: true, requestedDate: true, counterApprovalId: true, createdAt: true, counteredAt: true },
    })
    const { rows: read, complete } = capped(found, SOURCE_LIMIT)
    // A countered request waits on the customer while its counter is open; it waits on us again once they said yes or it lapsed.
    const counterIds = read.flatMap((row) => (row.counterApprovalId ? [row.counterApprovalId] : []))
    const counters = new Map((counterIds.length > 0 ? await db.approvalRequest.findMany({ where: { id: { in: counterIds } }, select: { id: true, status: true, answeredAt: true, updatedAt: true } }) : []).map((row) => [row.id, row]))
    const stateOf = (row: (typeof read)[number]): 'ASKED' | CounterState => {
      if (row.status === 'OPEN') return 'ASKED'
      const counter = row.counterApprovalId ? counters.get(row.counterApprovalId) : undefined
      return counter ? (counterStateOf(counter.status) ?? 'LAPSED') : 'LAPSED'
    }
    const rows = read.filter((row) => {
      const state = stateOf(row)
      return state === 'ASKED' || state === 'AGREED' || state === 'LAPSED'
    })
    const ids = rows.map((row) => row.id)
    const orders = new Map((rows.length > 0 ? await db.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.orderId))] } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const cells = ids.length > 0 ? await db.orderChangeRequestLine.findMany({ where: { requestId: { in: ids } }, select: { requestId: true, orderLineId: true, size: true } }) : []
    const names = await partyNames(db, rows.map((row) => row.partyId))

    // One row per request, but one per batch for the open asks of a batch (the oldest request's order names the row).
    const batches = new Map<string, (typeof rows)[number][]>()
    for (const row of rows) if (row.batchId && row.status === 'OPEN') batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row])
    const candidates: AttentionCandidate[] = []
    const told = new Set<string>()
    for (const row of rows) {
      const kind = row.kind as OrderRequestKind
      const customer = names.get(row.partyId) ?? 'The customer'
      const number = orders.get(row.orderId) ?? 'an order'
      const group = row.batchId && row.status === 'OPEN' ? (batches.get(row.batchId) ?? [row]) : null
      if (group && group.length > 1) {
        if (told.has(row.batchId!)) continue
        told.add(row.batchId!)
      }
      const state = stateOf(row) as 'ASKED' | 'AGREED' | 'LAPSED'
      const own = cells.filter((cell) => cell.requestId === row.id)
      const counter = row.counterApprovalId ? counters.get(row.counterApprovalId) : undefined
      candidates.push({
        kind: 'ORDER_CHANGE_REQUEST',
        // The kind asked, or where our counter-offer stands (AGREED: accept it to carry it out; LAPSED: answer it).
        state: state === 'ASKED' ? kind : `COUNTER_${state}`,
        severity: 'MEDIUM',
        record: { type: 'SalesOrder', id: row.orderId, label: number },
        scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
        ...customerRequestWords({ number, customer, kind: kind as CustomerRequestKind, state, sizes: own.filter((cell) => cell.size !== null).length, lines: new Set(own.map((cell) => cell.orderLineId)).size, count: group && group.length > 1 ? group.length : undefined, needBy: row.requestedDate ? row.requestedDate.toISOString().slice(0, 10) : null }),
        // Each kind goes to the people who answer it (plan §3).
        act: [ASK_RULES[kind].answeredWith],
        due: null,
        // Since when it waits on us: the ask, or the customer's answer to our counter-offer (its expiry).
        since: state === 'ASKED' ? row.createdAt : (counter?.answeredAt ?? counter?.updatedAt ?? row.counteredAt ?? row.createdAt),
        // One row per request, or per batch (an order has at most one request of a kind waiting).
        subKey: group && group.length > 1 ? `batch:${row.batchId}` : row.id,
        ...(group && group.length > 1 ? { condition: group.map((entry) => entry.id).sort() } : {}),
      })
    }
    return { kind: 'ORDER_CHANGE_REQUEST', candidates, complete }
  })
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { customerUrgencyChipWords } from '@nexus/factory-domain/production-brand/words'
// F-PR-18: the Work orders column's four states (Urgent n / Urgent – asked / Regular / Set to regular by us).
import { customerUrgencyStateOf, type CustomerUrgencyState } from '@nexus/factory-domain/production-brand/urgency-state'
import type { CommandTx } from '../../../core/command'
import type { CustomerUrgencySource } from '../../sales/orders/customer-urgency'

/**
 * B-PR-22b — the customer's urgency as the office's other reads see it (production plan §3 "Customer urgency", §5 "Customer
 * urgency" column and the board's chip; agreement T10 with the threads lane; review fix R-46): read-only, and only the urgency
 * that COUNTS — the order still in production (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED) and its customer's urgency
 * switch on (switched off, the marks are kept but count for nothing: none is shown). An order with no production state yet, or of
 * a customer with the switch off, has none.
 *
 *   customerUrgencyOf          each order's urgency, by order id: Sales › Orders' read-only column (threads' hook
 *                              `useCustomerUrgency`, registered in modules/sales/orders/customer-urgency.ts) — `customerUrgencySource`
 *   workOrderCustomerUrgency   each work order's (its orders': Urgent with the best place in its customer's own list when one of
 *                              them is Urgent, else Regular): the Work orders list's column and the risk sort's tie, the board's chip
 *
 * This file imports nothing of the API but types (Sales › Orders registers it when that module loads, in every process); the
 * callers wall the rows they ask about (the list, the board, the order list read only what the reader reaches).
 */

type Reader = FactoryClient | CommandTx

/** The orders still in production (the keeper's set, modules/production/brand/facts KEEPER_ORDER_STATES). */
const IN_PRODUCTION = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

/** An order's (or a work order's) urgency that counts now: Urgent with its place in the customer's own list, or Regular. */
export interface CountedUrgency {
  readonly urgency: BrandUrgency
  /** Its place in its customer's OWN Urgent list (1 first); null when Regular. Never a place in our plan. */
  readonly urgentRank: number | null
  /** F-PR-18: its Regular mark is ours (set back to Regular by us, or locked by us): "Set to regular by us". */
  readonly setByUs?: boolean
}

/** The counted urgency of these orders (an order absent: none counts). */
export async function countedUrgencyOf(db: Reader, orderIds: readonly string[]): Promise<Map<string, CountedUrgency>> {
  const out = new Map<string, CountedUrgency>()
  const wanted = [...new Set(orderIds)]
  if (wanted.length === 0) return out
  const rows = await db.brandOrderProduction.findMany({
    where: { salesOrderId: { in: wanted }, salesOrder: { status: { in: [...IN_PRODUCTION] } } },
    select: { salesOrderId: true, partyId: true, key: true, urgency: true, urgentRank: true, /* F-PR-18 */ urgencySetBy: true, urgencyLocked: true },
  })
  const own = rows.filter((row) => row.key === `brand-production:${row.salesOrderId}`)
  const parties = [...new Set(own.map((row) => row.partyId))]
  const settings = parties.length === 0 ? [] : await db.portalSettings.findMany({ where: { id: { in: parties } }, select: { id: true, partyId: true, productionUrgencyOn: true } })
  const on = new Set(settings.filter((row) => row.id === row.partyId && row.productionUrgencyOn).map((row) => row.partyId))
  for (const row of own) {
    if (!on.has(row.partyId)) continue
    const urgency = row.urgency as BrandUrgency
    out.set(row.salesOrderId, { urgency, urgentRank: urgency === 'URGENT' ? row.urgentRank : null, /* F-PR-18 */ setByUs: row.urgencySetBy === 'FACTORY' || row.urgencyLocked })
  }
  return out
}

/** Each order's customer urgency (threads T10: Sales › Orders' read-only column; an order absent: none). */
export async function customerUrgencyOf(db: Reader, orderIds: readonly string[]): Promise<Map<string, BrandUrgency>> {
  return new Map([...(await countedUrgencyOf(db, orderIds))].map(([orderId, counted]) => [orderId, counted.urgency]))
}

/** The orders of one customer urgency that counts, as a filter of SalesOrder (the same rows as `customerUrgencyOf` names). */
export function customerUrgencyWhereOf(urgency: BrandUrgency): Prisma.SalesOrderWhereInput {
  return {
    status: { in: [...IN_PRODUCTION] },
    brandProductions: { some: { urgency } },
    party: { portalSettings: { some: { productionUrgencyOn: true } } },
  }
}

/** The production lane's reader for threads' hook (modules/sales/orders/customer-urgency.ts `useCustomerUrgency`). */
export const customerUrgencySource: CustomerUrgencySource = { of: customerUrgencyOf, where: customerUrgencyWhereOf }

/** A work order's customer urgency with the board's chip words ("Customer urgency: Urgent 2"; null for Regular). */
export interface WorkOrderUrgency extends CountedUrgency {
  readonly chip: Words | null
  /** F-PR-18: the Work orders column's state — URGENT, ASKED ("Urgent – asked" waits on one of its orders), REGULAR, SET_BACK (ours). */
  readonly state: CustomerUrgencyState
}

/**
 * Each work order's customer urgency (its cells' orders; one customer per work order, B-PR-01): Urgent with the best place when one
 * of its orders is Urgent, else Regular when one counts; a work order of no order (or none that counts) is absent. F-PR-18: with the
 * column's state — an open "Urgent – asked" (RUSH request) on one of its orders, or a Regular mark of ours (set back or locked).
 */
export async function workOrderCustomerUrgency(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, WorkOrderUrgency>> {
  const out = new Map<string, WorkOrderUrgency>()
  const wanted = [...new Set(workOrderIds)]
  if (wanted.length === 0) return out
  const cells = await db.workOrderSize.findMany({
    where: { workOrderId: { in: wanted }, salesOrderLineId: { not: null } },
    distinct: ['workOrderId', 'salesOrderLineId'],
    select: { workOrderId: true, salesOrderLine: { select: { orderId: true } } },
  })
  const ordersOf = new Map<string, Set<string>>()
  for (const cell of cells) {
    if (!cell.salesOrderLine) continue
    ordersOf.set(cell.workOrderId, (ordersOf.get(cell.workOrderId) ?? new Set<string>()).add(cell.salesOrderLine.orderId))
  }
  const orderIds = [...new Set([...ordersOf.values()].flatMap((orders) => [...orders]))]
  const counted = await countedUrgencyOf(db, orderIds)
  // ---- F-PR-18: the orders an "Urgent – asked" waits on (an open RUSH request; only orders whose urgency counts are asked about).
  const countedIds = orderIds.filter((orderId) => counted.has(orderId))
  const asked = new Set(
    countedIds.length === 0 ? [] : (await db.orderChangeRequest.findMany({ where: { orderId: { in: countedIds }, kind: 'RUSH', status: 'OPEN' }, select: { orderId: true } })).map((row) => row.orderId),
  )
  // ---- end F-PR-18
  for (const [workOrderId, orders] of ordersOf) {
    const known = [...orders].flatMap((orderId) => {
      const urgency = counted.get(orderId)
      return urgency ? [{ orderId, ...urgency }] : []
    })
    // F-PR-18: one rule for the column's state, the chip and the risk sort's tie (factory-domain production-brand/urgency-state).
    const state = customerUrgencyStateOf(known.map((entry) => ({ urgency: entry.urgency, urgentRank: entry.urgentRank, asked: asked.has(entry.orderId), setByUs: entry.setByUs === true })))
    if (!state) continue
    if (state.state !== 'URGENT') {
      out.set(workOrderId, { urgency: 'REGULAR', urgentRank: null, chip: null, state: state.state })
      continue
    }
    out.set(workOrderId, { urgency: 'URGENT', urgentRank: state.urgentRank, chip: customerUrgencyChipWords(state.urgentRank), state: 'URGENT' })
  }
  return out
}

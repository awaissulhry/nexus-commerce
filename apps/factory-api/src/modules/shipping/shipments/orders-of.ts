import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { joinProblems, joinShipmentOf, joinVerdict, type JoinOrder, type JoinProblem, type JoinShipment, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentReference } from '@nexus/factory-domain/documents/model'
import { holdWordsAt } from '../../parties/holds/stops'
import { assertMay, mayOn, officeContextOf } from '../access'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * B-OP-040 (order page N6, lines-derived; lead pick 2): a shipment's orders are the orders of its lines. Shipment.salesOrderId
 * stays its FIRST order (the header's, the one it was made for): it is always one of them, also before any line. Every reader
 * that needs "the orders of a shipment" asks this file (`ordersOfShipment`, `orderIdsOfShipments`, `orderRefsOfShipments`),
 * and every reader that goes from an order to its shipments asks `shipmentsOfOrderWhere` (the first order, or a line of it).
 *
 * The brand wall: a line's FK carries partyId ([tenantId, partyId, salesOrderLineId] → SalesOrderLine), so a shipment's orders
 * are only ever of its own customer, for every login. Never call it as the floor: the floor reads no sales order (R-8).
 *
 * Until B-OP-047 deletes MULTI_ORDER_OFF (factory-domain shipping/shipments), no shipment carries a second order: every answer
 * here is then the first order alone, so moving a reader changes nothing visible.
 */

type Reader = FactoryClient | CommandTx

export interface ShipmentKey {
  readonly id: string
  readonly salesOrderId: string
}

/** An order as the shipping readers name it. */
export interface ShipmentOrderRef {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
  /** The customer's own running number (the portal and the tracking page name the order by it). */
  readonly customerSeq: number | null
  readonly status: string
  readonly language: string
}

const byNumber = (a: { readonly number: string; readonly id: string }, b: { readonly number: string; readonly id: string }) => a.number.localeCompare(b.number, undefined, { numeric: true }) || a.id.localeCompare(b.id)

/** The ids of each shipment's orders: its first order first, then the other orders of its lines by number. */
export async function orderIdsOfShipments(db: Reader, shipments: readonly ShipmentKey[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(shipments.map((shipment) => [shipment.id, [shipment.salesOrderId]]))
  const ids = [...out.keys()].filter(isUuid)
  if (ids.length === 0) return out
  const rows = await db.$queryRaw<{ shipmentId: string; orderId: string; number: string }[]>`
    SELECT DISTINCT sl."shipmentId"::text AS "shipmentId", l."orderId"::text AS "orderId", o.number
      FROM "ShipmentLine" sl
      JOIN "SalesOrderLine" l ON l.id = sl."salesOrderLineId"
      JOIN "SalesOrder" o ON o.id = l."orderId"
     WHERE sl."shipmentId" = ANY(${ids}::uuid[])`
  const others = new Map<string, { id: string; number: string }[]>()
  for (const row of rows) {
    if (out.get(row.shipmentId)?.[0] === row.orderId) continue
    others.set(row.shipmentId, [...(others.get(row.shipmentId) ?? []), { id: row.orderId, number: row.number }])
  }
  for (const [shipmentId, orders] of others) out.set(shipmentId, [out.get(shipmentId)![0]!, ...orders.sort(byNumber).map((order) => order.id)])
  return out
}

/** One shipment's orders: the first order first (one, while N6 is held off). */
export async function ordersOfShipment(db: Reader, shipment: ShipmentKey): Promise<string[]> {
  return (await orderIdsOfShipments(db, [shipment])).get(shipment.id)!
}

/** Each shipment's orders with what the shipping readers print of them, the first order first. */
export async function orderRefsOfShipments(db: Reader, shipments: readonly ShipmentKey[]): Promise<Map<string, ShipmentOrderRef[]>> {
  const ids = await orderIdsOfShipments(db, shipments)
  const wanted = [...new Set([...ids.values()].flat())]
  const rows = wanted.length > 0 ? await db.salesOrder.findMany({ where: { id: { in: wanted } }, select: { id: true, number: true, customerRef: true, customerSeq: true, status: true, language: true } }) : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  return new Map([...ids].map(([shipmentId, orderIds]) => [shipmentId, orderIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))]))
}

/** One shipment's orders with their numbers, the first order first. */
export async function orderRefsOfShipment(db: Reader, shipment: ShipmentKey): Promise<ShipmentOrderRef[]> {
  return (await orderRefsOfShipments(db, [shipment])).get(shipment.id) ?? []
}

/**
 * B-OP-042: the order words of a mail or a paper to the shipment's own customer: every order's number, and its POs (one
 * order: its own number and PO, as before). Never for a page that may be passed on (the tracking link names its own order).
 */
export function orderWordsOf(orders: readonly Pick<ShipmentOrderRef, 'number' | 'customerRef'>[], first: { readonly number: string; readonly customerRef: string | null } | null): { orderNumber: string | null; customerRef: string | null } {
  if (orders.length <= 1) return { orderNumber: orders[0]?.number ?? first?.number ?? null, customerRef: orders[0]?.customerRef ?? first?.customerRef ?? null }
  const refs = [...new Set(orders.flatMap((ref) => (ref.customerRef ? [ref.customerRef] : [])))]
  return { orderNumber: orders.map((ref) => ref.number).join(', '), customerRef: refs.length > 0 ? refs.join(', ') : null }
}

/** B-OP-042: an order as the shipment's papers name it (DDT, customs, proforma). */
export interface PaperOrder {
  readonly id: string
  readonly number: string
  readonly orderDate: Date
  readonly customerRef: string | null
  readonly paymentTerms: string | null
}

/** B-OP-042: every order a shipment carries as its papers name them, the first first. */
export async function paperOrdersOf(db: Reader, shipment: ShipmentKey): Promise<PaperOrder[]> {
  const ids = await ordersOfShipment(db, shipment)
  const rows = await db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, orderDate: true, customerRef: true, paymentTerms: true } })
  return ids.flatMap((id) => rows.filter((row) => row.id === id))
}

/** B-OP-042: one SALES_ORDER and one CUSTOMER_ORDER reference per order (documentRefs is a list: no schema change). */
export function orderReferencesOf(orders: readonly PaperOrder[], dayOf: (value: Date) => BusinessDate): DocumentReference[] {
  return orders.flatMap((order): DocumentReference[] => [
    { kind: 'SALES_ORDER', number: order.number, date: dayOf(order.orderDate) },
    ...(order.customerRef ? [{ kind: 'CUSTOMER_ORDER' as const, number: order.customerRef }] : []),
  ])
}

/** B-OP-042: the payment terms the papers print: the first order's, and each other order's that differ (joined). */
export function paymentTermsOf(orders: readonly PaperOrder[]): string | null {
  if (orders.length <= 1) return orders[0]?.paymentTerms ?? null
  const terms = [...new Set(orders.flatMap((order) => (order.paymentTerms && order.paymentTerms.trim() !== '' ? [order.paymentTerms.trim()] : [])))]
  return terms.length > 0 ? terms.join('; ') : null
}

/** B-OP-042: where an order's lines go among a paper's lines: the first order's first (a large step per order). */
export const orderPlaceOf = (orders: readonly { readonly id: string }[], orderId: string | null | undefined): number => Math.max(0, orders.findIndex((order) => order.id === orderId)) * 1_000_000

/** The shipments that carry an order: made for it (its first order), or with a line of it. */
export const shipmentsOfOrderWhere = (salesOrderId: string): Prisma.ShipmentWhereInput => ({ OR: [{ salesOrderId }, { lines: { some: { salesOrderLine: { orderId: salesOrderId } } } }] })

/** The shipments that carry any of these orders. */
export const shipmentsOfOrdersWhere = (salesOrderIds: readonly string[]): Prisma.ShipmentWhereInput => ({ OR: [{ salesOrderId: { in: [...salesOrderIds] } }, { lines: { some: { salesOrderLine: { orderId: { in: [...salesOrderIds] } } } } }] })

// ---- the facts joinProblems reads -------------------------------------------------------------------------------------

const JOIN_ORDER_SELECT = { id: true, number: true, partyId: true, companyId: true, status: true, shipTo: true, currency: true, taxMode: true, incoterm: true, billTo: true } as const satisfies Prisma.SalesOrderSelect

export type JoinOrderRow = Prisma.SalesOrderGetPayload<{ select: typeof JOIN_ORDER_SELECT }>

export const joinOrderOf = (row: JoinOrderRow, siteIds?: readonly string[]): JoinOrder => ({ ...row, status: row.status as string, taxMode: row.taxMode as string, ...(siteIds ? { siteIds } : {}) })

/** The orders as joinProblems reads them (an id that is not an order is left out). */
export async function joinOrdersOf(db: Reader, salesOrderIds: readonly string[]): Promise<Map<string, JoinOrderRow>> {
  const ids = [...new Set(salesOrderIds)].filter(isUuid)
  if (ids.length === 0) return new Map()
  return new Map((await db.salesOrder.findMany({ where: { id: { in: ids } }, select: JOIN_ORDER_SELECT })).map((row) => [row.id, row]))
}

/** The shipment an order would join, as joinProblems reads it: its first order, its site's company, the customer's hold. */
export async function joinShipmentFacts(
  db: Reader,
  shipment: { readonly number: string | null; readonly status: ShipmentStatus; readonly siteId: string; readonly salesOrderId: string; readonly shipTo?: unknown },
): Promise<JoinShipment | null> {
  const first = (await joinOrdersOf(db, [shipment.salesOrderId])).get(shipment.salesOrderId)
  if (!first) return null
  const site = await db.site.findUnique({ where: { id: shipment.siteId }, select: { companyId: true } })
  const customerHold = await holdWordsAt(db, { partyId: first.partyId, companyId: first.companyId }, 'SHIPMENT')
  return joinShipmentOf(joinOrderOf(first), { number: shipment.number, status: shipment.status, siteId: shipment.siteId, siteCompanyId: site?.companyId ?? '', ...(shipment.shipTo === undefined ? {} : { shipTo: shipment.shipTo }), customerHold })
}

/** The words of joinProblems for each of these orders against the shipment (an order it does not find: none). */
export async function joinWordsOf(db: Reader, shipment: JoinShipment, salesOrderIds: readonly string[]): Promise<Map<string, JoinProblem[]>> {
  const orders = await joinOrdersOf(db, salesOrderIds)
  return new Map([...orders].map(([id, row]) => [id, joinProblems(shipment, joinOrderOf(row))]))
}

// ---- the event --------------------------------------------------------------------------------------------------------

/**
 * Inside a command that changed a shipment's lines: shipment.orders_changed when the orders it carries changed (before →
 * after), ADDED or REMOVED (a line of another order added, an order's last line removed). With one order per shipment it
 * never fires.
 */
export function ordersChanged(tools: CommandTools, shipment: Pick<ShipmentHeader, 'id' | 'number' | 'companyId' | 'siteId' | 'partyId'>, before: readonly string[], after: readonly string[]): void {
  const added = after.some((id) => !before.includes(id))
  const removed = before.some((id) => !after.includes(id))
  if (!added && !removed) return
  for (const change of [...(added ? ['ADDED' as const] : []), ...(removed ? ['REMOVED' as const] : [])]) {
    tools.emit({ type: 'shipment.orders_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, salesOrderIds: [...after], change, partyId: shipment.partyId /* B-SA-004 */ } })
  }
}

// ---- GET /shipping/shipments/:shipmentId/orders/candidates ------------------------------------------------------------

/** Orders that are over (nothing more ships for them): never offered. */
const OVER = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED'] as const

const MAX_CANDIDATES = 50

/**
 * shipping.view: the shipment's customer's other open orders, each with its verdict `joinable {allowed, why}` (joinProblems,
 * MULTI_ORDER_OFF until the switch). Only the shipment's own customer (by query and by the line FK), only orders the caller
 * may see; never another customer's order, also for a person who sees every customer.
 */
export async function shipmentOrderCandidates(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  // As shipments.ts officeShipment (not imported: it imports this file): out of the caller's scope, as an unknown id.
  const found = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_VIEW, found)
  const shipment = found!
  return caller.withClient(async (client) => {
    const on = await ordersOfShipment(client, shipment)
    const facts = await joinShipmentFacts(client, shipment)
    const rows = await client.salesOrder.findMany({
      where: { partyId: shipment.partyId, status: { notIn: [...OVER] }, id: { notIn: on } },
      select: { ...JOIN_ORDER_SELECT, customerRef: true },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
      take: MAX_CANDIDATES * 2,
    })
    const visible = rows.filter((row) => row.partyId === shipment.partyId && mayOn(context, SHIPPING_VIEW, { companyId: row.companyId, partyId: row.partyId })).slice(0, MAX_CANDIDATES)
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      orders: visible.map((row) => ({
        salesOrderId: row.id,
        number: row.number,
        customerRef: row.customerRef,
        status: row.status as string,
        joinable: facts ? joinVerdict(joinProblems(facts, joinOrderOf(row))) : { allowed: false, why: 'Sales order not found.' },
      })),
    }
  })
}

// ---- GET /shipping/shipments/joinable?salesOrderId= ---------------------------------------------------------------------

/**
 * shipping.view: the DRAFT shipments of the order's customer it is not on yet, each with its verdict `joinable {allowed,
 * why}`. An order the caller may not see (another customer's for a person limited to some) is answered as an unknown one.
 */
export async function joinableShipments(caller: CommandCaller, query: { readonly salesOrderId: string }) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = isUuid(query.salesOrderId) ? await client.salesOrder.findUnique({ where: { id: query.salesOrderId }, select: JOIN_ORDER_SELECT }) : null
    if (!order || !mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const rows = await client.shipment.findMany({
      where: { partyId: order.partyId, status: 'DRAFT', NOT: shipmentsOfOrderWhere(order.id) },
      select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, salesOrderId: true, shipTo: true },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
      take: MAX_CANDIDATES * 2,
    })
    const visible = rows.filter((row) => row.partyId === order.partyId && mayOn(context, SHIPPING_VIEW, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId })).slice(0, MAX_CANDIDATES)
    const shipments = []
    // One query after another: a scoped client's transaction has one connection.
    for (const row of visible) {
      const facts = await joinShipmentFacts(client, { number: row.number, status: row.status, siteId: row.siteId, salesOrderId: row.salesOrderId, shipTo: row.shipTo })
      shipments.push({ shipmentId: row.id, number: row.number, status: row.status, siteId: row.siteId, joinable: facts ? joinVerdict(joinProblems(facts, joinOrderOf(order))) : { allowed: false, why: 'Shipment not found.' } })
    }
    return { salesOrderId: order.id, number: order.number, shipments }
  })
}

import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import type { WhereClause } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { familyOf, leadDays, orderShippedOn, type LeadKind } from '@nexus/factory-domain/insights/kpis/lead-times'
import { dueOf } from '@nexus/factory-domain/insights/kpis/otif'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { numberOf, type DayFact, type Reader, type Source } from '../rows'

/**
 * The lead-times source (B-W2b-429; ANA-014; measures leadtimes.<kind>_days and leadtimes.<kind>_orders; rules factory-domain
 * insights/kpis/lead-times.ts): per day of the company's clock, the orders whose time ended that day and the sum of their days
 * — taken from a quote (quote to order), shipped complete (order to ship), started in production (order to start). One row
 * per measure and day at company level, zeros included. `readLeadOrders` is also the drill's read (kpis/drills/lead-times.ts).
 */

const CHUNK = 1000
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export interface LeadOrder {
  readonly kind: LeadKind
  readonly orderId: string
  readonly companyId: string
  readonly partyId: string
  readonly number: string
  readonly orderDate: BusinessDate
  readonly seasonId: string | null
  readonly priorityLevel: string
  /** Where the time starts and ends (the quote's first sending, the order date; the order date, the last shipment or the first start). */
  readonly fromDay: BusinessDate
  readonly toDay: BusinessDate
  readonly days: number
  readonly family: string | null
  readonly styleIds: readonly string[]
}

const ORDER_SELECT = { id: true, companyId: true, partyId: true, number: true, orderDate: true, seasonId: true, priorityLevel: true, quoteVersion: { select: { quoteId: true } } } as const satisfies Prisma.SalesOrderSelect
type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_SELECT }>

async function linesOf(db: Reader, orderIds: readonly string[]) {
  const out: { orderId: string; id: string; kind: string; quantity: number; closedShortQuantity: number | null; styleId: string; style: { productType: string } }[] = []
  for (let index = 0; index < orderIds.length; index += CHUNK) {
    out.push(...(await db.salesOrderLine.findMany({ where: { orderId: { in: orderIds.slice(index, index + CHUNK) }, kind: { not: 'FEE' } }, select: { orderId: true, id: true, kind: true, quantity: true, closedShortQuantity: true, styleId: true, style: { select: { productType: true } } } })))
  }
  const byOrder = new Map<string, typeof out>()
  for (const line of out) byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), line])
  return byOrder
}

/**
 * The orders whose time of one kind ended between two days on their company's clock, with their days. `where` is a reader's
 * own scope on the order (company and customer); `extra` the drill's filters on the order.
 */
export async function readLeadOrders(db: Reader, input: { readonly kind: LeadKind; readonly companyIds: readonly string[]; readonly from: BusinessDate; readonly to: BusinessDate; readonly timeZoneOf: (companyId: string) => string; readonly where?: WhereClause | undefined; readonly extra?: Prisma.SalesOrderWhereInput }): Promise<LeadOrder[]> {
  if (input.companyIds.length === 0) return []
  const scope: Prisma.SalesOrderWhereInput = { AND: [(input.where ?? {}) as Prisma.SalesOrderWhereInput, input.extra ?? {}, { companyId: { in: [...input.companyIds] }, status: { not: 'CANCELLED' } }] }
  // The widest instants of the span over the companies' clocks (each order is then cut on its own company's).
  const zones = [...new Set(input.companyIds.map(input.timeZoneOf))]
  const start = new Date(Math.min(...zones.map((zone) => businessDayRange(input.from, zone).start.getTime())))
  const end = new Date(Math.max(...zones.map((zone) => businessDayRange(input.to, zone).end.getTime())))
  const inSpan = (day: BusinessDate) => day >= input.from && day <= input.to
  const ended: { order: OrderRow; fromDay: BusinessDate; toDay: BusinessDate }[] = []

  if (input.kind === 'QUOTE_TO_ORDER') {
    const orders = await db.salesOrder.findMany({ where: { AND: [scope, { quoteVersionId: { not: null }, orderDate: { gte: new Date(`${input.from}T00:00:00.000Z`), lte: new Date(`${input.to}T00:00:00.000Z`) } }] }, select: ORDER_SELECT })
    const quoteIds = [...new Set(orders.flatMap((order) => (order.quoteVersion ? [order.quoteVersion.quoteId] : [])))]
    const firstSent = new Map<string, Date>()
    for (let index = 0; index < quoteIds.length; index += CHUNK) {
      for (const row of await db.quoteVersion.groupBy({ by: ['quoteId'], where: { quoteId: { in: quoteIds.slice(index, index + CHUNK) }, sentAt: { not: null } }, _min: { sentAt: true } })) if (row._min.sentAt) firstSent.set(row.quoteId, row._min.sentAt)
    }
    for (const order of orders) {
      const sent = order.quoteVersion ? firstSent.get(order.quoteVersion.quoteId) : undefined
      if (sent) ended.push({ order, fromDay: businessDate(sent, input.timeZoneOf(order.companyId)), toDay: dayOf(order.orderDate) })
    }
  } else if (input.kind === 'ORDER_TO_SHIP') {
    const shipments = await db.shipment.findMany({ where: { salesOrder: scope, status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { gte: start, lt: end } }, select: { salesOrderId: true }, distinct: ['salesOrderId'] })
    const orderIds = shipments.map((row) => row.salesOrderId)
    const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: ORDER_SELECT })
    const lines = await linesOf(db, orderIds)
    const shipped = new Map<string, { day: BusinessDate; quantity: number }[]>()
    const lineIds = [...lines.values()].flat().map((line) => line.id)
    for (let index = 0; index < lineIds.length; index += CHUNK) {
      for (const row of await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: lineIds.slice(index, index + CHUNK) }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { not: null } } }, select: { salesOrderLineId: true, quantity: true, shipment: { select: { shippedAt: true, companyId: true } } } })) {
        shipped.set(row.salesOrderLineId, [...(shipped.get(row.salesOrderLineId) ?? []), { day: businessDate(row.shipment.shippedAt!, input.timeZoneOf(row.shipment.companyId)), quantity: row.quantity }])
      }
    }
    for (const order of orders) {
      const day = orderShippedOn((lines.get(order.id) ?? []).map((line) => ({ ...line, shipped: shipped.get(line.id) ?? [] })))
      if (day && inSpan(day)) ended.push({ order, fromDay: dayOf(order.orderDate), toDay: day })
    }
  } else {
    // The work orders started in the span that make a line of an order in scope; then each order's first start of all.
    const started = await db.workOrderSize.findMany({ where: { salesOrderLineId: { not: null }, workOrder: { companyId: { in: [...input.companyIds] }, startedAt: { gte: start, lt: end } } }, select: { salesOrderLineId: true } })
    const lineIds = [...new Set(started.map((row) => row.salesOrderLineId!))]
    const orderIds = new Set<string>()
    for (let index = 0; index < lineIds.length; index += CHUNK) {
      for (const row of await db.salesOrderLine.findMany({ where: { id: { in: lineIds.slice(index, index + CHUNK) }, order: scope }, select: { orderId: true } })) orderIds.add(row.orderId)
    }
    const orders = orderIds.size === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...orderIds] } }, select: ORDER_SELECT })
    const firstStart = new Map<string, Date>()
    const ids = [...orderIds]
    for (let index = 0; index < ids.length; index += CHUNK) {
      const rows = await db.workOrderSize.findMany({ where: { salesOrderLine: { orderId: { in: ids.slice(index, index + CHUNK) } }, workOrder: { startedAt: { not: null } } }, select: { salesOrderLine: { select: { orderId: true } }, workOrder: { select: { startedAt: true } } } })
      for (const row of rows) {
        const orderId = row.salesOrderLine!.orderId
        const at = row.workOrder.startedAt!
        const before = firstStart.get(orderId)
        if (!before || at < before) firstStart.set(orderId, at)
      }
    }
    for (const order of orders) {
      const at = firstStart.get(order.id)
      if (!at) continue
      const day = businessDate(at, input.timeZoneOf(order.companyId))
      if (inSpan(day)) ended.push({ order, fromDay: dayOf(order.orderDate), toDay: day })
    }
  }

  const linesFor = await linesOf(db, ended.map((entry) => entry.order.id))
  return ended
    .map(({ order, fromDay, toDay }) => {
      const own = linesFor.get(order.id) ?? []
      return {
        kind: input.kind,
        orderId: order.id,
        companyId: order.companyId,
        partyId: order.partyId,
        number: order.number,
        orderDate: dayOf(order.orderDate),
        seasonId: order.seasonId,
        priorityLevel: order.priorityLevel,
        fromDay,
        toDay,
        days: leadDays(fromDay, toDay),
        family: familyOf(own.map((line) => ({ family: line.style.productType, pieces: dueOf(line) })), PRODUCT_TYPES),
        styleIds: [...new Set(own.map((line) => line.styleId))].sort(),
      }
    })
    .sort((a, b) => (a.toDay !== b.toDay ? (a.toDay < b.toDay ? 1 : -1) : a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
}

const MEASURES_OF: Record<LeadKind, readonly [string, string]> = {
  QUOTE_TO_ORDER: ['leadtimes.quote_to_order_days', 'leadtimes.quote_to_order_orders'],
  ORDER_TO_SHIP: ['leadtimes.order_to_ship_days', 'leadtimes.order_to_ship_orders'],
  ORDER_TO_START: ['leadtimes.order_to_start_days', 'leadtimes.order_to_start_orders'],
}

export const leadTimesSource: Source = async (db, { company, from, to, now, where }) => {
  const today = businessDate(now, company.timezone)
  const last = to < today ? to : today
  if (last < from) return { daily: [], hourly: [] }
  const daily: DayFact[] = []
  for (const kind of Object.keys(MEASURES_OF) as LeadKind[]) {
    const orders = await readLeadOrders(db, { kind, companyIds: [company.id], from, to: last, timeZoneOf: () => company.timezone, where })
    const sums = new Map<BusinessDate, { days: number; orders: number }>()
    for (const order of orders) {
      const day = sums.get(order.toDay) ?? { days: 0, orders: 0 }
      day.days += order.days
      day.orders += 1
      sums.set(order.toDay, day)
    }
    const [daysKey, ordersKey] = MEASURES_OF[kind]
    for (const day of eachDay(from, last)) {
      const sum = sums.get(day) ?? { days: 0, orders: 0 }
      daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: daysKey, number: numberOf(measureOf(daysKey)!, sum.days) })
      daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: ordersKey, number: numberOf(measureOf(ordersKey)!, sum.orders) })
    }
  }
  return { daily, hourly: [] }
}

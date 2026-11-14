import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import type { WhereClause } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { linePromises, otifByDay, type OtifLine } from '@nexus/factory-domain/insights/kpis/otif'
import type { StoredPromise } from '@nexus/factory-domain/planning/promise/rules'
import { numberOf, type DayFact, type Reader, type Source } from '../rows'

/**
 * The delivery source (B-W2b-429; ANA-013; measures orders.lines_due, orders.lines_shipped_on_time, orders.lines_due_current,
 * orders.lines_on_time_current; rules factory-domain insights/kpis/otif.ts): the company's garment order lines due on a day
 * on their first promise and on their promise now, and those shipped complete by it. One row per measure and day at company
 * level, zeros included. `readOtifLines` is also the drill's read (kpis/drills/otif.ts): the same lines, never a second rule.
 */

const CHUNK = 1000
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const span = (from: BusinessDate, to: BusinessDate) => ({ gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) })

export const OTIF_LINE_SELECT = {
  id: true,
  seq: true,
  kind: true,
  companyId: true,
  partyId: true,
  orderId: true,
  siteId: true,
  styleId: true,
  quantity: true,
  closedShortQuantity: true,
  promiseDate: true,
  sizes: { select: { size: true, quantity: true } },
  style: { select: { code: true, name: true, productType: true, sizes: true } },
  order: { select: { number: true, orderDate: true, promiseDate: true, originalPromiseDate: true, priorityLevel: true, seasonId: true } },
} as const satisfies Prisma.SalesOrderLineSelect

type LineRow = Prisma.SalesOrderLineGetPayload<{ select: typeof OTIF_LINE_SELECT }>

export interface OtifRecord extends OtifLine {
  readonly row: LineRow
}

/**
 * The garment lines of orders not cancelled that could be due between two days (a promise of theirs — typed on the line or
 * the order, first typed, or in the history — falls in the span), with their first and current promise and what left. A
 * reader's own scope (`where`, on the line's company and customer) and the drill's filters (`extra`) narrow them.
 */
export async function readOtifLines(db: Reader, input: { readonly companyIds: readonly string[]; readonly from: BusinessDate; readonly to: BusinessDate; readonly timeZoneOf: (companyId: string) => string; readonly where?: WhereClause | undefined; readonly extra?: Prisma.SalesOrderLineWhereInput }): Promise<OtifRecord[]> {
  if (input.companyIds.length === 0) return []
  const days = span(input.from, input.to)
  const lines = await db.salesOrderLine.findMany({
    where: {
      AND: [
        (input.where ?? {}) as Prisma.SalesOrderLineWhereInput,
        input.extra ?? {},
        { companyId: { in: [...input.companyIds] }, kind: { not: 'FEE' }, order: { status: { not: 'CANCELLED' } } },
        { OR: [{ promiseDate: days }, { promiseDate: null, order: { promiseDate: days } }, { order: { originalPromiseDate: days } }, { promises: { some: { promisedDate: days } } }] },
      ],
    },
    select: OTIF_LINE_SELECT,
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
  })
  const promises = new Map<string, StoredPromise[]>()
  const shipped = new Map<string, { day: BusinessDate; quantity: number }[]>()
  for (let index = 0; index < lines.length; index += CHUNK) {
    const ids = lines.slice(index, index + CHUNK).map((line) => line.id)
    for (const row of await db.promiseRecord.findMany({ where: { salesOrderLineId: { in: ids } }, select: { id: true, salesOrderLineId: true, size: true, promisedDate: true, kind: true, promisedAt: true }, orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }] })) {
      promises.set(row.salesOrderLineId, [...(promises.get(row.salesOrderLineId) ?? []), { id: row.id, size: row.size, promisedDate: dayOf(row.promisedDate), kind: row.kind, promisedAt: row.promisedAt }])
    }
    for (const row of await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: ids }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { not: null } } }, select: { salesOrderLineId: true, quantity: true, shipment: { select: { shippedAt: true, companyId: true } } } })) {
      shipped.set(row.salesOrderLineId, [...(shipped.get(row.salesOrderLineId) ?? []), { day: businessDate(row.shipment.shippedAt!, input.timeZoneOf(row.shipment.companyId)), quantity: row.quantity }])
    }
  }
  return lines.map((line) => {
    const order = line.style.sizes
    const sizes = line.kind === 'MADE_TO_MEASURE' ? [null] : [...line.sizes].filter((entry) => entry.quantity > 0).sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size)).map((entry) => entry.size)
    const typed = line.promiseDate ?? line.order.promiseDate
    const { first, current } = linePromises(sizes, promises.get(line.id) ?? [], typed ? dayOf(typed) : null, line.order.originalPromiseDate ? dayOf(line.order.originalPromiseDate) : null)
    return { row: line, kind: line.kind, quantity: line.quantity, closedShortQuantity: line.closedShortQuantity, firstPromise: first, currentPromise: current, shipped: shipped.get(line.id) ?? [] }
  })
}

export const deliverySource: Source = async (db, { company, from, to, now, where }) => {
  const today = businessDate(now, company.timezone)
  const last = to < today ? to : today
  if (last < from) return { daily: [], hourly: [] }
  const lines = await readOtifLines(db, { companyIds: [company.id], from, to: last, timeZoneOf: () => company.timezone, where })
  const counts = otifByDay(lines, today)
  const daily: DayFact[] = []
  const of = { 'orders.lines_due': 'due', 'orders.lines_shipped_on_time': 'onTime', 'orders.lines_due_current': 'dueCurrent', 'orders.lines_on_time_current': 'onTimeCurrent' } as const
  for (const day of eachDay(from, last)) {
    const sums = counts.get(day) ?? { due: 0, onTime: 0, dueCurrent: 0, onTimeCurrent: 0 }
    for (const [key, field] of Object.entries(of) as [keyof typeof of, (typeof of)[keyof typeof of]][]) {
      daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: key, number: numberOf(measureOf(key)!, sums[field]) })
    }
  }
  return { daily, hourly: [] }
}

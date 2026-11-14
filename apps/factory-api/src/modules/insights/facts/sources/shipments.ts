import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { numberOf, type DayFact, type Source } from '../rows'

/**
 * The shipments source (B-W2b-428; measures shipments.shipped, shipments.on_time): the company's shipments that left
 * (SHIPPED or DELIVERED) of orders with a promise date, by the day they left on the company's clock, and those that left
 * on or before that promise date — as Today's "Shipped on time" counted them (B-W2a-79). One row per measure and day at
 * company level, zeros included.
 */
export const shipmentsSource: Source = async (db, { company, from, to, now, where }) => {
  const today = businessDate(now, company.timezone)
  const last = to < today ? to : today
  if (last < from) return { daily: [], hourly: [] }
  const found = await db.shipment.findMany({
    where: {
      AND: [
        (where ?? {}) as Prisma.ShipmentWhereInput,
        {
          companyId: company.id,
          status: { in: ['SHIPPED', 'DELIVERED'] },
          shippedAt: { gte: businessDayRange(from, company.timezone).start, lt: businessDayRange(last, company.timezone).end },
          salesOrder: { promiseDate: { not: null } },
        },
      ],
    },
    select: { shippedAt: true, salesOrder: { select: { promiseDate: true } } },
  })
  const days = new Map(eachDay(from, last).map((day) => [day, { shipped: 0, onTime: 0 }]))
  for (const row of found) {
    if (!row.shippedAt || !row.salesOrder.promiseDate) continue
    const day = businessDate(row.shippedAt, company.timezone)
    const sums = days.get(day)
    if (!sums) continue
    sums.shipped += 1
    if (day <= row.salesOrder.promiseDate.toISOString().slice(0, 10)) sums.onTime += 1
  }
  const daily: DayFact[] = []
  for (const [day, sums] of days) {
    daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: 'shipments.shipped', number: numberOf(measureOf('shipments.shipped')!, sums.shipped) })
    daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: 'shipments.on_time', number: numberOf(measureOf('shipments.on_time')!, sums.onTime) })
  }
  return { daily, hourly: [] }
}

import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate } from '@nexus/factory-domain/core/time'
import { measureOf, measuresOfSource } from '@nexus/factory-domain/insights/kpis/measures'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { numberOf, type Collected, type DayFact, type Source } from '../rows'

/**
 * The orders source (B-W2b-428; measures orders.lines_in, orders.value, orders.value_costed, orders.margin,
 * orders.unconverted): the company's sales orders by their order date (the printed day), cancelled ones left out — as
 * Today's "Orders in this week" counted them (B-W2a-79). The value is the order's net amount; the costed value and the
 * margin at order are those of its lines with a cost at order (net − cost). An order in another currency counts in the
 * company's at the rate of its day (platform/currency's rate book); with no rate it is left out of the amounts and counted
 * in orders.unconverted. One row per measure and day at company level, zeros included (a day rebuilt says so).
 */

const CHUNK = 1000
const dayOfDate = (value: Date) => value.toISOString().slice(0, 10)

export const ordersSource: Source = async (db, { company, from, to, now, rates, where }) => {
  const today = businessDate(now, company.timezone)
  const last = to < today ? to : today
  if (last < from) return { daily: [], hourly: [] }
  const orders = await db.salesOrder.findMany({
    where: { AND: [(where ?? {}) as Prisma.SalesOrderWhereInput, { companyId: company.id, status: { not: 'CANCELLED' }, orderDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${last}T00:00:00Z`) } }] },
    select: { id: true, orderDate: true, currency: true, netAmount: true },
  })
  const lines: { orderId: string; netAmount: number; costAmount: number | null }[] = []
  for (let index = 0; index < orders.length; index += CHUNK) {
    lines.push(...(await db.salesOrderLine.findMany({ where: { orderId: { in: orders.slice(index, index + CHUNK).map((order) => order.id) } }, select: { orderId: true, netAmount: true, costAmount: true } })))
  }
  const linesOf = new Map<string, typeof lines>()
  for (const line of lines) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line])

  const zero = () => ({ lines: 0, value: 0, costed: 0, margin: 0, unconverted: 0 })
  const days = new Map(eachDay(from, last).map((day) => [day, zero()]))
  for (const order of orders) {
    const day = dayOfDate(order.orderDate)
    const sums = days.get(day)
    if (!sums) continue
    const own = linesOf.get(order.id) ?? []
    sums.lines += own.length
    const costed = own.filter((line) => line.costAmount !== null)
    const amounts = { value: order.netAmount, costed: costed.reduce((total, line) => total + line.netAmount, 0), margin: costed.reduce((total, line) => total + line.netAmount - line.costAmount!, 0) }
    if (order.currency === company.currency) {
      sums.value += amounts.value
      sums.costed += amounts.costed
      sums.margin += amounts.margin
      continue
    }
    const rate = rates.rate(company.currency, order.currency, day)
    if (!rate) {
      sums.unconverted += 1
      continue
    }
    sums.value += convertMinor(amounts.value, order.currency, company.currency, rate)
    sums.costed += convertMinor(amounts.costed, order.currency, company.currency, rate)
    sums.margin += convertMinor(amounts.margin, order.currency, company.currency, rate)
  }

  const daily: DayFact[] = []
  const of = { 'orders.lines_in': 'lines', 'orders.value': 'value', 'orders.value_costed': 'costed', 'orders.margin': 'margin', 'orders.unconverted': 'unconverted' } as const
  for (const [day, sums] of days) {
    for (const measure of measuresOfSource('ORDERS')) {
      daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: measure.key, number: numberOf(measureOf(measure.key)!, sums[of[measure.key as keyof typeof of]]) })
    }
  }
  return { daily, hourly: [] } satisfies Collected
}

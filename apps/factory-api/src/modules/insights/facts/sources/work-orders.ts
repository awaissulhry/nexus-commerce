import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { ageDays, endedAt, inWorkAt } from '@nexus/factory-domain/insights/kpis/wip'
import { numberOf, type DayFact, type Source } from '../rows'

/**
 * The work-orders source (B-W2b-429; ANA-015; measures wip.pieces and wip.piece_days, BALANCE; rules factory-domain
 * insights/kpis/wip.ts): at the end of each day on the site's clock, the garments of the site's work orders in work (released,
 * not yet completed, closed or cancelled) and their garments × days since release — per site and per line of the site. A
 * site and each of its lines keep a row every day, zeros included, so the balance of a period is always its last day's
 * (a line with nothing in work reads 0, never an older day). A work order marked done without the moment it was done
 * cannot be placed in time and is left out.
 */

const DONE = ['COMPLETED', 'CLOSED', 'CANCELLED'] as const
const DONE_SET: ReadonlySet<string> = new Set(DONE)

export const workOrdersSource: Source = async (db, { company, from, to, now }) => {
  const daily: DayFact[] = []
  const pieces = measureOf('wip.pieces')!
  const pieceDays = measureOf('wip.piece_days')!
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    const start = businessDayRange(from, site.timezone).start
    const orders = await db.workOrder.findMany({
      where: {
        siteId: site.id,
        releasedAt: { lt: businessDayRange(last, site.timezone).end },
        OR: [{ status: { notIn: [...DONE] } }, { completedAt: { gte: start } }, { closedAt: { gte: start } }, { cancelledAt: { gte: start } }],
      },
      select: { id: true, status: true, lineId: true, releasedAt: true, completedAt: true, closedAt: true, cancelledAt: true, sizes: { select: { quantity: true } } },
    })
    const lines = await db.line.findMany({ where: { siteId: site.id }, select: { id: true }, orderBy: { id: 'asc' } })
    const placed = orders.filter((order) => !(DONE_SET.has(order.status) && endedAt(order) === null))
    for (const day of eachDay(from, last)) {
      const end = businessDayRange(day, site.timezone).end
      const sums = new Map<string | null, { pieces: number; days: number }>([[null, { pieces: 0, days: 0 }], ...lines.map((line) => [line.id, { pieces: 0, days: 0 }] as const)])
      for (const order of placed) {
        if (!inWorkAt(order, end)) continue
        const garments = order.sizes.reduce((total, size) => total + size.quantity, 0)
        const age = ageDays(order.releasedAt!, day, site.timezone)
        for (const key of order.lineId && sums.has(order.lineId) ? [null, order.lineId] : [null]) {
          const sum = sums.get(key)!
          sum.pieces += garments
          sum.days += garments * age
        }
      }
      for (const [lineId, sum] of sums) {
        daily.push({ companyId: company.id, siteId: site.id, lineId, day, measureKey: pieces.key, number: numberOf(pieces, sum.pieces) })
        daily.push({ companyId: company.id, siteId: site.id, lineId, day, measureKey: pieceDays.key, number: numberOf(pieceDays, sum.days) })
      }
    }
  }
  return { daily, hourly: [] }
}

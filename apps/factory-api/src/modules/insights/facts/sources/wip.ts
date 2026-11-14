import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { numberOf, type DayFact, type Source } from '../rows'

/**
 * The work-in-progress source (B-W2b-428; measure wip.cost, a BALANCE): at the end of each day on the site's clock, the
 * balance of the site's work-order cost ledger (WorkOrderCostEntry, append-only: material, labour, subcontract, overhead and
 * scrap put on the work orders; completions, variances and closes taken off) — what sits on the work orders at cost, in the
 * company's currency (the ledger's). Rebuilt from the ledger alone: one sum before the first day, then the day's entries.
 * One row per site and day, zeros included.
 */
export const wipSource: Source = async (db, { company, from, to, now }) => {
  const daily: DayFact[] = []
  const measure = measureOf('wip.cost')!
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    const start = businessDayRange(from, site.timezone).start
    const before = await db.workOrderCostEntry.aggregate({ where: { siteId: site.id, occurredAt: { lt: start } }, _sum: { amount: true } })
    const entries = await db.workOrderCostEntry.findMany({ where: { siteId: site.id, occurredAt: { gte: start, lt: businessDayRange(last, site.timezone).end } }, select: { occurredAt: true, amount: true } })
    const ofDay = new Map<string, number>()
    for (const entry of entries) {
      const day = businessDate(entry.occurredAt, site.timezone)
      ofDay.set(day, (ofDay.get(day) ?? 0) + entry.amount)
    }
    let balance = before._sum.amount ?? 0
    for (const day of eachDay(from, last)) {
      balance += ofDay.get(day) ?? 0
      daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: measure.key, number: numberOf(measure, balance) })
    }
  }
  return { daily, hourly: [] }
}

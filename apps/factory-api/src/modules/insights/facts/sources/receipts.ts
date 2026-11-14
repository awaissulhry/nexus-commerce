import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { numberOf, type DayFact, type Source } from '../rows'

/**
 * The receipts source (B-W2b-428; measure receipts.lines): the lines of the goods receipts POSTED at each site, by the day
 * they were posted on the site's clock (a receipt reversed since no longer counts: what stands now). One row per site and
 * day, zeros included.
 */
export const receiptsSource: Source = async (db, { company, from, to, now }) => {
  const daily: DayFact[] = []
  const measure = measureOf('receipts.lines')!
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    const receipts = await db.goodsReceipt.findMany({
      where: { siteId: site.id, status: 'POSTED', postedAt: { gte: businessDayRange(from, site.timezone).start, lt: businessDayRange(last, site.timezone).end } },
      select: { postedAt: true, _count: { select: { lines: true } } },
    })
    const ofDay = new Map<string, number>()
    for (const receipt of receipts) {
      if (!receipt.postedAt) continue
      const day = businessDate(receipt.postedAt, site.timezone)
      ofDay.set(day, (ofDay.get(day) ?? 0) + receipt._count.lines)
    }
    for (const day of eachDay(from, last)) daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: measure.key, number: numberOf(measure, ofDay.get(day) ?? 0) })
  }
  return { daily, hourly: [] }
}
